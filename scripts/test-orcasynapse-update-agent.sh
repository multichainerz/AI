#!/usr/bin/env bash
# Drives scripts/orcasynapse-update-agent.sh against a real PostgreSQL, a real
# install.sh, and a readiness endpoint that can be made to stop answering.
#
# The upgrade suite next to this one owns install.sh's rollback and proves it
# eight scenarios deep. What has no coverage there is the thing that decides
# whether an operator can be given an update button and have their shell taken
# away: a host program that reads an approved version out of the database and
# moves the machine to it, while the machine is replacing the program's own
# installation underneath it.
#
# ---------------------------------------------------------------------------
# What is real here and what is not
# ---------------------------------------------------------------------------
#   real  -- the agent in full, the real install.sh it downloads and runs, the
#            source-tree swap, forward-only migrations against a live
#            postgres:17-bookworm holding seeded rows, the rollback install.sh
#            performs, the readiness gate over HTTP, and systemd transient
#            scopes where systemd is present.
#   staged -- GitHub (a curl shim answers codeload from staged tarballs and a
#            file:// tree answers the install.sh fetch), the host installer
#            install.sh hands off to (the same stub the upgrade suite uses,
#            which runs real SQL migrations), and the readiness endpoint (a
#            static file server whose one file the stub creates or removes).
#   absent -- no application image is built and no api container runs, so
#            nothing here says the product boots. And no `PlatformReleaseTarget`
#            row was ever written by the real approval endpoint: the table is
#            recreated here from the same column names, and a gate below
#            asserts those names still match packages/database's schema.
#
# ---------------------------------------------------------------------------
# Containment
# ---------------------------------------------------------------------------
# Compose project orcasynapse-update-agent-test, an internal network, no
# published database port, an installation directory under /var/tmp, and a
# readiness stub bound to 127.0.0.1. The agent is copied out of the repository
# and run from the work tree, so nothing writes to /usr/local/lib or
# /etc/systemd/system -- the units are the host installer's job and the VM1
# smoke test is what asserts them. The run ends by asserting that the host's
# containers, volumes and networks are the set it started with.
#
# Needs root, a reachable Docker daemon, python3 and curl.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Overridable only so this harness can be pointed at a deliberately broken copy
# of the agent outside the repository and watched to fail. Nothing in CI sets it.
AGENT_SOURCE="${ORCASYNAPSE_UPDATE_AGENT_TEST_AGENT:-${ROOT}/scripts/orcasynapse-update-agent.sh}"
INSTALLER_SOURCE="${ORCASYNAPSE_UPDATE_AGENT_TEST_INSTALLER:-${ROOT}/install.sh}"

WORK="$(mktemp -d /var/tmp/orcasynapse-update-agent-test.XXXXXX)"
PROJECT="orcasynapse-update-agent-test"
INSTALL_PARENT="${WORK}/opt"
INSTALL_DIR="${INSTALL_PARENT}/orcasynapse"
SHIM_DIR="${WORK}/shims"
FAKE_GITHUB="${WORK}/fake-github"
ARCHIVE_DIR="${WORK}/archives"
HEALTH_DIR="${WORK}/health"
STATE_DIR="${WORK}/var-lib-orcasynapse-update"
# Outside the installation directory on purpose: this is the whole point of
# trap 1, and a copy inside INSTALL_DIR would be unlinked mid-run.
AGENT_DIR="${WORK}/usr-local-lib"
AGENT="${AGENT_DIR}/orcasynapse-update-agent.sh"
HEALTH_PORT="${ORCASYNAPSE_UPDATE_AGENT_TEST_PORT:-8397}"
HEALTH_PID=""

REPOSITORY="orcasynapse-test/release-fixture"
VERSION_A="v9.9.8"
VERSION_B="v9.9.9"
COMMIT_A="a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"
COMMIT_B="b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"
RELEASE_A="${WORK}/release-a/orcasynapse-release"
RELEASE_B="${WORK}/release-b/orcasynapse-release"

PROBE_EMAIL="grace@orcasynapse-agent-probe.test"
agent_output="${WORK}/agent.out"
agent_status=0
failures=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

teardown_stack() {
  if [[ -f "${INSTALL_DIR}/compose.yaml" ]]; then
    docker compose --project-directory "${INSTALL_DIR}" down --volumes --remove-orphans \
      >/dev/null 2>&1 || true
  fi
  local id
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null || true); do
    docker rm -f "${id}" >/dev/null 2>&1 || true
  done
  for id in $(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null || true); do
    docker volume rm -f "${id}" >/dev/null 2>&1 || true
  done
  for id in $(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null || true); do
    docker network rm "${id}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  [[ -z "${HEALTH_PID}" ]] || kill "${HEALTH_PID}" >/dev/null 2>&1 || true
  teardown_stack
  rm -rf -- "${WORK}"
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || { echo "run as root: sudo bash scripts/test-orcasynapse-update-agent.sh" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "this test needs a reachable Docker daemon" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "this test needs Docker Compose v2" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "this test needs python3 for the readiness stub" >&2; exit 2; }
[[ -r "${AGENT_SOURCE}" ]] || { echo "no update agent to test at ${AGENT_SOURCE}" >&2; exit 2; }
[[ -r "${INSTALLER_SOURCE}" ]] || { echo "no installer at ${INSTALLER_SOURCE}" >&2; exit 2; }

compose() { docker compose --project-directory "${INSTALL_DIR}" "$@"; }

psql_value() {
  local out=""
  out="$(compose exec -T postgres psql -U orcasynapse -d orcasynapse -tAc "$1" </dev/null 2>/dev/null)" || out=""
  printf '%s' "${out//[$'\r\n\t ']/}"
}

psql_run() {
  compose exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q -c "$1" \
    </dev/null >/dev/null
}

printf '\n=== recording the host state this run must leave unchanged ===\n'
docker ps -a --format '{{.Names}}' | sort > "${WORK}/containers.before"
docker volume ls --format '{{.Name}}' | sort > "${WORK}/volumes.before"
docker network ls --format '{{.Name}}' | sort > "${WORK}/networks.before"
pass "host has $(wc -l < "${WORK}/containers.before") container(s) and $(wc -l < "${WORK}/volumes.before") volume(s) before this run"

# ---------------------------------------------------------------------------
# The table the agent reads must be the table the product writes
# ---------------------------------------------------------------------------
# This harness recreates PlatformReleaseTarget by hand, which makes it capable of
# passing while the real column names have moved underneath it. The names are
# therefore checked against the schema module rather than assumed.
printf '\n=== the approved-target columns match the shipped schema ===\n'
schema="${ROOT}/packages/database/src/drizzle/schema.ts"
if [[ -r "${schema}" ]]; then
  for column in desiredVersion desiredCommit; do
    grep -Fq "${column}" "${schema}" \
      && pass "packages/database still declares ${column}" \
      || bad "packages/database no longer declares ${column}; the agent's query is stale"
  done
  grep -Fq 'pgTable("PlatformReleaseTarget"' "${schema}" \
    && pass "packages/database still declares the PlatformReleaseTarget table" \
    || bad "PlatformReleaseTarget is gone from the schema; the agent's query is stale"
else
  bad "packages/database/src/drizzle/schema.ts is missing, so nothing anchors this harness to the real schema"
fi

# The secret handling install.sh's backup function documents, asserted rather
# than assumed. A `docker compose exec -e PGPASSWORD=` publishes the database
# password to every `ps` on the host for the length of the query.
printf '\n=== the agent never puts the database password on the host process list ===\n'
# Comment lines are excluded, because the reason this rule exists is written out
# in the agent's own comments and a check that reads them can only ever fail.
code_mentions_pgpassword="$(grep -n 'PGPASSWORD' "${AGENT_SOURCE}" | grep -v '^[0-9]*:[[:space:]]*#' || true)"
if [[ -z "${code_mentions_pgpassword}" ]]; then
  bad "the agent has no PGPASSWORD line at all, so this check is asserting nothing"
elif printf '%s\n' "${code_mentions_pgpassword}" | grep -qv '/run/secrets/postgres_password'; then
  bad "the agent sets PGPASSWORD somewhere that does not read /run/secrets/postgres_password"
else
  pass "every PGPASSWORD in the agent's code is read from the container's own secret mount"
fi
printf '%s\n' "${code_mentions_pgpassword}" | grep -q -- '-e[[:space:]]*PGPASSWORD' \
  && bad "the agent passes PGPASSWORD to docker compose exec, which publishes it to ps" \
  || pass "the agent passes no password to docker compose exec"

# ---------------------------------------------------------------------------
# Two release trees, and the stub host installer that owns readiness
# ---------------------------------------------------------------------------
write_compose_file() {
  cat > "$1" <<'COMPOSE'
name: orcasynapse-update-agent-test

# PostgreSQL only, and no published port. A real orcasynapse stack on this host
# shares neither the project name nor the network.
services:
  postgres:
    image: postgres:17-bookworm
    restart: unless-stopped
    environment:
      POSTGRES_DB: orcasynapse
      POSTGRES_USER: orcasynapse
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    secrets:
      - postgres_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U orcasynapse -d orcasynapse"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 60s
    networks:
      - data

secrets:
  postgres_password:
    file: ./.local/secrets/postgres_password

volumes:
  postgres_data:

networks:
  data:
    internal: true
COMPOSE
}

# The same shape as the upgrade suite's stub, plus one thing it does not need:
# this one owns the readiness endpoint. A release that "does not come up" is
# modelled by its stub removing the file the readiness server serves, which is
# what lets the agent's health gate be exercised against a release that installs
# cleanly and then fails to run -- the case install.sh cannot catch, because
# install.sh has already returned zero.
write_host_installer_stub() {
  cat > "$1" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail

stub_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
version="$(sed -nE 's/.*ORCASYNAPSE_VERSION = "([^"]+)".*/\1/p' \
  "${stub_root}/packages/contracts/src/version.ts" | head -n 1)"
commit=""
[[ -r "${stub_root}/.orcasynapse-source-commit" ]] && commit="$(<"${stub_root}/.orcasynapse-source-commit")"

dc() { docker compose --project-directory "${stub_root}" "$@"; }
psql_run() { dc exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q "$@" >/dev/null; }
psql_value() {
  local out
  out="$(dc exec -T postgres psql -U orcasynapse -d orcasynapse -tAc "$1" </dev/null)"
  printf '%s' "${out//[$'\r\n\t ']/}"
}

printf 'stub host installer: %s @ %.12s\n' "${version}" "${commit}"
install -d -m 0700 "${stub_root}/.local" "${stub_root}/.local/secrets" "${stub_root}/.local/state"
printf 'handoff %s %s\n' "${version}" "${commit}" >> "${stub_root}/.local/state/harness-handoff.log"
chmod 0600 "${stub_root}/.local/state/harness-handoff.log"

if [[ ! -s "${stub_root}/.local/secrets/postgres_password" ]]; then
  password="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
  printf '%s' "${password}" > "${stub_root}/.local/secrets/postgres_password"
  chmod 0600 "${stub_root}/.local/secrets/postgres_password"
  printf 'postgresql://orcasynapse:%s@postgres:5432/orcasynapse' "${password}" \
    > "${stub_root}/.local/secrets/orcasynapse_database_url"
  chmod 0640 "${stub_root}/.local/secrets/orcasynapse_database_url"
fi

dc up -d --no-build postgres >/dev/null 2>&1 || dc up -d postgres
deadline=$((SECONDS + 180))
until dc exec -T postgres pg_isready -h 127.0.0.1 -U orcasynapse -d orcasynapse >/dev/null 2>&1; do
  (( SECONDS < deadline )) || { printf 'stub host installer: PostgreSQL never became ready\n' >&2; exit 1; }
  sleep 2
done

psql_run -c "create table if not exists _harness_schema_migrations (
  name text primary key, applied_at timestamptz not null default now());" </dev/null
shopt -s nullglob
for sql in "${stub_root}/.orcasynapse-migrations"/*.sql; do
  name="$(basename -- "${sql}")"
  if [[ "$(psql_value "select count(*) from _harness_schema_migrations where name = '${name}'")" != "0" ]]; then
    continue
  fi
  printf 'stub host installer: applying %s\n' "${name}"
  psql_run -f - < "${sql}"
  psql_run -c "insert into _harness_schema_migrations (name) values ('${name}');" </dev/null
done
shopt -u nullglob

# Version-scoped, for the reason the upgrade suite states: install.sh's rollback
# re-runs the restored tree's own installer, and a boolean flag would fail that
# run too.
if [[ "${AGENT_TEST_FAIL_AFTER_MIGRATE:-}" == "${version}" ]]; then
  visible="$(psql_value "select count(*) from information_schema.columns
    where table_name = 'harness_account' and column_name = 'display_name'")"
  if [[ "${visible}" != "1" ]]; then
    printf 'stub host installer: post-migration failure requested but the migration is not visible\n' >&2
    exit 3
  fi
  printf 'stub host installer: inducing a failure after the migrations have run\n' >&2
  exit 1
fi

# Readiness. A release named in AGENT_TEST_UNHEALTHY installs perfectly and then
# does not serve, which is exactly the failure install.sh cannot see.
if [[ -n "${AGENT_TEST_HEALTH_DIR:-}" ]]; then
  if [[ "${AGENT_TEST_UNHEALTHY:-}" == "${version}" ]]; then
    rm -f -- "${AGENT_TEST_HEALTH_DIR}/readyz"
    printf 'stub host installer: %s installed but is not serving\n' "${version}" >&2
  else
    printf 'ok %s\n' "${version}" > "${AGENT_TEST_HEALTH_DIR}/readyz"
  fi
fi

printf '{"version":"%s","commit":"%s","completedAt":"%s","publicScheme":"http"}\n' \
  "${version}" "${commit}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "${stub_root}/.local/state/install-complete.json"
chmod 0600 "${stub_root}/.local/state/install-complete.json"
printf '%s\n' 'hermes-native-v1' > "${stub_root}/.local/state/schema-epoch"
chmod 0600 "${stub_root}/.local/state/schema-epoch"
printf 'ORCASYNAPSE IS READY (stub host installer, %s)\n' "${version}"
STUB
  chmod 0755 "$1"
}

stage_release_tree() {
  local dir="$1" version="$2"
  install -d -m 0755 "${dir}/scripts" "${dir}/packages/contracts/src" "${dir}/.orcasynapse-migrations"
  write_compose_file "${dir}/compose.yaml"
  write_host_installer_stub "${dir}/scripts/install-orcasynapse.sh"
  printf 'export const ORCASYNAPSE_VERSION = "%s";\n' "${version}" \
    > "${dir}/packages/contracts/src/version.ts"
  printf '%s\n' "${version}" > "${dir}/release-marker"
  cat > "${dir}/.orcasynapse-migrations/001-baseline.sql" <<'SQL'
create table if not exists harness_account (
  id integer primary key,
  email text not null
);
SQL
}

printf '\n=== staging release trees A (%s) and B (%s) ===\n' "${VERSION_A}" "${VERSION_B}"
stage_release_tree "${RELEASE_A}" "${VERSION_A}"
stage_release_tree "${RELEASE_B}" "${VERSION_B}"
cat > "${RELEASE_B}/.orcasynapse-migrations/002-add-display-name.sql" <<'SQL'
alter table harness_account add column display_name text;
update harness_account set display_name = 'migrated:' || email where display_name is null;
SQL
install -d -m 0755 "${ARCHIVE_DIR}"
tar -czf "${ARCHIVE_DIR}/${COMMIT_A}.tar.gz" -C "${WORK}/release-a" orcasynapse-release
tar -czf "${ARCHIVE_DIR}/${COMMIT_B}.tar.gz" -C "${WORK}/release-b" orcasynapse-release
pass "two release trees staged as commit-addressed archives"

# ---------------------------------------------------------------------------
# The GitHub the agent is allowed to see
# ---------------------------------------------------------------------------
# The real install.sh at each commit path, and a poisoned one at main. The
# poisoned copy is the assertion behind "download install.sh at the approved
# tag, never from a moving ref": if the agent ever resolves to main, the run
# aborts with a status nothing else produces.
install -d -m 0755 "${FAKE_GITHUB}/${REPOSITORY}/${COMMIT_A}" \
  "${FAKE_GITHUB}/${REPOSITORY}/${COMMIT_B}" "${FAKE_GITHUB}/${REPOSITORY}/main"
install -m 0644 "${INSTALLER_SOURCE}" "${FAKE_GITHUB}/${REPOSITORY}/${COMMIT_A}/install.sh"
install -m 0644 "${INSTALLER_SOURCE}" "${FAKE_GITHUB}/${REPOSITORY}/${COMMIT_B}/install.sh"
cat > "${FAKE_GITHUB}/${REPOSITORY}/main/install.sh" <<'POISON'
#!/usr/bin/env bash
# ORCASYNAPSE_INSTALLER_LIBRARY_ONLY - present only so this passes the agent's
# shape check and fails where it can be seen, rather than being rejected as a
# malformed download and mistaken for a network problem.
echo 'AGENT FETCHED install.sh FROM main, WHICH IS A MOVING REF' >&2
exit 66
POISON
chmod 0644 "${FAKE_GITHUB}/${REPOSITORY}/main/install.sh"
pass "install.sh staged at both commits, and a poisoned copy staged at main"

# The one shim: codeload.github.com, and nothing else. Every other URL is handed
# to the real curl, so the agent's own download of install.sh over file:// and
# its readiness probe over HTTP both exercise the real client.
install -d -m 0755 "${SHIM_DIR}"
cat > "${SHIM_DIR}/curl" <<SHIM
#!/usr/bin/env bash
archives="${ARCHIVE_DIR}"
head=0
out=""
url=""
args=("\$@")
while (( \$# )); do
  case "\$1" in
    --head) head=1 ;;
    --output) out="\$2"; shift ;;
    -*) ;;
    *) url="\$1" ;;
  esac
  shift
done
if [[ "\${url}" != *codeload.github.com* ]]; then
  exec /usr/bin/curl "\${args[@]}"
fi
commit="\${url##*/}"
archive="\${archives}/\${commit}.tar.gz"
[[ -f "\${archive}" ]] || exit 22
if (( head )); then
  printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "\$(stat -c '%s' "\${archive}")"
  exit 0
fi
[[ -n "\${out}" ]] || exit 1
cp -- "\${archive}" "\${out}"
SHIM
chmod 0755 "${SHIM_DIR}/curl"
[[ -x /usr/bin/curl ]] || { echo "this test needs /usr/bin/curl for the shim to delegate to" >&2; exit 2; }
pass "curl shim staged; only codeload is answered locally"

# ---------------------------------------------------------------------------
# The readiness endpoint
# ---------------------------------------------------------------------------
install -d -m 0755 "${HEALTH_DIR}"
printf 'ok\n' > "${HEALTH_DIR}/readyz"
python3 -m http.server "${HEALTH_PORT}" --bind 127.0.0.1 --directory "${HEALTH_DIR}" \
  >/dev/null 2>&1 &
HEALTH_PID=$!
health_deadline=$((SECONDS + 30))
until /usr/bin/curl --fail --silent --max-time 2 "http://127.0.0.1:${HEALTH_PORT}/readyz" >/dev/null 2>&1; do
  (( SECONDS < health_deadline )) || { echo "the readiness stub never came up on ${HEALTH_PORT}" >&2; exit 2; }
  sleep 1
done
pass "readiness stub answering on 127.0.0.1:${HEALTH_PORT}"

# ---------------------------------------------------------------------------
# The agent, installed the way the host installer installs it
# ---------------------------------------------------------------------------
install -d -m 0755 "${AGENT_DIR}"
install -m 0700 "${AGENT_SOURCE}" "${AGENT}"
[[ "${AGENT}" != "${INSTALL_DIR}"/* ]] \
  && pass "the agent under test lives outside the tree an upgrade replaces" \
  || bad "the agent under test is inside the installation directory"

run_installer_directly() {
  local commit="$1"
  env PATH="${SHIM_DIR}:${PATH}" TERM=dumb \
    ORCASYNAPSE_INSTALL_DIR="${INSTALL_DIR}" \
    ORCASYNAPSE_REF="${commit}" \
    AGENT_TEST_HEALTH_DIR="${HEALTH_DIR}" \
    bash "${INSTALLER_SOURCE}" </dev/null >"${WORK}/bootstrap.out" 2>&1
}

# NAME=VALUE overrides are appended to the agent's environment.
run_agent() {
  : > "${agent_output}"
  chmod 0600 "${agent_output}"
  set +e
  env PATH="${SHIM_DIR}:${PATH}" TERM=dumb \
    ORCASYNAPSE_INSTALL_DIR="${INSTALL_DIR}" \
    ORCASYNAPSE_GITHUB_REPOSITORY="${REPOSITORY}" \
    ORCASYNAPSE_HTTP_PORT="${HEALTH_PORT}" \
    ORCASYNAPSE_UPDATE_STATE_DIR="${STATE_DIR}" \
    ORCASYNAPSE_UPDATE_SOURCE_BASE="file://${FAKE_GITHUB}" \
    ORCASYNAPSE_UPDATE_READY_TIMEOUT="${AGENT_READY_TIMEOUT:-60}" \
    AGENT_TEST_HEALTH_DIR="${HEALTH_DIR}" \
    "$@" \
    bash "${AGENT}" </dev/null >"${agent_output}" 2>&1
  agent_status=$?
  set -e
}

report_agent_output() {
  printf '  ---- agent output (last 25 lines) ----\n' >&2
  tail -n 25 "${agent_output}" >&2 || true
  printf '  --------------------------------------\n' >&2
}

# Reported rather than fatal. A broken agent can leave the stack in a state
# where psql cannot connect, and under errexit an unguarded set_target would end
# the run there -- turning "this mutation broke six scenarios" into "the harness
# stopped", which is the shape of failure that hides how much was skipped.
set_target() {
  set_target_now "$@" \
    || bad "the approved target could not be written (the database is not answering)"
  return 0
}

set_target_now() {
  local version="$1" commit="$2"
  if [[ -z "${commit}" ]]; then
    psql_run "update \"PlatformReleaseTarget\"
      set \"desiredVersion\" = null, \"desiredCommit\" = null, \"approvedAt\" = null,
          \"approvedBySubject\" = null, \"revision\" = \"revision\" + 1
      where \"id\" = 'global';"
    return
  fi
  psql_run "insert into \"PlatformReleaseTarget\"
      (\"id\", \"desiredVersion\", \"desiredCommit\", \"approvedBySubject\", \"approvedAt\", \"revision\")
    values ('global', '${version}', '${commit}', 'admin@orcasynapse-agent-probe.test', now(), 1)
    on conflict (\"id\") do update set
      \"desiredVersion\" = excluded.\"desiredVersion\",
      \"desiredCommit\" = excluded.\"desiredCommit\",
      \"approvedAt\" = excluded.\"approvedAt\",
      \"revision\" = \"PlatformReleaseTarget\".\"revision\" + 1;"
}

installed_commit() {
  [[ -r "${INSTALL_DIR}/.orcasynapse-source-commit" ]] || { printf ''; return 0; }
  printf '%s' "$(<"${INSTALL_DIR}/.orcasynapse-source-commit")"
}

installed_marker() {
  [[ -r "${INSTALL_DIR}/release-marker" ]] || { printf ''; return 0; }
  local value
  value="$(<"${INSTALL_DIR}/release-marker")"
  printf '%s' "${value//[$'\r\n']/}"
}

durable_record() {
  [[ -r "${STATE_DIR}/last-run.json" ]] || { printf ''; return 0; }
  tr -d '\r\n' < "${STATE_DIR}/last-run.json"
}

in_tree_record() {
  [[ -r "${INSTALL_DIR}/.local/state/last-update-agent.json" ]] || { printf ''; return 0; }
  tr -d '\r\n' < "${INSTALL_DIR}/.local/state/last-update-agent.json"
}

display_name_columns() {
  psql_value "select count(*) from information_schema.columns
    where table_name = 'harness_account' and column_name = 'display_name'"
}

# ---------------------------------------------------------------------------
# 1. An installation at A, with rows and an approved-target table
# ---------------------------------------------------------------------------
printf '\n=== installing version %s for the agent to update ===\n' "${VERSION_A}"
if run_installer_directly "${COMMIT_A}"; then
  pass "the fresh install of ${VERSION_A} completed"
else
  bad "the fresh install of ${VERSION_A} failed"
  tail -n 30 "${WORK}/bootstrap.out" >&2 || true
  printf '\nThe update agent test cannot continue without an installation at A.\n' >&2
  exit 1
fi
psql_run "insert into harness_account (id, email) values
  (1, 'ada@orcasynapse-agent-probe.test'),
  (2, '${PROBE_EMAIL}'),
  (3, 'alan@orcasynapse-agent-probe.test'),
  (4, 'alonzo@orcasynapse-agent-probe.test')
  on conflict (id) do nothing;" \
  || { bad "the seed data could not be written"; exit 1; }
# The increment-2 table, recreated from the shipped column names checked above.
psql_run "create table if not exists \"PlatformReleaseTarget\" (
  \"id\" varchar(32) primary key,
  \"desiredVersion\" varchar(64),
  \"desiredCommit\" varchar(40),
  \"approvedBy\" uuid,
  \"approvedBySubject\" varchar(320),
  \"approvedAt\" timestamptz,
  \"revision\" integer not null default 0);" \
  || { bad "the approved-target table could not be created"; exit 1; }
pass "four rows seeded and the approved-target table created"

# The state every scenario below starts from: A's schema, A's rows, A's source.
#
# Taken here rather than reused from install.sh's own dumps because retention
# keeps only three of those and this harness runs more upgrades than that. It is
# the same shape -- --clean --if-exists --no-owner -- so restoring it is the same
# operation the runbook documents.
compose exec -T postgres pg_dump -U orcasynapse -d orcasynapse \
    --clean --if-exists --no-owner </dev/null 2>/dev/null | gzip -9 > "${WORK}/baseline.sql.gz"
gzip -t -- "${WORK}/baseline.sql.gz" \
  && pass "a baseline dump of ${VERSION_A} was taken for the resets between scenarios" \
  || { bad "the baseline dump is unreadable, so no scenario below could start from a known state"; exit 1; }

# Reinstalling A's *source* does not undo a migration -- the migrations are
# forward-only, which is the whole premise of this feature. A reset that only
# moved the source would leave every later scenario starting from A's code over
# B's schema, a state no deployment is ever in, and the post-migration failure
# below would then have no migration left to fail after.
reset_to_a() {
  local label="$1"
  if gzip -cd -- "${WORK}/baseline.sql.gz" \
    | compose exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q \
      >"${WORK}/reset.out" 2>&1; then
    :
  else
    bad "${label}: the baseline database could not be restored"
    tail -n 20 "${WORK}/reset.out" >&2 || true
    return 1
  fi
  set_target "${VERSION_A}" "${COMMIT_A}"
  run_agent
  if (( agent_status != 0 )); then
    bad "${label}: resetting the source to ${VERSION_A} exited ${agent_status}"
    report_agent_output
    return 1
  fi
  if [[ "$(installed_commit)" != "${COMMIT_A}" || "$(display_name_columns)" != "0" ]]; then
    bad "${label}: the reset did not reach ${VERSION_A} over A's schema"
    return 1
  fi
  pass "${label}: reset to ${VERSION_A} over ${VERSION_A}'s schema"
  return 0
}

# ---------------------------------------------------------------------------
# 2. Nothing approved
# ---------------------------------------------------------------------------
printf '\n=== the agent does nothing when nothing is approved ===\n'
run_agent
(( agent_status == 0 )) \
  && pass "the agent exited 0 with no target row at all" \
  || { bad "the agent exited ${agent_status} with no target row"; report_agent_output; }
[[ "$(durable_record)" == *'"phase":"idle"'* ]] \
  && pass "the record reports idle" \
  || bad "the record reports '$(durable_record)'"
[[ "$(installed_commit)" == "${COMMIT_A}" ]] \
  && pass "nothing was installed" \
  || bad "the installed commit moved to '$(installed_commit)' with no target approved"

set_target "" ""
run_agent
[[ "$(durable_record)" == *'"phase":"idle"'* ]] \
  && pass "a target row with null columns is also idle" \
  || bad "a null target produced '$(durable_record)'"

# ---------------------------------------------------------------------------
# 3. The approved version is the one already installed
# ---------------------------------------------------------------------------
printf '\n=== the agent does nothing when the approved version is installed ===\n'
set_target "${VERSION_A}" "${COMMIT_A}"
run_agent
(( agent_status == 0 )) \
  && pass "the agent exited 0 when the target equals the installed release" \
  || { bad "the agent exited ${agent_status} for a target it already satisfies"; report_agent_output; }
[[ "$(durable_record)" == *'"phase":"idle"'* ]] \
  && pass "the record still reports idle" \
  || bad "the record reports '$(durable_record)'"
[[ "$(cat "${INSTALL_DIR}/.local/state/harness-handoff.log" | wc -l)" == "1" ]] \
  && pass "the host installer did not run again" \
  || bad "the host installer ran again for a target that was already installed"

# ---------------------------------------------------------------------------
# 4. A real upgrade, driven end to end by the agent
# ---------------------------------------------------------------------------
printf '\n=== the agent applies the approved target ===\n'
set_target "${VERSION_B}" "${COMMIT_B}"
run_agent
if (( agent_status == 0 )); then
  pass "the agent completed the upgrade to ${VERSION_B}"
else
  bad "the agent exited ${agent_status} applying ${VERSION_B}"
  report_agent_output
fi
# Kept, because ${agent_output} is overwritten by every later run and the only
# transcript that can say anything about how the upgrade was *launched* is this
# one. Asserting against the live file in section 10 read the contended
# lock run instead -- which never reaches the launcher at all, so the assertion
# passed with the scope removed entirely. A mutation proved it by surviving.
cp -- "${agent_output}" "${WORK}/agent-upgrade.out"
grep -Fq 'AGENT FETCHED install.sh FROM main' "${agent_output}" \
  && bad "the agent fetched install.sh from main, which is a moving ref" \
  || pass "the agent never fetched install.sh from main"
[[ "$(installed_commit)" == "${COMMIT_B}" ]] \
  && pass "the installed source commit is now ${COMMIT_B:0:12}" \
  || bad "the installed source commit is '$(installed_commit)'"
[[ "$(installed_marker)" == "${VERSION_B}" ]] \
  && pass "the installed source tree is ${VERSION_B}" \
  || bad "the installed source tree is '$(installed_marker)'"
[[ "$(display_name_columns)" == "1" ]] \
  && pass "B's forward-only migration ran against the preserved database" \
  || bad "B's migration did not reach the database"
[[ "$(psql_value "select display_name from harness_account where id = 2")" == "migrated:${PROBE_EMAIL}" ]] \
  && pass "the migration backfilled a row seeded before the agent ran" \
  || bad "the backfilled value is '$(psql_value "select display_name from harness_account where id = 2")'"
[[ "$(durable_record)" == *'"phase":"healthy"'* ]] \
  && pass "the durable record reports healthy" \
  || bad "the durable record reports '$(durable_record)'"
[[ "$(in_tree_record)" == *'"phase":"healthy"'* ]] \
  && pass "the in-tree record a dashboard would read reports healthy" \
  || bad "the in-tree record reports '$(in_tree_record)'"
[[ "$(durable_record)" == *"\"targetCommit\":\"${COMMIT_B}\""* ]] \
  && pass "the record names the commit it applied" \
  || bad "the record does not name ${COMMIT_B:0:12}"
# Trap 1, from the other end: the agent's own file survived an upgrade that
# renamed the installation directory out from under the running process.
[[ -x "${AGENT}" ]] && cmp -s "${AGENT_SOURCE}" "${AGENT}" \
  && pass "the agent binary survived the upgrade that replaced the installation" \
  || bad "the agent binary did not survive its own upgrade"
[[ ! -e "${INSTALL_DIR}/scripts/orcasynapse-update-agent.sh" ]] \
  && pass "the release tree the agent replaced carried no copy of the agent to run from" \
  || bad "the agent could have been running from inside the replaced tree"

# ---------------------------------------------------------------------------
# 5. The upgrade fails after its migrations have committed -- and stays failed
# ---------------------------------------------------------------------------
# install.sh rolls itself back; what is asserted here is that the agent notices,
# confirms the machine is serving again, and says so where it can be found.
printf '\n=== an approved release that fails after migrating ===\n'
reset_to_a "before the post-migration failure" || true
set_target "${VERSION_B}" "${COMMIT_B}"
run_agent "AGENT_TEST_FAIL_AFTER_MIGRATE=${VERSION_B}"
(( agent_status != 0 )) \
  && pass "the agent reported the failed upgrade (exit ${agent_status})" \
  || { bad "the agent exited 0 despite an upgrade that failed after migrating"; report_agent_output; }
[[ "$(installed_commit)" == "${COMMIT_A}" ]] \
  && pass "the deployment is back on ${VERSION_A} without anyone opening a shell" \
  || bad "the deployment is on '$(installed_commit)' after a failed upgrade"
[[ "$(display_name_columns)" == "0" ]] \
  && pass "the forward-only schema change was undone with it" \
  || bad "B's column survived, so the database is not back at A"
[[ "$(psql_value "select count(*) from harness_account")" == "4" ]] \
  && pass "every seeded row survived the round trip" \
  || bad "the account count is '$(psql_value "select count(*) from harness_account")', expected 4"
[[ "$(durable_record)" == *'"phase":"rolled-back"'* ]] \
  && pass "the durable record reports a rollback rather than a stall" \
  || bad "the durable record reports '$(durable_record)'"
[[ "$(durable_record)" == *'install.sh: rolled-back'* ]] \
  && pass "the record repeats what install.sh recorded about its own rollback" \
  || bad "the record does not carry install.sh's rollback outcome: $(durable_record)"

# The timer fires again in ten minutes, and the row it reads has not changed.
# Without a block that is a loop: upgrade, fail, restore the database from the
# dump, repeat -- so the rollback that exists to protect the data becomes the
# thing overwriting it every ten minutes. The machine has to *stay* on the
# working version, not merely reach it.
printf '\n=== the same failed target is not tried again on the next tick ===\n'
handoffs_before="$(grep -c . "${INSTALL_DIR}/.local/state/harness-handoff.log" || true)"
run_agent
(( agent_status == 0 )) \
  && pass "the next tick exited 0 without acting" \
  || { bad "the next tick exited ${agent_status}"; report_agent_output; }
[[ "$(durable_record)" == *'"phase":"blocked"'* ]] \
  && pass "the record says the target is blocked and why" \
  || bad "the record reports '$(durable_record)'"
[[ "$(grep -c . "${INSTALL_DIR}/.local/state/harness-handoff.log" || true)" == "${handoffs_before}" ]] \
  && pass "no installer ran on the blocked tick" \
  || bad "the blocked tick ran the installer again, so the timer is a rollback loop"
[[ "$(installed_commit)" == "${COMMIT_A}" ]] \
  && pass "the deployment stayed on ${VERSION_A}" \
  || bad "the blocked tick moved the deployment to '$(installed_commit)'"
# Re-approving is a deliberate retry: the row's revision moves, and the block
# is keyed on it. Asserted by the next scenario, which re-approves B and is
# expected to act.

# ---------------------------------------------------------------------------
# 6. A release that installs cleanly and then does not serve
# ---------------------------------------------------------------------------
# The failure install.sh cannot catch: it returned zero, discarded its retained
# tree, and the deployment then failed to answer. Recovery here is the agent's,
# and it is the documented runbook performed without an operator.
printf '\n=== an approved release that installs and then never becomes ready ===\n'
reset_to_a "before the health-gate failure" || true
set_target "${VERSION_B}" "${COMMIT_B}"
AGENT_READY_TIMEOUT=25 run_agent "AGENT_TEST_UNHEALTHY=${VERSION_B}"
(( agent_status != 0 )) \
  && pass "the agent reported the release that never became ready (exit ${agent_status})" \
  || { bad "the agent exited 0 for a release that never answered /readyz"; report_agent_output; }
[[ "$(installed_commit)" == "${COMMIT_A}" ]] \
  && pass "the agent restored ${VERSION_A} on its own health gate" \
  || bad "the deployment is on '$(installed_commit)' after failing its health gate"
[[ "$(display_name_columns)" == "0" ]] \
  && pass "the agent's recovery restored the pre-upgrade database too" \
  || bad "B's column survived the agent's recovery"
[[ "$(psql_value "select count(*) from harness_account")" == "4" ]] \
  && pass "the seeded rows survived the agent's own recovery" \
  || bad "the account count is '$(psql_value "select count(*) from harness_account")', expected 4"
[[ "$(durable_record)" == *'"phase":"rolled-back"'* ]] \
  && pass "the agent's record reports the recovery it performed" \
  || bad "the agent's record reports '$(durable_record)'"
[[ "$(durable_record)" == *'reinstalled'* ]] \
  && pass "the record says which release it put back" \
  || bad "the record does not say what was reinstalled: $(durable_record)"
/usr/bin/curl --fail --silent --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/readyz" >/dev/null \
  && pass "the deployment is answering /readyz again on the previous release" \
  || bad "the deployment is not answering /readyz after the agent's recovery"

# ---------------------------------------------------------------------------
# 7. Trap 2: the record never reads as stalled while the API is expected down
# ---------------------------------------------------------------------------
printf '\n=== the record distinguishes restarting from stalled ===\n'
[[ "$(durable_record)" == *'"apiUnavailableUntil":"2'* ]] \
  && pass "the record carries the moment the API's unavailability budget expires" \
  || bad "the record carries no unavailability budget: $(durable_record)"
[[ "$(durable_record)" != *'"phase":"upgrading"'* ]] \
  && pass "no finished run was left reporting 'upgrading'" \
  || bad "a finished run left the record reporting an upgrade still in progress"

# ---------------------------------------------------------------------------
# 8. A malformed target is refused before anything is downloaded
# ---------------------------------------------------------------------------
printf '\n=== a target that is not a commit is refused ===\n'
before_commit="$(installed_commit)"
psql_run "update \"PlatformReleaseTarget\" set \"desiredVersion\" = 'v9.9.9',
  \"desiredCommit\" = 'not-a-commit' where \"id\" = 'global';"
run_agent
(( agent_status != 0 )) \
  && pass "the agent refused a target that is not a 40-character commit" \
  || { bad "the agent accepted 'not-a-commit' as a release target"; report_agent_output; }
[[ "$(installed_commit)" == "${before_commit}" ]] \
  && pass "nothing on the host changed" \
  || bad "the installed commit moved to '$(installed_commit)' for a malformed target"
[[ "$(durable_record)" == *'"phase":"failed"'* ]] \
  && pass "the refusal is on disk as a failure" \
  || bad "the refusal produced '$(durable_record)'"
# The refusal has to happen before the agent announces an upgrade, not after.
# A second guard inside download_installer catches a malformed commit too, so
# "nothing was installed" passes either way -- what distinguishes them is
# whether a target that could never be applied was allowed to move the record
# into the upgrading phase and publish an unavailability budget for it.
[[ "$(durable_record)" == *'"startedAt":""'* ]] \
  && pass "the agent never announced an upgrade for a target it could not use" \
  || bad "the agent started an upgrade for a malformed target before refusing it: $(durable_record)"

# ---------------------------------------------------------------------------
# 9. Two runs cannot overlap
# ---------------------------------------------------------------------------
printf '\n=== a second run leaves the first alone ===\n'
set_target "${VERSION_B}" "${COMMIT_B}"
install -d -m 0700 "${STATE_DIR}"
flock "${STATE_DIR}/agent.lock" sleep 20 &
lock_holder=$!
sleep 1
run_agent
if (( agent_status == 0 )) && grep -Fq 'another update run holds the lock' "${agent_output}"; then
  pass "the contended run exited 0 and did nothing"
else
  bad "the contended run exited ${agent_status} without reporting the lock"
  report_agent_output
fi
[[ "$(installed_commit)" == "${before_commit}" ]] \
  && pass "the contended run installed nothing" \
  || bad "the contended run installed '$(installed_commit)'"
kill "${lock_holder}" >/dev/null 2>&1 || true
wait "${lock_holder}" 2>/dev/null || true
set_target "" ""

# ---------------------------------------------------------------------------
# 10. Trap 1, proven directly: a transient scope outlives its unit
# ---------------------------------------------------------------------------
# The mechanism, not the agent. A oneshot service is started, told to launch work
# the way run_detached does, and then stopped while that work is still running.
# The control -- the same probe without the scope -- is what makes the positive
# result mean anything: without it, a marker that appears proves only that the
# stop was slow.
printf '\n=== work launched in a transient scope survives its unit being stopped ===\n'
if [[ -d /run/systemd/system ]] && command -v systemd-run >/dev/null 2>&1; then
  probe_scoped="${WORK}/probe-scoped.sh"
  probe_plain="${WORK}/probe-plain.sh"
  cat > "${probe_scoped}" <<PROBE
#!/usr/bin/env bash
systemd-run --scope --quiet --collect -- bash -c 'sleep 8; : > "${WORK}/scoped.marker"'
PROBE
  cat > "${probe_plain}" <<PROBE
#!/usr/bin/env bash
bash -c 'sleep 8; : > "${WORK}/plain.marker"'
PROBE
  chmod 0755 "${probe_scoped}" "${probe_plain}"
  rm -f -- "${WORK}/scoped.marker" "${WORK}/plain.marker"

  systemd-run --unit=orcasynapse-detach-probe-scoped --quiet --collect \
    --service-type=simple /usr/bin/env bash "${probe_scoped}" >/dev/null 2>&1 || true
  systemd-run --unit=orcasynapse-detach-probe-plain --quiet --collect \
    --service-type=simple /usr/bin/env bash "${probe_plain}" >/dev/null 2>&1 || true
  sleep 2
  systemctl stop orcasynapse-detach-probe-scoped.service >/dev/null 2>&1 || true
  systemctl stop orcasynapse-detach-probe-plain.service >/dev/null 2>&1 || true
  sleep 10

  [[ -f "${WORK}/scoped.marker" ]] \
    && pass "work in a transient scope finished after its unit was stopped" \
    || bad "the transient scope did not protect the work, so an upgrade could be killed mid-run"
  [[ ! -f "${WORK}/plain.marker" ]] \
    && pass "the same work inside the unit's own cgroup was killed, which is what the scope avoids" \
    || bad "the control probe also survived, so this scenario proves nothing about scopes"
  systemctl reset-failed orcasynapse-detach-probe-scoped.service >/dev/null 2>&1 || true
  systemctl reset-failed orcasynapse-detach-probe-plain.service >/dev/null 2>&1 || true
  # The transcript of the run that actually launched an upgrade, not whichever
  # run happened to be last.
  grep -Fq 'no usable systemd scope' "${WORK}/agent-upgrade.out" \
    && bad "the agent fell back to running the upgrade inside its own unit on a systemd host" \
    || pass "the agent used systemd scopes rather than falling back"
else
  pass "this host has no systemd, so the scope mechanism is correctly not exercised"
fi

# ---------------------------------------------------------------------------
# 11. Containment
# ---------------------------------------------------------------------------
printf '\n=== this run left nothing behind ===\n'
teardown_stack
docker ps -a --format '{{.Names}}' | sort > "${WORK}/containers.after"
docker volume ls --format '{{.Name}}' | sort > "${WORK}/volumes.after"
docker network ls --format '{{.Name}}' | sort > "${WORK}/networks.after"
for kind in containers volumes networks; do
  if diff -q "${WORK}/${kind}.before" "${WORK}/${kind}.after" >/dev/null; then
    pass "the host's ${kind} are exactly the set this run started with"
  else
    bad "the host's ${kind} changed across this run:"
    diff "${WORK}/${kind}.before" "${WORK}/${kind}.after" >&2 || true
  fi
done
[[ ! -e /etc/systemd/system/orcasynapse-update.service ]] \
  && pass "this run installed no production update unit" \
  || bad "an orcasynapse-update.service exists; this harness must never write one"
[[ "${INSTALL_DIR}" == /var/tmp/orcasynapse-update-agent-test.* ]] \
  && pass "every file this run created lives under ${WORK}, which the EXIT handler removes" \
  || bad "the install directory was outside the temporary work tree: ${INSTALL_DIR}"

printf '\n'
if (( failures > 0 )); then
  printf 'OrcaSynapse update agent test FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'OrcaSynapse update agent test passed.\n'
