#!/usr/bin/env bash
# The VM1 half of in-dashboard updates: a root systemd oneshot that reads the
# version an administrator approved and moves this machine to it.
#
# The container never executes anything on a host. It records an approved target
# in PostgreSQL; this agent pulls that target and acts on it. VM2 has worked this
# way since enrolment -- three root timers polling VM1 -- so this extends an
# existing shape rather than inventing one. The host is already the trusted
# party here: it has root and it owns the Docker socket, which is why the target
# is read straight out of the database instead of through a new authenticated
# endpoint and a new listener.
#
# ---------------------------------------------------------------------------
# Where this runs from, and why it is not in the install tree
# ---------------------------------------------------------------------------
# /usr/local/lib/orcasynapse/, installed there by scripts/install-orcasynapse.sh
# -- the same place the VM2 installer keeps its client programs. This file is
# executing while the tree it upgrades is renamed out from under it, so a copy
# inside ${ORCASYNAPSE_INSTALL_DIR} would be unlinked mid-run. Nothing here
# sources a file from that tree, and nothing here uses it as a working
# directory, for the same reason.
#
# The upgrade itself is launched in a transient systemd scope where systemd is
# available, so it lives in its own cgroup rather than in this unit's. Stopping
# or restarting orcasynapse-update.service then cannot kill an upgrade that is
# halfway through replacing the deployment. The installer is careful never to
# restart this service for the same reason, but "careful" is not a guarantee and
# an operator with a shell is not bound by it.
#
# ---------------------------------------------------------------------------
# What it leaves behind
# ---------------------------------------------------------------------------
# Two copies of one record. The in-tree copy under .local/state is the one a
# dashboard would read; the copy under ${ORCASYNAPSE_UPDATE_STATE_DIR} is
# outside the tree and therefore survives a source swap, a rollback, and the
# deletion of the failed tree. When the update goes wrong the dashboard is
# exactly what is missing, so the durable copy is the one that matters.
#
# The record distinguishes "the API is expected to be down right now" from "the
# API stopped answering and nobody knows why": a run in the `upgrading` phase
# carries the moment its unavailability budget expires. A panel reading a phase
# of `upgrading` before that moment is looking at a restart, not a stall.
#
# Needs root, Docker, and an installation that has completed at least once.
set -Eeuo pipefail

umask 077

ORCASYNAPSE_INSTALL_DIR="${ORCASYNAPSE_INSTALL_DIR:-/opt/orcasynapse}"
ORCASYNAPSE_GITHUB_REPOSITORY="${ORCASYNAPSE_GITHUB_REPOSITORY:-multichainerz/AI}"
ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HTTP_PORT:-8080}"
ORCASYNAPSE_UPDATE_STATE_DIR="${ORCASYNAPSE_UPDATE_STATE_DIR:-/var/lib/orcasynapse-update}"
# The bounded wait of trap 3. A build plus a migration plus a cold start is
# minutes on a small VM, and a gate that fires early would roll back a healthy
# upgrade -- which is a worse failure than the one it is guarding against.
ORCASYNAPSE_UPDATE_READY_TIMEOUT="${ORCASYNAPSE_UPDATE_READY_TIMEOUT:-900}"
# How long the API may legitimately be unreachable for, start to finish: the
# image build, the migration, the cold start, and the readiness wait above. This
# is not a timeout -- nothing acts on it -- it is the number written into the
# record so that a reader can tell a restart from a stall. See trap 2.
ORCASYNAPSE_UPDATE_UNAVAILABLE_BUDGET="${ORCASYNAPSE_UPDATE_UNAVAILABLE_BUDGET:-2700}"
# Where install.sh is fetched from. Overridable so the test harness can exercise
# this exact download code path against a staged tree over file:// rather than
# stubbing it out; the systemd unit sets no such variable and this script is
# root-only, so it is a seam for the tests and not a channel into production.
ORCASYNAPSE_UPDATE_SOURCE_BASE="${ORCASYNAPSE_UPDATE_SOURCE_BASE:-https://raw.githubusercontent.com}"
# How much of the installer's log is kept for the dashboard. The tail, not the
# head: a run that failed says why at the end, and an operator reading this has
# already been told the phase.
ORCASYNAPSE_UPDATE_LOG_BYTES="${ORCASYNAPSE_UPDATE_LOG_BYTES:-131072}"

AGENT_WORK=""
AGENT_PHASE="idle"
AGENT_DETAIL="nothing to do"
AGENT_TARGET_VERSION=""
AGENT_TARGET_COMMIT=""
AGENT_TARGET_REVISION="0"
AGENT_INSTALLED_VERSION=""
AGENT_INSTALLED_COMMIT=""
AGENT_DATABASE_USER=""
AGENT_DATABASE_NAME=""
AGENT_STARTED_AT=""
AGENT_UNAVAILABLE_UNTIL=""
AGENT_ROLLBACK=""
# Empty on an idle tick. Set once, at the moment this agent decides to upgrade,
# so every phase of one attempt updates one row instead of appending a new one.
AGENT_RUN_ID=""
AGENT_LOG_TRUNCATED="false"

log() { printf 'orcasynapse-update: %s\n' "$1" >&2; }

cleanup() {
  # Read first, before anything below overwrites it. The same mistake was made
  # and fixed twice already in this repository's installers.
  local status=$?
  local interrupted_phase="${AGENT_PHASE}"
  [[ -z "${AGENT_WORK}" || ! -d "${AGENT_WORK}" ]] || rm -rf -- "${AGENT_WORK}"
  # An abnormal exit must not leave the last record saying "upgrading". That is
  # the state a dashboard reads as "still going", and it is the one state this
  # agent must never leave behind by accident: a machine that is actually stuck
  # would be reported as one that is merely restarting, indefinitely.
  if (( status != 0 )) && [[ "${interrupted_phase}" == "upgrading" || "${interrupted_phase}" == "verifying" ]]; then
    AGENT_PHASE="failed"
    AGENT_DETAIL="the update agent exited ${status} during the ${interrupted_phase} phase"
    write_record || true
  fi
}
trap cleanup EXIT

fail() {
  log "FAILED: $1"
  AGENT_PHASE="failed"
  AGENT_DETAIL="$1"
  write_record || true
  exit 1
}

json_escape() {
  local value="${1//\\/\\\\}"
  printf '%s' "${value//\"/\\\"}"
}

# Written to two places on purpose. See the header: the in-tree copy is the one
# a dashboard could read, and the out-of-tree copy is the one that still exists
# after the tree it described was replaced or rolled back.
write_record() {
  local now body
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  body="$(printf '{"phase":"%s","detail":"%s","targetVersion":"%s","targetCommit":"%s","installedVersion":"%s","installedCommit":"%s","startedAt":"%s","apiUnavailableUntil":"%s","rollback":"%s","runId":"%s","logTruncated":%s,"recordedAt":"%s"}' \
    "$(json_escape "${AGENT_PHASE}")" "$(json_escape "${AGENT_DETAIL}")" \
    "$(json_escape "${AGENT_TARGET_VERSION}")" "$(json_escape "${AGENT_TARGET_COMMIT}")" \
    "$(json_escape "${AGENT_INSTALLED_VERSION}")" "$(json_escape "${AGENT_INSTALLED_COMMIT}")" \
    "$(json_escape "${AGENT_STARTED_AT}")" "$(json_escape "${AGENT_UNAVAILABLE_UNTIL}")" \
    "$(json_escape "${AGENT_ROLLBACK}")" "$(json_escape "${AGENT_RUN_ID}")" \
    "${AGENT_LOG_TRUNCATED}" "${now}")"
  install -d -m 0700 "${ORCASYNAPSE_UPDATE_STATE_DIR}"
  printf '%s\n' "${body}" > "${ORCASYNAPSE_UPDATE_STATE_DIR}/last-run.json"
  chmod 0600 "${ORCASYNAPSE_UPDATE_STATE_DIR}/last-run.json"
  if [[ -d "${ORCASYNAPSE_INSTALL_DIR}" ]]; then
    install -d -m 0700 "${ORCASYNAPSE_INSTALL_DIR}/.local/state"
    printf '%s\n' "${body}" > "${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-update-agent.json"
    chmod 0600 "${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-update-agent.json"
  fi
  # The files above are the durable record and are written first, unconditionally.
  # PostgreSQL is where a dashboard can actually see it, and it is best-effort by
  # necessity: for most of an upgrade the database is being stopped, migrated and
  # started again, so a failed write here is the expected case and not an error.
  # The phases that matter are the terminal ones, and by then the stack is up --
  # or it is not, and no record written anywhere would be reachable either.
  publish_record "${body}" || true
}

# The installer's log, copied out of the tree before that tree can be replaced.
#
# UI_LOG_FILE and not stdout. install-orcasynapse.sh prints the Offline recovery
# key through ui_panel_kv, which is a bare printf that never reaches UI_LOG_FILE
# -- "printed, never logged", stated at the line that prints it. Capturing the
# installer's terminal output instead of its log would put that key in the
# database and then on a web page, so this reads the channel the installer
# already keeps free of secrets.
capture_installer_log() {
  local candidate size
  local marker="${AGENT_WORK}/log-since"
  local snapshot="${ORCASYNAPSE_UPDATE_STATE_DIR}/last-install.log"
  local combined="${AGENT_WORK}/install-log-combined"
  : > "${combined}" || return 0
  # Every log this attempt produced, not the newest one.
  #
  # A failed upgrade writes two: install.sh runs the new tree's installer, that
  # one fails, and install.sh then restores the old tree and runs *its* installer
  # to come back up. The newest of those describes the recovery, so an agent that
  # took it would answer "what happened" with the log of the thing that worked.
  #
  # Glob order is chronological without a sort: install.sh names its log
  # install-<UTC timestamp>.log, so the shell's lexical ordering is time order.
  for candidate in "${ORCASYNAPSE_INSTALL_DIR}"/.local/state/install-*.log; do
    [[ -f "${candidate}" && -r "${candidate}" ]] || continue
    [[ ! -e "${marker}" || "${candidate}" -nt "${marker}" ]] || continue
    printf -- '--- %s
' "${candidate##*/}" >> "${combined}"
    cat -- "${candidate}" >> "${combined}" || true
  done
  [[ -s "${combined}" ]] || return 0
  install -d -m 0700 "${ORCASYNAPSE_UPDATE_STATE_DIR}"
  size="$(wc -c < "${combined}" 2>/dev/null)" || size=0
  [[ "${size}" =~ ^[0-9]+$ ]] || size=0
  if (( size > ORCASYNAPSE_UPDATE_LOG_BYTES )); then
    AGENT_LOG_TRUNCATED="true"
    tail -c "${ORCASYNAPSE_UPDATE_LOG_BYTES}" -- "${combined}" > "${snapshot}" || return 0
  else
    AGENT_LOG_TRUNCATED="false"
    cp -- "${combined}" "${snapshot}" || return 0
  fi
  chmod 0600 "${snapshot}"
}

# Both rows, from one JSON document, base64-encoded.
#
# base64 is [A-Za-z0-9+/=] and nothing else, so it passes through a single-quoted
# SQL literal with no escaping and no way for a detail string, a version, or a
# log full of quotes and newlines to end the literal. PostgreSQL decodes it back
# on the other side. The alternative -- interpolating those values into SQL -- is
# the shape this program must not have, since some of them come from a database
# row and a file an installer wrote.
publish_record() {
  local body="$1" record_b64 log_b64="" sql
  local snapshot="${ORCASYNAPSE_UPDATE_STATE_DIR}/last-install.log"
  [[ -n "${AGENT_DATABASE_USER}" && -n "${AGENT_DATABASE_NAME}" ]] || return 0
  record_b64="$(printf '%s' "${body}" | base64 -w0)" || return 0
  # No log yet on an in-flight phase; decode('', 'base64') is the empty string,
  # which nullif turns into NULL and the upsert below leaves alone.
  [[ -r "${snapshot}" ]] && log_b64="$(base64 -w0 -- "${snapshot}")"

  # Unquoted heredocs: only $ and backticks are special in one, so every quote
  # the SQL needs -- double for the camel-cased identifiers, single for the
  # literals -- is written as itself. There is no $ in the SQL other than the
  # substitutions.
  sql="$(cat <<SQL
with r as (select convert_from(decode('${record_b64}', 'base64'), 'UTF8')::jsonb as d)
insert into "PlatformUpdateAgent" ("id", "phase", "detail", "installedVersion", "installedCommit", "currentRunId", "checkedAt", "updatedAt")
select 'global', r.d->>'phase', r.d->>'detail',
       nullif(r.d->>'installedVersion', ''), nullif(r.d->>'installedCommit', ''),
       nullif(r.d->>'runId', '')::uuid, now(), now()
  from r
on conflict ("id") do update set
  "phase" = excluded."phase", "detail" = excluded."detail",
  "installedVersion" = excluded."installedVersion", "installedCommit" = excluded."installedCommit",
  "currentRunId" = excluded."currentRunId", "checkedAt" = excluded."checkedAt",
  "updatedAt" = excluded."updatedAt"
SQL
  )"
  psql_exec "${sql}" || return 0

  # An idle tick has no run to record, and must not invent one.
  [[ -n "${AGENT_RUN_ID}" ]] || return 0
  sql="$(cat <<SQL
with r as (select convert_from(decode('${record_b64}', 'base64'), 'UTF8')::jsonb as d)
insert into "PlatformUpdateRun" ("id", "phase", "detail", "targetVersion", "targetCommit", "installedVersion", "installedCommit", "rollback", "log", "logTruncated", "startedAt", "apiUnavailableUntil", "completedAt", "recordedAt", "updatedAt")
select (r.d->>'runId')::uuid, r.d->>'phase', r.d->>'detail',
       nullif(r.d->>'targetVersion', ''), nullif(r.d->>'targetCommit', ''),
       nullif(r.d->>'installedVersion', ''), nullif(r.d->>'installedCommit', ''),
       nullif(r.d->>'rollback', ''),
       nullif(convert_from(decode('${log_b64}', 'base64'), 'UTF8'), ''),
       coalesce((r.d->>'logTruncated')::boolean, false),
       coalesce(nullif(r.d->>'startedAt', '')::timestamptz, now()),
       nullif(r.d->>'apiUnavailableUntil', '')::timestamptz,
       case when r.d->>'phase' in ('healthy', 'rolled-back', 'failed') then now() end,
       now(), now()
  from r
on conflict ("id") do update set
  "phase" = excluded."phase", "detail" = excluded."detail",
  "targetVersion" = excluded."targetVersion", "targetCommit" = excluded."targetCommit",
  "installedVersion" = excluded."installedVersion", "installedCommit" = excluded."installedCommit",
  "rollback" = excluded."rollback",
  "log" = coalesce(excluded."log", "PlatformUpdateRun"."log"),
  "logTruncated" = case when excluded."log" is not null then excluded."logTruncated" else "PlatformUpdateRun"."logTruncated" end,
  "apiUnavailableUntil" = excluded."apiUnavailableUntil",
  "completedAt" = coalesce(excluded."completedAt", "PlatformUpdateRun"."completedAt"),
  "recordedAt" = excluded."recordedAt", "updatedAt" = excluded."updatedAt"
SQL
  )"
  psql_exec "${sql}" || return 0
}

set_phase() {
  AGENT_PHASE="$1"
  AGENT_DETAIL="$2"
  log "${AGENT_PHASE}: ${AGENT_DETAIL}"
  write_record
}

# A deliberate second copy of install.sh's parser rather than a shared library.
# This program runs from outside the install tree precisely because that tree is
# being renamed while it works; sourcing scripts/lib/* from it would reintroduce
# the dependency the location exists to remove.
#
# The password in the URL is not parsed. Passing it as `docker compose exec -e
# PGPASSWORD=` would publish the database password to every `ps` on the host for
# the length of the query. The container already holds its own copy at
# /run/secrets/postgres_password, which is where every query below reads it.
database_identity() {
  local secret="${ORCASYNAPSE_INSTALL_DIR}/.local/secrets/orcasynapse_database_url"
  local url remainder authority user database
  [[ -s "${secret}" ]] || return 1
  url="$(<"${secret}")"
  url="${url//[[:space:]]/}"
  [[ "${url}" == *"://"* ]] || return 1
  remainder="${url#*://}"
  authority="${remainder##*@}"
  user="${remainder%%@*}"
  user="${user%%:*}"
  [[ "${authority}" == */* ]] || return 1
  database="${authority#*/}"
  database="${database%%\?*}"
  [[ "${user}" =~ ^[A-Za-z0-9_-]+$ && "${database}" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  printf '%s %s' "${user}" "${database}"
}

psql_value() {
  local out=""
  out="$(docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
    sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --username="$1" --dbname="$2" --no-password -tAc "$3"' \
    orcasynapse-update-agent "${AGENT_DATABASE_USER}" "${AGENT_DATABASE_NAME}" "$1" \
    </dev/null 2>/dev/null)" || return 1
  printf '%s' "${out//[$'\r\n']/}"
}

# A statement rather than a value, and it is allowed to fail.
#
# ON_ERROR_STOP so a rejected statement is a non-zero exit rather than a message
# on a stream nothing reads. Output is discarded and the caller ignores the
# status on purpose: this only ever writes the record of what the agent is
# doing, and an agent that aborted an upgrade because it could not describe
# itself would have turned a reporting problem into an outage.
psql_exec() {
  docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
    sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --username="$1" --dbname="$2" --no-password -v ON_ERROR_STOP=1 -qAtc "$3"' \
    orcasynapse-update-agent "${AGENT_DATABASE_USER}" "${AGENT_DATABASE_NAME}" "$1" \
    </dev/null >/dev/null 2>&1
}

# No `sed … | head -n 1` in any of these, which is what the first draft used and
# what the agent test caught: head exits at the first line, sed dies on the
# broken pipe, and under `set -o pipefail` a *successful* read then reports
# failure -- which under errexit killed the agent at the exact moment it was
# recording why an upgrade had been rolled back. The first line is taken with a
# parameter expansion instead, where nothing can be signalled.
first_line() {
  printf '%s' "${1%%$'\n'*}"
}

installed_version() {
  local receipt="${ORCASYNAPSE_INSTALL_DIR}/.local/state/install-complete.json"
  local value=""
  [[ -r "${receipt}" ]] || { printf ''; return 0; }
  value="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "${receipt}")" || value=""
  first_line "${value}"
}

installed_commit() {
  local marker="${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit"
  [[ -r "${marker}" ]] || { printf ''; return 0; }
  local value
  value="$(<"${marker}")"
  printf '%s' "${value//[[:space:]]/}"
}

# The approved target, straight out of the singleton row increment 2 added.
# Identifiers are quoted because PostgreSQL folds unquoted ones to lower case and
# the table and its columns are camel-cased.
read_release_target() {
  local raw rest
  raw="$(psql_value 'select coalesce("desiredVersion", '"''"') || '"'|'"' || coalesce("desiredCommit", '"''"') || '"'|'"' || "revision" from "PlatformReleaseTarget" where "id" = '"'"'global'"'"'')" \
    || return 1
  AGENT_TARGET_VERSION="${raw%%|*}"
  rest="${raw#*|}"
  AGENT_TARGET_COMMIT="${rest%%|*}"
  AGENT_TARGET_REVISION="${rest##*|}"
  [[ "${AGENT_TARGET_REVISION}" =~ ^[0-9]+$ ]] || AGENT_TARGET_REVISION="0"
  return 0
}

# A target that has already been tried and rolled back is not tried again.
#
# Without this the timer is a loop: every ten minutes the agent would re-read the
# same approved commit, upgrade to it, fail, restore the database from the dump,
# and come back to do it again -- so the rollback, which exists to protect the
# data, would become the thing repeatedly overwriting it. A machine that ends on
# a working version has to *stay* there.
#
# Keyed on the target's revision as well as its commit, so re-approving the same
# release in the dashboard is a deliberate retry and clears the block, while the
# unchanged row does not. The file lives outside the install tree with the rest
# of the durable state, because the failure it records is one that may have
# replaced that tree.
blocked_target() {
  local marker="${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target"
  [[ -r "${marker}" ]] || return 1
  [[ "$(<"${marker}")" == "${AGENT_TARGET_COMMIT} ${AGENT_TARGET_REVISION}" ]]
}

block_target() {
  install -d -m 0700 "${ORCASYNAPSE_UPDATE_STATE_DIR}"
  printf '%s %s' "${AGENT_TARGET_COMMIT}" "${AGENT_TARGET_REVISION}" \
    > "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target"
  chmod 0600 "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target"
}

unblock_target() {
  rm -f -- "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target"
}

# The health gate. The control plane's own readiness endpoint on the loopback
# port the installer publishes -- the same check scripts/install-orcasynapse.sh
# waits on, so a green gate here means the same thing it means there.
# Copied rather than sourced: this file must not depend on the install tree,
# which is renamed out from under it during an upgrade. Docker publishes
# ${bind}:${port}:8080, so loopback is the wrong probe when the bind is a
# LAN unicast address.
update_readyz_url() {
  local bind="${ORCASYNAPSE_HTTP_BIND:-}"
  if [[ -z "${bind}" && -f "${ORCASYNAPSE_INSTALL_DIR}/.local/state/http-bind" ]]; then
    bind="$(<"${ORCASYNAPSE_INSTALL_DIR}/.local/state/http-bind")"
    bind="${bind//[$'\r\n\t ']/}"
  fi
  local host
  case "${bind}" in
    0.0.0.0|"") host="127.0.0.1" ;;
    *) host="${bind}" ;;
  esac
  printf 'http://%s:%s/readyz' "${host}" "${ORCASYNAPSE_HTTP_PORT:-8080}"
}

wait_for_ready() {
  # Two statements, not one `local budget=… deadline=$((… + budget))`. In a
  # single `local` the names are created before the initialisers are evaluated,
  # so the arithmetic read an unset `budget` and `set -u` killed the agent at
  # the exact moment it was about to decide whether the machine had come back.
  local budget="$1"
  local deadline=$((SECONDS + budget))
  until curl --fail --silent --show-error --max-time 10 \
      "$(update_readyz_url)" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep 5
  done
  return 0
}

# install.sh at the approved commit, never from a moving ref.
#
# The commit is what is fetched rather than the tag it was approved as: a tag can
# be re-pointed between approval and this run, and increment 2 resolved and
# stored the commit at approval time precisely so that an automated path never
# has to trust the tag again. The database constraint keeps the two travelling
# together, so this is the approved tag -- pinned.
download_installer() {
  local commit="$1" target="$2"
  [[ "${commit}" =~ ^[a-f0-9]{40}$ ]] || return 1
  curl --fail --silent --show-error --location --max-time 120 \
    --output "${target}" \
    "${ORCASYNAPSE_UPDATE_SOURCE_BASE}/${ORCASYNAPSE_GITHUB_REPOSITORY}/${commit}/install.sh" \
    || return 1
  # Not a signature -- the transport is HTTPS to a commit-addressed path, and the
  # installer verifies its own archive. This is the cheaper question: did a proxy
  # or an error page land here instead of the installer?
  #
  # No `head … | grep -q`: grep exits at its match, head dies on the broken pipe,
  # and under pipefail a *matching* shebang would be reported as a rejection.
  local shebang=""
  shebang="$(head -n 1 -- "${target}")" || return 1
  [[ "${shebang}" == '#!'*bash* ]] || return 1
  grep -q 'ORCASYNAPSE_INSTALLER_LIBRARY_ONLY' -- "${target}" || return 1
}

# Trap 1. A transient scope is a unit of its own, so the upgrade is no longer in
# the cgroup systemd kills when orcasynapse-update.service is stopped or
# restarted -- including by the very installer this launches, which reinstalls
# these units as it goes. Synchronous either way: the exit status of the upgrade
# is the thing the health gate and the rollback both hang off.
#
# Probed once with a command that does nothing, rather than inferred from the
# presence of /run/systemd/system. The failure this avoids is the ugly one: a
# systemd-run that cannot reach the bus fails at launch, and without the probe
# that failure would be indistinguishable from an upgrade that ran and failed --
# so the agent would report a rollback for an upgrade that never started.
AGENT_CAN_DETACH=""
detach_available() {
  if [[ -z "${AGENT_CAN_DETACH}" ]]; then
    if [[ -d /run/systemd/system ]] && command -v systemd-run >/dev/null 2>&1 \
      && systemd-run --scope --quiet --collect -- true >/dev/null 2>&1; then
      AGENT_CAN_DETACH=1
    else
      AGENT_CAN_DETACH=0
      log "no usable systemd scope; the upgrade will run inside this unit's cgroup"
    fi
  fi
  [[ "${AGENT_CAN_DETACH}" == "1" ]]
}

run_detached() {
  local label="$1"
  shift
  if detach_available; then
    systemd-run --scope --quiet --collect \
      --description="OrcaSynapse update agent: ${label}" \
      -- "$@"
    return
  fi
  "$@"
}

run_installer_at() {
  local commit="$1" label="$2" installer status=0
  installer="${AGENT_WORK}/install-${commit:0:12}.sh"
  # Before the attempt, not after it: whatever this run reports has to be this
  # run's. See clear_installer_rollback.
  clear_installer_rollback
  download_installer "${commit}" "${installer}" \
    || return 90
  # `|| status=$?` and not a `set +e` / `set -e` pair around the call. The pair
  # was the first draft, and the agent test caught what it does: `set -e` at the
  # end of a *function* re-enables errexit for the caller too, so this function
  # returning non-zero killed main() on the spot -- one line before the branch
  # that reads install.sh's rollback record and reports it. The record said
  # "exited during the upgrading phase" for a machine that had already rolled
  # itself back and was serving, which is the single most misleading thing this
  # agent could write down.
  #
  # PATH is passed explicitly: a transient scope is a fresh execution context,
  # and the installer has to find the same docker, curl and tar this agent found
  # rather than whatever systemd's default happens to contain.
  run_detached "${label}" env \
    PATH="${PATH}" \
    ORCASYNAPSE_REF="${commit}" \
    ORCASYNAPSE_INSTALL_DIR="${ORCASYNAPSE_INSTALL_DIR}" \
    ORCASYNAPSE_GITHUB_REPOSITORY="${ORCASYNAPSE_GITHUB_REPOSITORY}" \
    ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade \
    TERM=dumb \
    bash "${installer}" \
    || status=$?
  return "${status}"
}

# What install.sh's own rollback recorded, for this agent's record. Read rather
# than inferred: the installer is the only thing that knows whether the database
# was restored or deliberately left alone.
# Removed before an attempt, so a failure can only ever report its own outcome.
#
# `install.sh` writes this receipt when it rolls itself back, and nothing ever
# deleted it. A run that failed *before* reaching that point -- at the download,
# at the handoff, or on the early return `record_upgrade_rollback` takes when the
# install directory is absent -- then read the previous run's receipt and
# reported it as this run's, which is the worst possible lie for a screen an
# operator opens precisely because an upgrade went wrong.
clear_installer_rollback() {
  rm -f -- "${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-upgrade-rollback.json"
}

read_installer_rollback() {
  local receipt="${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-upgrade-rollback.json"
  local value=""
  [[ -r "${receipt}" ]] || { printf ''; return 0; }
  value="$(sed -nE 's/.*"outcome"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "${receipt}")" || value=""
  first_line "${value}"
}

recorded_previous_commit() {
  local receipt="${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-database-backup.json"
  local value=""
  [[ -r "${receipt}" ]] || { printf ''; return 0; }
  value="$(sed -nE 's/.*"fromCommit"[[:space:]]*:[[:space:]]*"([0-9a-f]{40})".*/\1/p' "${receipt}")" || value=""
  first_line "${value}"
}

recorded_dump_path() {
  local receipt="${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-database-backup.json"
  local value=""
  [[ -r "${receipt}" ]] || { printf ''; return 0; }
  value="$(sed -nE 's/.*"path"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "${receipt}")" || value=""
  first_line "${value}"
}

# The outer half of trap 3, for the case install.sh cannot cover: it returned
# zero -- its own readiness wait was satisfied -- and the deployment then failed
# to stay up. install.sh has already discarded its retained tree by then, so the
# way back is the documented one: restore the pre-upgrade dump and reinstall the
# commit the backup record names, which is the same pair of steps
# docs/DATABASE_RESTORE_RUNBOOK.md gives an operator.
recover_previous_release() {
  local previous dump status=0
  previous="$(recorded_previous_commit)"
  dump="$(recorded_dump_path)"
  if [[ ! "${previous}" =~ ^[a-f0-9]{40}$ ]]; then
    AGENT_ROLLBACK="impossible: no previous commit recorded"
    return 1
  fi
  set_phase "recovering" "restoring ${previous:0:12} after the upgraded deployment failed its health gate"
  if [[ -n "${dump}" && -f "${dump}" ]]; then
    docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" stop api worker web \
      >/dev/null 2>&1 || true
    docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" up -d --no-build postgres \
      >/dev/null 2>&1 || true
    if gzip -cd -- "${dump}" \
      | docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
          sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --username="$1" --dbname="$2" --no-password -v ON_ERROR_STOP=1 -q' \
          orcasynapse-update-agent "${AGENT_DATABASE_USER}" "${AGENT_DATABASE_NAME}" >/dev/null; then
      AGENT_ROLLBACK="database restored from ${dump}"
    else
      AGENT_ROLLBACK="the pre-upgrade dump at ${dump} could not be restored"
      log "the pre-upgrade dump could not be restored; continuing with the source rollback"
    fi
  else
    AGENT_ROLLBACK="no pre-upgrade dump was recorded"
  fi
  run_installer_at "${previous}" "recover" || status=$?
  if (( status != 0 )); then
    AGENT_ROLLBACK="${AGENT_ROLLBACK}; reinstalling ${previous:0:12} exited ${status}"
    return 1
  fi
  AGENT_ROLLBACK="${AGENT_ROLLBACK}; ${previous:0:12} reinstalled"
  return 0
}

main() {
  [[ "${EUID}" -eq 0 ]] || fail "the update agent must run as root"
  [[ -d "${ORCASYNAPSE_INSTALL_DIR}" ]] || fail "no installation at ${ORCASYNAPSE_INSTALL_DIR}"
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed on this host"
  command -v curl >/dev/null 2>&1 || fail "curl is not installed on this host"
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable"

  AGENT_WORK="$(mktemp -d /var/tmp/orcasynapse-update.XXXXXX)"

  local identity
  identity="$(database_identity)" \
    || fail "the protected database URL secret is not a connection URL this agent can read"
  AGENT_DATABASE_USER="${identity%% *}"
  AGENT_DATABASE_NAME="${identity##* }"

  AGENT_INSTALLED_VERSION="$(installed_version)"
  AGENT_INSTALLED_COMMIT="$(installed_commit)"
  [[ -n "${AGENT_INSTALLED_COMMIT}" ]] \
    || fail "this installation records no source commit, so there is nothing to compare a target against"

  read_release_target \
    || fail "the approved release target could not be read from PostgreSQL"

  if [[ -z "${AGENT_TARGET_COMMIT}" ]]; then
    set_phase "idle" "no release target is approved"
    return 0
  fi
  if [[ ! "${AGENT_TARGET_COMMIT}" =~ ^[a-f0-9]{40}$ ]]; then
    fail "the approved release target names '${AGENT_TARGET_COMMIT}', which is not a 40-character commit"
  fi
  if [[ "${AGENT_TARGET_COMMIT}" == "${AGENT_INSTALLED_COMMIT}" \
    || ( -n "${AGENT_INSTALLED_VERSION}" && "${AGENT_TARGET_VERSION}" == "${AGENT_INSTALLED_VERSION}" ) ]]; then
    set_phase "idle" "the approved target ${AGENT_TARGET_VERSION:-${AGENT_TARGET_COMMIT:0:12}} is already installed"
    unblock_target
    return 0
  fi
  if blocked_target; then
    set_phase "blocked" "${AGENT_TARGET_VERSION:-${AGENT_TARGET_COMMIT:0:12}} was already tried on this host and rolled back; approve it again to retry, or remove ${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target"
    return 0
  fi

  AGENT_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # From here on this invocation is an attempt with an identity, so every phase
  # it reports updates one row. Taken from the kernel rather than uuidgen, which
  # is packaged separately and would be a new dependency on an installer path
  # that currently needs only docker and curl.
  AGENT_RUN_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null)" || AGENT_RUN_ID=""
  # The cut-off capture_installer_log compares against. Created before the
  # installer runs, so every log file it writes is strictly newer.
  : > "${AGENT_WORK}/log-since"
  # Trap 2. The API is about to stop answering, and a panel that cannot tell
  # that from a crash will report a healthy restart as a stalled machine. The
  # moment the budget expires is written down before the first byte moves, so
  # "unreachable and it is not yet that time" is a fact rather than a guess.
  AGENT_UNAVAILABLE_UNTIL="$(date -u -d "+${ORCASYNAPSE_UPDATE_UNAVAILABLE_BUDGET} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '')"
  set_phase "upgrading" "moving ${AGENT_INSTALLED_VERSION:-this deployment} to ${AGENT_TARGET_VERSION:-${AGENT_TARGET_COMMIT:0:12}}"

  local status=0
  run_installer_at "${AGENT_TARGET_COMMIT}" "upgrade" || status=$?

  # Before either branch below, and before any recovery runs. The installer
  # writes its log inside the tree it just replaced, and a rollback puts a
  # different tree back -- so the log explaining a failure is gone by the time
  # anything has decided the run failed. This is the last moment it exists.
  capture_installer_log || true

  if (( status == 90 )); then
    fail "install.sh could not be fetched at ${AGENT_TARGET_COMMIT:0:12}; nothing on this host was changed"
  fi

  if (( status != 0 )); then
    # install.sh rolled itself back before returning -- that is increment 4's
    # first half and it is asserted by the upgrade harness. What is left here is
    # to say so on disk and to confirm the machine is actually serving again.
    # Named explicitly when there is none, rather than rendering as an empty
    # "install.sh: " that reads like a truncated record. With the receipt now
    # cleared before every attempt, absence means this run never got as far as
    # rolling back -- which is itself the useful fact.
    installer_rollback="$(read_installer_rollback)"
    AGENT_ROLLBACK="install.sh: ${installer_rollback:-no rollback record was written by this attempt}"
    AGENT_INSTALLED_VERSION="$(installed_version)"
    AGENT_INSTALLED_COMMIT="$(installed_commit)"
    block_target
    if wait_for_ready "${ORCASYNAPSE_UPDATE_READY_TIMEOUT}"; then
      set_phase "rolled-back" "the upgrade failed (installer exit ${status}); this deployment was restored and is serving"
    else
      set_phase "failed" "the upgrade failed (installer exit ${status}) and the restored deployment is not answering /readyz"
    fi
    return 1
  fi

  set_phase "verifying" "the installer finished; waiting for /readyz on port ${ORCASYNAPSE_HTTP_PORT}"
  if wait_for_ready "${ORCASYNAPSE_UPDATE_READY_TIMEOUT}"; then
    AGENT_INSTALLED_VERSION="$(installed_version)"
    AGENT_INSTALLED_COMMIT="$(installed_commit)"
    unblock_target
    set_phase "healthy" "this deployment is running ${AGENT_INSTALLED_VERSION:-${AGENT_INSTALLED_COMMIT:0:12}}"
    return 0
  fi

  log "the upgraded deployment never answered /readyz; recovering the previous release"
  block_target
  if recover_previous_release; then
    AGENT_INSTALLED_VERSION="$(installed_version)"
    AGENT_INSTALLED_COMMIT="$(installed_commit)"
    if wait_for_ready "${ORCASYNAPSE_UPDATE_READY_TIMEOUT}"; then
      set_phase "rolled-back" "the upgrade never became ready; the previous release was restored and is serving"
      return 1
    fi
    set_phase "failed" "the previous release was restored but is not answering /readyz"
    return 1
  fi
  AGENT_INSTALLED_VERSION="$(installed_version)"
  AGENT_INSTALLED_COMMIT="$(installed_commit)"
  set_phase "failed" "the upgrade never became ready and the previous release could not be restored"
  return 1
}

# One run at a time, and a second run while one is in flight is not an error --
# the timer fires every ten minutes and an upgrade takes longer than that. The
# lock file lives outside the install tree, because the tree is renamed during
# the very run the lock is protecting.
#
# 75 is EX_TEMPFAIL, chosen so a contended lock is distinguishable from a failed
# run in the exit status before it is translated to the success this unit should
# report for "somebody else is already doing it".
if [[ "${ORCASYNAPSE_UPDATE_AGENT_LOCKED:-0}" != "1" ]]; then
  install -d -m 0700 "${ORCASYNAPSE_UPDATE_STATE_DIR}"
  agent_lock_status=0
  set +e
  env ORCASYNAPSE_UPDATE_AGENT_LOCKED=1 \
    flock --nonblock --conflict-exit-code 75 "${ORCASYNAPSE_UPDATE_STATE_DIR}/agent.lock" \
    bash "${BASH_SOURCE[0]}" "$@"
  agent_lock_status=$?
  set -e
  if (( agent_lock_status == 75 )); then
    log "another update run holds the lock; leaving it to finish"
    exit 0
  fi
  exit "${agent_lock_status}"
fi

main "$@"
