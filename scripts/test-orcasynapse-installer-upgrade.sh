#!/usr/bin/env bash
# Drives a real A -> B -> A round trip of a control plane through install.sh.
#
# The VM1 smoke test installs once, from nothing, and refuses to run when an
# installation already exists. The backup suite next to this one exercises the
# upgrade path only as far as the pre-migration dump, and stubs the handoff so
# that no migration ever runs. Neither of them answers the question that decides
# whether an operator can be given an update button: an installation at one
# version, holding real rows, moved to another version whose migrations run
# against those rows -- and then the same thing again with the upgrade failing
# after those migrations have already been committed.
#
# That last case is the whole reason this file exists. Everything before it is
# table stakes.
#
# ---------------------------------------------------------------------------
# Design decision 1: how "version B" is faked, and what that costs
# ---------------------------------------------------------------------------
# Two staged release trees, A and B, differing in exactly four things: the
# version constant in packages/contracts/src/version.ts, the commit written into
# .orcasynapse-source-commit, a release-marker file naming the tree, and the set
# of forward-only migrations under .orcasynapse-migrations/. Both carry the same
# stub host installer, which stands in for scripts/install-orcasynapse.sh.
#
# The stub is deliberately more than the backup suite's marker-writer. It does
# the four things the real host installer does that this harness depends on:
# generates the protected secrets on a fresh install, brings PostgreSQL up
# through Compose, applies its own tree's un-applied migrations against the live
# database inside the container, and writes the completion receipt and schema
# epoch. So the migration that runs during an upgrade here is real SQL, executed
# by the tree that was just installed, against a real postgres:17-bookworm
# holding rows seeded before the upgrade began.
#
# What that therefore does NOT prove:
#   * No application image is built and no api, web, worker or migrate container
#     ever runs. Nothing here says the application boots on schema B.
#   * The migrations applied are this harness's own two statements, not the
#     four in packages/database/drizzle/migrations. This proves the *mechanism*
#     -- a different source tree replaces the old one and its migrations reach
#     preserved data -- not that any two real releases are compatible.
#   * The real scripts/install-orcasynapse.sh is not executed, so its preflight,
#     image build, readiness wait and administrator provisioning are untested
#     here. The smoke test covers those on the fresh-install path only.
# The alternative -- two real release tarballs and three image builds -- would
# have cost tens of minutes per run and still not covered the failure case,
# because a real release cannot be asked to fail after migrating on demand.
#
# ---------------------------------------------------------------------------
# Design decision 2: how a post-migration failure is induced reproducibly
# ---------------------------------------------------------------------------
# UPGRADE_TEST_FAIL_AFTER_MIGRATE=<version> makes that tree's stub exit 1 -- but only after it
# has re-queried information_schema on a fresh connection and confirmed that the
# column B's migration adds is actually there. If it is not, the stub exits 3
# instead, and the harness treats a 3 as a broken test rather than a caught
# regression. The failure therefore cannot race the migration it is supposed to
# follow: the injection point is asserted from inside the injector.
#
# UPGRADE_TEST_FAIL_BEFORE_MIGRATE is the contrast case, injected after the
# database is up but before a single migration is applied.
#
# Both name the version they apply to rather than being booleans, because the
# rollback re-runs the *restored* tree's own host installer: an inherited `=1`
# would fail that run too, and the machine would never come back.
#
# ---------------------------------------------------------------------------
# Design decision 3: what "restored" means now
# ---------------------------------------------------------------------------
# Until increment 4, install.sh restored nothing after a post-migration failure:
# its source backup was deleted by upgrade_source_tree the instant the swap
# succeeded, so the EXIT handler's restore covered the few milliseconds between
# the two mv calls and a failure at the handoff -- which is where migrations run
# -- left the new source over the new schema. Recovery was operator-driven, and
# this harness drove it by hand out of docs/DATABASE_RESTORE_RUNBOOK.md.
#
# install.sh now retains that backup until the handoff has succeeded, and rolls
# it back when the handoff fails: dump restored if the schema moved, previous
# source tree moved back, previous release restarted through its own installer.
# Scenario 5 is that, asserted end to end, and the assertion that used to read
# "install.sh restored nothing by itself" now reads that it did.
#
# The one judgement in it, asserted from two directions rather than trusted:
# the database is restored only when the schema fingerprint moved. Scenario 5
# fails after migrating, so it moved, so the dump goes back and a row written
# during the upgrade is lost -- the accepted cost, asserted so that it is a
# decision and not a surprise. Scenario 6 fails before migrating, so it did not
# move, so the database is untouched and that same row survives. A rollback that
# restored unconditionally would pass scenario 5 and fail scenario 6, which is
# the point: the most likely upgrade failure of all is an image build that never
# reached the database, and discarding a customer's writes for one of those
# would be the feature doing more harm than the bug.
#
# Scenario 7 keeps the operator's escape hatch honest by asserting that
# ORCASYNAPSE_UPGRADE_ROLLBACK=off still leaves the failed state in place, and
# then recovers from it exactly as the runbook says -- which is also how this
# harness gets an installation back to A without tearing the database down.
#
# ---------------------------------------------------------------------------
# Design decision 4: where this runs
# ---------------------------------------------------------------------------
# The `install` job in .github/workflows/verify.yml, beside the smoke and backup
# suites, because it needs root and a live Docker daemon and that job already
# has both. It builds no image: one postgres:17-bookworm and roughly a minute
# for eight installs, which is less than a separate job would spend starting a
# runner. Nothing cheaper can host it -- without a real database there is no
# migration to fail after.
#
# install.sh is run as a subprocess and never sourced, so this file keeps its
# own EXIT handler throughout. A suite that sources the script under test has to
# re-install its trap afterwards or every later assertion is silently disabled;
# scripts/test-agentic-installer-recovery.sh is the one that has to.
#
# ---------------------------------------------------------------------------
# Containment
# ---------------------------------------------------------------------------
# Compose project orcasynapse-upgrade-test, no published ports, an internal
# network, and an installation directory under /var/tmp. A real /opt/orcasynapse
# stack on the same host shares none of those, and the run ends by asserting
# that the host's containers, volumes and networks are byte-for-byte the set it
# started with.
#
# Needs root and a reachable Docker daemon. Builds no images.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The script under test. Overridable only so that this harness can be pointed at
# a deliberately broken copy of install.sh outside the repository and watched to
# fail; a harness nobody has seen fail is not evidence. Nothing in CI sets it.
INSTALLER="${ORCASYNAPSE_UPGRADE_TEST_INSTALLER:-${ROOT}/install.sh}"

WORK="$(mktemp -d /var/tmp/orcasynapse-upgrade-test.XXXXXX)"
PROJECT="orcasynapse-upgrade-test"
INSTALL_PARENT="${WORK}/opt"
INSTALL_DIR="${INSTALL_PARENT}/orcasynapse"
BACKUPS_DIR="${INSTALL_DIR}/.local/state/backups"
SECRETS_DIR="${INSTALL_DIR}/.local/secrets"
SHIM_DIR="${WORK}/shims"
STUB="${WORK}/host-installer-stub.sh"

# Deliberately at the far end of the version space and deliberately fictional.
# Nothing here reads the repository's own ORCASYNAPSE_VERSION, and nobody should
# ever "keep these in step" with a release: A and B are fixtures, and a fixture
# that happens to equal the current release invites exactly that edit.
VERSION_A="v9.9.8"
VERSION_B="v9.9.9"
# 40 hex characters each, so install.sh's resolve_commit short-circuits and this
# harness never reaches api.github.com.
COMMIT_A="a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"
COMMIT_B="b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"
RELEASE_A="${WORK}/release-a/orcasynapse-release"
RELEASE_B="${WORK}/release-b/orcasynapse-release"
ARCHIVE_A="${WORK}/release-a.tar.gz"
ARCHIVE_B="${WORK}/release-b.tar.gz"
SHA_A=""
SHA_B=""

PROBE_EMAIL="grace@orcasynapse-upgrade-probe.test"
installer_output="${WORK}/installer.out"
installer_status=0
failures=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

# Removes this project and nothing else. Every filter is the Compose project
# label, so there is no expression here that could match a real orcasynapse
# stack even if the install directory were gone by the time this ran.
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
  teardown_stack
  # The captured installer output holds no secret -- the stub prints none and
  # install.sh's UI logging contract keeps them out of ui_* helpers -- but the
  # generated database password is inside the work tree, so the whole tree goes.
  rm -rf -- "${WORK}"
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || { echo "run as root: sudo bash scripts/test-orcasynapse-installer-upgrade.sh" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "this test needs a reachable Docker daemon" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "this test needs Docker Compose v2" >&2; exit 2; }
[[ -r "${INSTALLER}" ]] || { echo "no installer to test at ${INSTALLER}" >&2; exit 2; }

compose() { docker compose --project-directory "${INSTALL_DIR}" "$@"; }

# No pipeline, so a psql that fails cannot be reported as the pipe's status, and
# no unguarded command substitution, so a failed query cannot end the run under
# errexit before the assertion that was about to explain it.
psql_value() {
  local out=""
  out="$(compose exec -T postgres psql -U orcasynapse -d orcasynapse -tAc "$1" </dev/null 2>/dev/null)" || out=""
  out="${out//[$'\r\n\t ']/}"
  printf '%s' "${out}"
}

psql_run() {
  compose exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q -c "$1" \
    </dev/null >/dev/null
}

# ---------------------------------------------------------------------------
# Host state, recorded before anything is created
# ---------------------------------------------------------------------------
printf '\n=== recording the host state this run must leave unchanged ===\n'
docker ps -a --format '{{.Names}}' | sort > "${WORK}/containers.before"
docker volume ls --format '{{.Name}}' | sort > "${WORK}/volumes.before"
docker network ls --format '{{.Name}}' | sort > "${WORK}/networks.before"
pass "host has $(wc -l < "${WORK}/containers.before") container(s) and $(wc -l < "${WORK}/volumes.before") volume(s) before this run"

# ---------------------------------------------------------------------------
# The two release trees
# ---------------------------------------------------------------------------
write_compose_file() {
  cat > "$1" <<'COMPOSE'
name: orcasynapse-upgrade-test

# PostgreSQL only, and deliberately close to the real compose.yaml where this
# harness depends on it: the secret file the dump reads inside the container,
# the database and role names install.sh derives from the URL secret, and a TCP
# healthcheck for the reason the real file states -- the initdb-phase server
# answers on the socket while the port still refuses.
#
# No published port and a project name of its own, so a real orcasynapse stack
# on this host is neither adopted nor collided with.
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

# Stands in for scripts/install-orcasynapse.sh: the script install.sh hands off
# to, and the place the migrate service runs. Identical in both release trees --
# the difference between A and B is the tree's migrations, not its installer,
# which is what makes a migration here a property of the release rather than of
# the test.
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

# The real installer generates these once and preserves them on every later run.
# Regenerating them on an upgrade would leave the file disagreeing with the
# password inside the existing data volume, so the guard is the behaviour, not
# an optimisation.
if [[ ! -s "${stub_root}/.local/secrets/postgres_password" ]]; then
  password="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
  printf '%s' "${password}" > "${stub_root}/.local/secrets/postgres_password"
  chmod 0600 "${stub_root}/.local/secrets/postgres_password"
  printf 'postgresql://orcasynapse:%s@postgres:5432/orcasynapse' "${password}" \
    > "${stub_root}/.local/secrets/orcasynapse_database_url"
  chmod 0640 "${stub_root}/.local/secrets/orcasynapse_database_url"
  printf 'stub host installer: generated protected secrets\n'
fi

dc up -d --no-build postgres >/dev/null 2>&1 || dc up -d postgres
deadline=$((SECONDS + 180))
until dc exec -T postgres pg_isready -h 127.0.0.1 -U orcasynapse -d orcasynapse >/dev/null 2>&1; do
  (( SECONDS < deadline )) || { printf 'stub host installer: PostgreSQL never became ready\n' >&2; exit 1; }
  sleep 2
done

# A write taken while the upgrade is in flight, standing in for the traffic a
# real deployment serves for the minutes `docker compose build` runs. It is the
# only thing that can tell "the database was restored" apart from "the database
# was left alone" when the schema is identical either way, which is exactly the
# case the rollback's fingerprint gate has to get right.
#
# Version-scoped for the same reason the failure injections below are: the
# rollback re-runs the *restored* tree's installer, and a flag that fired for
# every tree would have that run re-create the row whose absence is the
# assertion.
if [[ "${UPGRADE_TEST_WRITE_DURING_UPGRADE:-}" == "${version}" ]]; then
  printf 'stub host installer: writing live row %s while %s installs\n' "${UPGRADE_TEST_WRITE_ID:-0}" "${version}"
  psql_run -c "insert into harness_live_write (id, note)
    values (${UPGRADE_TEST_WRITE_ID:-0}, 'written while ${version} was installing')
    on conflict (id) do nothing;" </dev/null
fi

# Named by version rather than set to 1. The rollback introduced by increment 4
# re-runs the restored tree's own host installer, so a boolean flag inherited
# from the environment would fail that run too and the machine would never come
# back -- a test artefact indistinguishable from the bug the rollback exists to
# prevent. Naming the release makes the failure a property of that release,
# which is what it is meant to model.
if [[ "${UPGRADE_TEST_FAIL_BEFORE_MIGRATE:-}" == "${version}" ]]; then
  printf 'stub host installer: inducing a failure before any migration ran\n' >&2
  exit 1
fi

# Forward-only, tracked by name, applied in lexical order -- the same contract as
# packages/database/drizzle/migrations, in miniature. A tree re-applied over a
# database that already has its migrations is a no-op, which is what makes
# reinstalling A over a restored A dump safe.
psql_run -c "create table if not exists _harness_schema_migrations (
  name text primary key, applied_at timestamptz not null default now());" </dev/null
shopt -s nullglob
for sql in "${stub_root}/.orcasynapse-migrations"/*.sql; do
  name="$(basename -- "${sql}")"
  if [[ "$(psql_value "select count(*) from _harness_schema_migrations where name = '${name}'")" != "0" ]]; then
    printf 'stub host installer: %s already applied\n' "${name}"
    continue
  fi
  printf 'stub host installer: applying %s\n' "${name}"
  psql_run -f - < "${sql}"
  psql_run -c "insert into _harness_schema_migrations (name) values ('${name}');" </dev/null
done
shopt -u nullglob

if [[ "${UPGRADE_TEST_FAIL_AFTER_MIGRATE:-}" == "${version}" ]]; then
  # The injection point is asserted from inside the injector: the column B's
  # migration adds is read back on a fresh connection before the failure is
  # raised, so "after the migrations have run" is a checked fact rather than a
  # hope about ordering. Exit 3 -- distinct from the induced 1 -- means the
  # harness pointed this at a tree that never migrated, which is a broken test
  # and not a caught regression.
  visible="$(psql_value "select count(*) from information_schema.columns
    where table_name = 'harness_account' and column_name = 'display_name'")"
  if [[ "${visible}" != "1" ]]; then
    printf 'stub host installer: post-migration failure requested but the migration is not visible\n' >&2
    exit 3
  fi
  printf 'stub host installer: inducing a failure after the migrations have run\n' >&2
  exit 1
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
  # In both trees. The baseline is what an installation at A is made of.
  #
  # harness_live_write exists at the baseline, in both trees, so that a row
  # written into it during an upgrade changes the data and not the schema. That
  # separation is the whole instrument for the rollback's fingerprint gate: a
  # probe that created its own table would move the fingerprint and make every
  # failure look like a migration.
  cat > "${dir}/.orcasynapse-migrations/001-baseline.sql" <<'SQL'
create table if not exists harness_account (
  id integer primary key,
  email text not null
);
create table if not exists harness_live_write (
  id integer primary key,
  note text not null
);
SQL
}

printf '\n=== staging release trees A (%s) and B (%s) ===\n' "${VERSION_A}" "${VERSION_B}"
stage_release_tree "${RELEASE_A}" "${VERSION_A}"
stage_release_tree "${RELEASE_B}" "${VERSION_B}"
# B only. An added column with a backfill is the shape that cannot be undone:
# dropping the column back does not restore what the update overwrote, which is
# precisely why the pre-migration dump is the only way back.
cat > "${RELEASE_B}/.orcasynapse-migrations/002-add-display-name.sql" <<'SQL'
alter table harness_account add column display_name text;
update harness_account set display_name = 'migrated:' || email where display_name is null;
SQL

tar -czf "${ARCHIVE_A}" -C "${WORK}/release-a" orcasynapse-release
tar -czf "${ARCHIVE_B}" -C "${WORK}/release-b" orcasynapse-release
SHA_A="$(sha256sum "${ARCHIVE_A}" | awk '{print $1}')"
SHA_B="$(sha256sum "${ARCHIVE_B}" | awk '{print $1}')"
[[ "${SHA_A}" != "${SHA_B}" ]] \
  && pass "A and B are genuinely different releases (${SHA_A:0:12} vs ${SHA_B:0:12})" \
  || bad "A and B staged to identical archives, so no upgrade could be observed"

# ---------------------------------------------------------------------------
# The one shim: codeload.github.com
# ---------------------------------------------------------------------------
install -d -m 0755 "${SHIM_DIR}"
cat > "${SHIM_DIR}/curl" <<'SHIM'
#!/usr/bin/env bash
# Stands in for codeload.github.com. install.sh asks for a HEAD and then a body;
# both are answered from the archive the caller nominated, which is how the same
# installer installs A in one run and B in the next.
archive="${UPGRADE_TEST_ARCHIVE:?the upgrade harness must nominate an archive}"
head=0
out=""
while (( $# )); do
  case "$1" in
    --head) head=1 ;;
    --output) out="$2"; shift ;;
  esac
  shift
done
if (( head )); then
  printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$(stat -c '%s' "${archive}")"
  exit 0
fi
[[ -n "${out}" ]] || exit 1
cp -- "${archive}" "${out}"
SHIM
chmod 0755 "${SHIM_DIR}/curl"
pass "curl shim staged; nothing in this run reaches the network"

# ---------------------------------------------------------------------------
# Harness plumbing
# ---------------------------------------------------------------------------
# Both helpers survive a backups directory that does not exist, which is the
# state before the first upgrade. `find` on a missing path exits 1 even with its
# stderr discarded, and an unguarded `dump="$(newest_dump)"` would then end the
# whole run under errexit -- the failure that once silently skipped sixty of the
# backup suite's sixty-five assertions.
list_dumps() {
  local line
  DUMPS=()
  [[ -d "${BACKUPS_DIR}" ]] || return 0
  while IFS= read -r line; do
    if [[ -n "${line}" ]]; then DUMPS+=("${line}"); fi
  done < <(find "${BACKUPS_DIR}" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -k1,1rn || true)
}

dump_count() {
  list_dumps
  printf '%d' "${#DUMPS[@]}"
}

# No `head` in the pipeline: it exits at the first line, the sort ahead of it
# dies on the broken pipe, and under pipefail the newest dump would be reported
# as a failure to find one.
newest_dump() {
  list_dumps
  (( ${#DUMPS[@]} > 0 )) || return 0
  printf '%s' "${DUMPS[0]#* }"
}

report_installer_output() {
  printf '  ---- installer output (last 30 lines) ----\n' >&2
  tail -n 30 "${installer_output}" >&2 || true
  printf '  ------------------------------------------\n' >&2
}

# archive, sha, commit, then any number of NAME=VALUE overrides.
run_installer() {
  local archive="$1" sha="$2" commit="$3"
  shift 3
  : > "${installer_output}"
  chmod 0600 "${installer_output}"
  set +e
  env PATH="${SHIM_DIR}:${PATH}" \
    TERM=dumb \
    UPGRADE_TEST_ARCHIVE="${archive}" \
    ORCASYNAPSE_INSTALL_DIR="${INSTALL_DIR}" \
    ORCASYNAPSE_REF="${commit}" \
    ORCASYNAPSE_ARCHIVE_SHA256="${sha}" \
    "$@" \
    bash "${INSTALLER}" </dev/null >"${installer_output}" 2>&1
  installer_status=$?
  set -e
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

receipt_version() {
  local receipt="${INSTALL_DIR}/.local/state/install-complete.json"
  [[ -r "${receipt}" ]] || { printf ''; return 0; }
  sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "${receipt}" | head -n 1
}

display_name_columns() {
  psql_value "select count(*) from information_schema.columns
    where table_name = 'harness_account' and column_name = 'display_name'"
}

applied_migrations() {
  psql_value "select coalesce(string_agg(name, ',' order by name), '') from _harness_schema_migrations"
}

# The row the stub writes while an upgrade is in flight. 1 means the database
# was left alone; 0 means the pre-upgrade dump went back over it.
live_write_rows() {
  psql_value "select count(*) from harness_live_write where id = $1"
}

# install.sh's rollback record, or the empty string when it never wrote one.
rollback_record() {
  local path="${INSTALL_DIR}/.local/state/last-upgrade-rollback.json"
  [[ -r "${path}" ]] || { printf ''; return 0; }
  tr -d '\r\n' < "${path}"
}

# Working directories left beside the installation. A successful upgrade must
# leave no retained source backup: one per release would put a full copy of
# every version the machine ever ran next to the one it is running.
#
# Built the same way list_dumps is, and for the same two reasons: `find` on a
# missing parent exits 1 even with its stderr discarded, and a `| wc -l` would
# make that failure the pipeline's under pipefail -- the trap that once skipped
# sixty assertions in the backup suite.
leftover_directories() {
  local pattern="$1" line
  local -a found=()
  if [[ -d "${INSTALL_PARENT}" ]]; then
    while IFS= read -r line; do
      if [[ -n "${line}" ]]; then found+=("${line}"); fi
    done < <(find "${INSTALL_PARENT}" -maxdepth 1 -type d -name "${pattern}" 2>/dev/null || true)
  fi
  printf '%d' "${#found[@]}"
}

# Every assertion that a deployment "is at version X" asks all four surfaces,
# because they are written by four different steps: the tarball's own file, the
# marker install.sh stages, the receipt the handoff writes, and the schema the
# handoff migrated. A mutation that moves one and not the rest is exactly the
# class of upgrade bug that reaches a customer.
assert_deployment_at() {
  local label="$1" version="$2" commit="$3" expect_migrations="$4" expect_display="$5"
  local column_state="absent"
  # `if` rather than `[[ … ]] && column_state=…`: a false test is a failing
  # command, and errexit would end the run on the very assertion about to
  # explain why.
  if [[ "${expect_display}" == "1" ]]; then column_state="present"; fi
  [[ "$(installed_marker)" == "${version}" ]] \
    && pass "${label}: the installed source tree is ${version}" \
    || bad "${label}: the installed source tree is '$(installed_marker)', expected ${version}"
  [[ "$(installed_commit)" == "${commit}" ]] \
    && pass "${label}: the recorded source commit is ${commit:0:12}" \
    || bad "${label}: the recorded source commit is '$(installed_commit)', expected ${commit:0:12}"
  [[ "$(receipt_version)" == "${version}" ]] \
    && pass "${label}: the completion receipt reports ${version}" \
    || bad "${label}: the completion receipt reports '$(receipt_version)', expected ${version}"
  [[ "$(applied_migrations)" == "${expect_migrations}" ]] \
    && pass "${label}: the database has applied exactly ${expect_migrations}" \
    || bad "${label}: the database has applied '$(applied_migrations)', expected '${expect_migrations}'"
  [[ "$(display_name_columns)" == "${expect_display}" ]] \
    && pass "${label}: the B-only column is ${column_state}" \
    || bad "${label}: the B-only column count is '$(display_name_columns)', expected ${expect_display}"
}

# The rows seeded before any upgrade, asked for by value rather than by count
# alone: a migration that truncated the table and re-inserted three placeholder
# rows would satisfy a count.
assert_seeded_data_intact() {
  local label="$1"
  [[ "$(psql_value "select count(*) from harness_account")" == "3" ]] \
    && pass "${label}: all three seeded accounts are present" \
    || bad "${label}: the seeded account count is '$(psql_value "select count(*) from harness_account")', expected 3"
  [[ "$(psql_value "select email from harness_account where id = 2")" == "${PROBE_EMAIL}" ]] \
    && pass "${label}: the probe row still holds the value it was seeded with" \
    || bad "${label}: the probe row reads '$(psql_value "select email from harness_account where id = 2")'"
}

# ---------------------------------------------------------------------------
# 1. Install version A from nothing
# ---------------------------------------------------------------------------
printf '\n=== installing version %s from nothing ===\n' "${VERSION_A}"
run_installer "${ARCHIVE_A}" "${SHA_A}" "${COMMIT_A}"
if (( installer_status == 0 )); then
  pass "the fresh install of ${VERSION_A} completed"
else
  bad "the fresh install of ${VERSION_A} exited ${installer_status}"
  report_installer_output
  printf '\nOrcaSynapse upgrade test cannot continue without an installation at A.\n' >&2
  exit 1
fi
assert_deployment_at "after installing A" "${VERSION_A}" "${COMMIT_A}" "001-baseline.sql" "0"
for secret in postgres_password orcasynapse_database_url; do
  [[ -s "${SECRETS_DIR}/${secret}" ]] \
    && pass "after installing A: ${secret} was provisioned" \
    || bad "after installing A: ${secret} is missing"
done
[[ "$(dump_count)" == "0" ]] \
  && pass "after installing A: a fresh install took no dump, having nothing to dump" \
  || bad "after installing A: a fresh install produced $(dump_count) dump(s)"

# ---------------------------------------------------------------------------
# 2. Real data
# ---------------------------------------------------------------------------
printf '\n=== seeding real data into the installation at %s ===\n' "${VERSION_A}"
psql_run "insert into harness_account (id, email) values
  (1, 'ada@orcasynapse-upgrade-probe.test'),
  (2, '${PROBE_EMAIL}'),
  (3, 'alan@orcasynapse-upgrade-probe.test')
  on conflict (id) do nothing;" \
  || { bad "the seed data could not be written; nothing after this would mean anything"; exit 1; }
assert_seeded_data_intact "before any upgrade"
cp -- "${SECRETS_DIR}/postgres_password" "${WORK}/postgres_password.at-a"

# ---------------------------------------------------------------------------
# 3. Upgrade A -> B
# ---------------------------------------------------------------------------
printf '\n=== upgrading %s -> %s through the real upgrade path ===\n' "${VERSION_A}" "${VERSION_B}"
run_installer "${ARCHIVE_B}" "${SHA_B}" "${COMMIT_B}" ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade
if (( installer_status == 0 )); then
  pass "the upgrade to ${VERSION_B} completed"
else
  bad "the upgrade to ${VERSION_B} exited ${installer_status}"
  report_installer_output
fi
assert_deployment_at "after upgrading to B" "${VERSION_B}" "${COMMIT_B}" "001-baseline.sql,002-add-display-name.sql" "1"
assert_seeded_data_intact "after upgrading to B"
# The backfill is what proves B's migration reached A's rows rather than merely
# running against an empty table.
[[ "$(psql_value "select display_name from harness_account where id = 2")" == "migrated:${PROBE_EMAIL}" ]] \
  && pass "after upgrading to B: B's migration backfilled the row seeded at A" \
  || bad "after upgrading to B: the backfilled value is '$(psql_value "select display_name from harness_account where id = 2")'"
if cmp -s "${WORK}/postgres_password.at-a" "${SECRETS_DIR}/postgres_password"; then
  pass "after upgrading to B: the protected secrets survived the source swap"
else
  bad "after upgrading to B: the protected secrets did not survive the source swap"
fi
[[ -f "${INSTALL_DIR}/.local/state/harness-handoff.log" ]] \
  && pass "after upgrading to B: the host installer ran, so migrations really ran" \
  || bad "after upgrading to B: the host installer never ran"
# The other half of retaining the previous release past the swap. A successful
# upgrade has to throw it away, or every release the machine ever takes leaves a
# full copy of the source tree beside the one it is running.
[[ "$(leftover_directories '.orcasynapse.backup.*')" == "0" ]] \
  && pass "after upgrading to B: the retained pre-upgrade source tree was discarded" \
  || bad "after upgrading to B: $(leftover_directories '.orcasynapse.backup.*') retained source backup(s) remain, which would accumulate one per release"
# Which of the two things that discard it actually did. The EXIT handler removes
# a backup a successful run somehow still holds, as a last resort -- and that
# safety net makes the assertion above pass even when the success path's discard
# is gone entirely, which a mutation proved by surviving it. The net announces
# itself, so its silence is what says the success path did the work.
grep -Fq 'retained pre-upgrade source tree was left' "${installer_output}" \
  && bad "after upgrading to B: the EXIT handler had to clean up after the success path, which means the success path no longer discards its own backup" \
  || pass "after upgrading to B: the success path discarded the backup itself, without the EXIT handler's safety net"
[[ -z "$(rollback_record)" ]] \
  && pass "after upgrading to B: a successful upgrade wrote no rollback record" \
  || bad "after upgrading to B: a rollback record was written for an upgrade that succeeded: $(rollback_record)"

printf '\n=== the pre-upgrade dump exists and predates the migration ===\n'
upgrade_dump="$(newest_dump)"
if [[ -n "${upgrade_dump}" && -f "${upgrade_dump}" ]]; then
  pass "a pre-upgrade dump exists at ${upgrade_dump##*/}"
  case "$(basename -- "${upgrade_dump}")" in
    "${VERSION_A}"-*.sql.gz) pass "the dump is named for ${VERSION_A}, the release it was taken from" ;;
    *) bad "the dump name does not carry ${VERSION_A}: $(basename -- "${upgrade_dump}")" ;;
  esac
  # Decompressed to a file first: `gzip -cd | grep -q` under pipefail fails on a
  # *successful* match, because grep exits at the first hit and gzip dies on the
  # broken pipe.
  if gzip -cd -- "${upgrade_dump}" > "${WORK}/upgrade-dump.sql" 2>/dev/null; then
    grep -Fq -- "${PROBE_EMAIL}" "${WORK}/upgrade-dump.sql" \
      && pass "the dump contains the data that was in the database before the upgrade" \
      || bad "the dump does not contain the pre-upgrade data"
    # The ordering assertion, read out of the dump's own contents rather than
    # out of the installer's log. It is only meaningful paired with the positive
    # assertion above: an empty dump would satisfy this one on its own.
    if grep -Fq -- 'display_name' "${WORK}/upgrade-dump.sql"; then
      bad "the dump contains B's column, so it was taken after the migration rather than before it"
    else
      pass "the dump carries no trace of B's migration, so it was taken before it ran"
    fi
  else
    bad "the dump is not a readable gzip archive"
  fi
else
  bad "no pre-upgrade dump was written"
fi

receipt="${INSTALL_DIR}/.local/state/last-database-backup.json"
if [[ -s "${receipt}" ]]; then
  grep -q "\"fromCommit\":\"${COMMIT_A}\"" "${receipt}" \
    && pass "the backup record names A as the commit to go back to" \
    || bad "the backup record does not name ${COMMIT_A:0:12} as fromCommit"
  grep -q "\"toCommit\":\"${COMMIT_B}\"" "${receipt}" \
    && pass "the backup record names B as the commit being installed" \
    || bad "the backup record does not name ${COMMIT_B:0:12} as toCommit"
else
  bad "no backup record was written, so a recovery would have to guess the dump path"
fi

# ---------------------------------------------------------------------------
# 4. The documented recovery, driven exactly as the runbook writes it
# ---------------------------------------------------------------------------
# Two steps, in the runbook's order: restore the dump, then reinstall the commit
# the record names.
#
# This is no longer what a *failed* upgrade needs -- install.sh performs that
# itself now, and scenario 5 asserts it. What is left here is the case nothing
# automates and nothing should: deliberately putting a healthy deployment back
# onto an earlier release. It is also the reset step the smoke test lacks, which
# is how this harness gets an installation back to A between scenarios without
# tearing the database down and losing the point of the exercise.
recover_to_a() {
  local label="$1" dump="$2"
  if [[ -z "${dump}" || ! -f "${dump}" ]]; then
    bad "${label}: there was no dump to recover from"
    return 1
  fi
  if gzip -cd -- "${dump}" > "${WORK}/restore.sql" 2>/dev/null \
    && compose exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q \
      < "${WORK}/restore.sql" > "${WORK}/restore.out" 2>&1; then
    pass "${label}: the documented restore command completed"
  else
    bad "${label}: the documented restore command failed"
    tail -n 20 "${WORK}/restore.out" >&2 || true
    return 1
  fi
  run_installer "${ARCHIVE_A}" "${SHA_A}" "${COMMIT_A}" ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade
  if (( installer_status == 0 )); then
    pass "${label}: reinstalling the commit the backup record names completed"
  else
    bad "${label}: reinstalling ${COMMIT_A:0:12} exited ${installer_status}"
    report_installer_output
    return 1
  fi
  return 0
}

printf '\n=== the documented recovery returns a healthy deployment to %s ===\n' "${VERSION_A}"
recover_to_a "recovery from a successful upgrade" "${upgrade_dump}" || true
assert_deployment_at "after recovering to A" "${VERSION_A}" "${COMMIT_A}" "001-baseline.sql" "0"
assert_seeded_data_intact "after recovering to A"

# ---------------------------------------------------------------------------
# 5. An upgrade that fails AFTER its migrations have run -- and restores itself
# ---------------------------------------------------------------------------
# The scenario the whole increment exists for, and the one an operator used to
# absorb at a shell. Nothing below drives a recovery: install.sh is expected to
# have done all of it before it returned.
printf '\n=== an upgrade that fails after migrating restores the previous release ===\n'
dump_before_failure="$(newest_dump)"
# Counted, not merely looked for. "The deployment came back on the previous
# release" means its host installer ran again *after* the failure, and the
# restored tree's handoff log already ends with a line from A -- the recovery in
# scenario 4 put it there. Only the count moves when the rollback restarts the
# stack, so only the count can tell a rollback that restarted it apart from one
# that put the files back and walked away.
handoff_log="${INSTALL_DIR}/.local/state/harness-handoff.log"
handoffs_before=0
if [[ -r "${handoff_log}" ]]; then handoffs_before="$(grep -c . "${handoff_log}" || true)"; fi
run_installer "${ARCHIVE_B}" "${SHA_B}" "${COMMIT_B}" \
  ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade \
  "UPGRADE_TEST_FAIL_AFTER_MIGRATE=${VERSION_B}" \
  "UPGRADE_TEST_WRITE_DURING_UPGRADE=${VERSION_B}" UPGRADE_TEST_WRITE_ID=5
if (( installer_status == 3 )); then
  bad "the failure was injected before the migration was visible, so this scenario proved nothing"
  report_installer_output
elif (( installer_status != 0 )); then
  pass "the installer reported the failed upgrade (exit ${installer_status})"
else
  bad "the installer exited 0 despite the induced post-migration failure"
  report_installer_output
fi
# Read out of the transcript rather than out of the database, because the
# database has by now been put back: this is the proof that the failure really
# was after the migration, which the database can no longer show.
grep -Fq 'inducing a failure after the migrations have run' "${installer_output}" \
  && pass "the failure was injected after B's migration had been read back as visible" \
  || { bad "the transcript does not show the post-migration injection, so the scenario proved nothing"; report_installer_output; }

# The assertion this increment had to flip. It used to read "install.sh restored
# nothing by itself", and it was the honest description of the product.
assert_deployment_at "after the automatic rollback" "${VERSION_A}" "${COMMIT_A}" "001-baseline.sql" "0"
assert_seeded_data_intact "after the automatic rollback"
[[ "$(display_name_columns)" == "0" ]] \
  && pass "install.sh restored the database itself: B's forward-only column is gone" \
  || bad "B's column survived, so install.sh did not restore the database"
[[ "$(live_write_rows 5)" == "0" ]] \
  && pass "the row written during the upgrade is gone, which is the stated cost of restoring a migrated database" \
  || bad "the row written during the upgrade survived, so the pre-upgrade dump was not restored"

handoffs_after=0
if [[ -r "${handoff_log}" ]]; then handoffs_after="$(grep -c . "${handoff_log}" || true)"; fi
if (( handoffs_after == handoffs_before + 1 )); then
  pass "the rollback restarted the deployment through ${VERSION_A}'s own host installer"
else
  bad "the restored tree's host installer ran ${handoffs_before} -> ${handoffs_after} times; the rollback restored files without bringing the deployment back"
fi
[[ "$(tail -n 1 "${handoff_log}" 2>/dev/null || true)" == "handoff ${VERSION_A} ${COMMIT_A}" ]] \
  && pass "the last handoff on this machine is ${VERSION_A}, not the release that failed" \
  || bad "the last handoff reads '$(tail -n 1 "${handoff_log}" 2>/dev/null || true)'"

record="$(rollback_record)"
if [[ -n "${record}" ]]; then
  pass "install.sh wrote a rollback record an operator can find without a terminal"
  [[ "${record}" == *'"outcome":"rolled-back"'* ]] \
    && pass "the record reports a completed rollback" \
    || bad "the record reports '${record}'"
  [[ "${record}" == *'"databaseRestored":true'* ]] \
    && pass "the record states that the database was restored" \
    || bad "the record does not state that the database was restored: ${record}"
  [[ "${record}" == *"\"fromCommit\":\"${COMMIT_A}\""* ]] \
    && pass "the record names ${COMMIT_A:0:12} as the release restored to" \
    || bad "the record does not name ${COMMIT_A:0:12} as fromCommit: ${record}"
  [[ "${record}" == *"\"toCommit\":\"${COMMIT_B}\""* ]] \
    && pass "the record names ${COMMIT_B:0:12} as the release that failed" \
    || bad "the record does not name ${COMMIT_B:0:12} as toCommit: ${record}"
else
  bad "no rollback record was written, so nothing on disk says why the machine went back"
fi

failure_dump="$(newest_dump)"
if [[ -n "${failure_dump}" && -f "${failure_dump}" && "${failure_dump}" != "${dump_before_failure}" ]]; then
  pass "the rollback kept the pre-upgrade dump it restored from"
else
  bad "the rollback did not leave the pre-upgrade dump behind"
fi
grep -Fq 'ROLLED BACK TO THE PREVIOUS RELEASE' "${installer_output}" \
  && pass "the failure printed the rollback panel" \
  || { bad "the failure printed no rollback panel"; report_installer_output; }
# Scoped to the panel, not the whole transcript: the successful-dump line names
# the same path earlier in the run, so a whole-file grep would pass with the
# panel deleted entirely -- asserting that a dump happened, not that anyone was
# told what became of it.
notice="$(grep -A 8 -F 'ROLLED BACK TO THE PREVIOUS RELEASE' "${installer_output}" || true)"
if [[ -n "${failure_dump}" && "${notice}" == *"${failure_dump}"* ]]; then
  pass "the rollback panel names the dump it restored from"
else
  bad "the rollback panel does not name the dump path"
fi
[[ "$(leftover_directories '.orcasynapse.backup.*')" == "0" ]] \
  && pass "the rollback consumed the retained source backup rather than leaving it" \
  || bad "$(leftover_directories '.orcasynapse.backup.*') retained source backup(s) remain after the rollback"
[[ "$(leftover_directories '.orcasynapse.failed.*')" == "0" ]] \
  && pass "the failed tree was removed rather than left beside the installation" \
  || bad "$(leftover_directories '.orcasynapse.failed.*') failed tree(s) remain beside the installation"
# The reason has to outlive the tree that produced it. An upgrade that puts
# itself back has, by definition, deleted the evidence of what went wrong.
diagnostics=()
while IFS= read -r line; do
  if [[ -n "${line}" ]]; then diagnostics+=("${line}"); fi
done < <(find "${INSTALL_DIR}/.local/state" -maxdepth 2 -type f -path '*/failed-upgrade-*' 2>/dev/null || true)
(( ${#diagnostics[@]} > 0 )) \
  && pass "the failed run's installer log was carried into the restored tree (${#diagnostics[@]} file(s))" \
  || bad "the failed run's log was deleted with its tree, so nothing on disk says what went wrong"

# ---------------------------------------------------------------------------
# 6. An upgrade that fails BEFORE its migrations run
# ---------------------------------------------------------------------------
# The contrast, and the one that decides whether the rollback is a feature or a
# hazard. Nothing touched the database, so nothing may be restored over it: the
# row written while the upgrade was in flight has to still be there afterwards.
# A rollback that restored unconditionally would pass every assertion in
# scenario 5 and fail this one.
printf '\n=== an upgrade that fails before migrating restores the source and not the database ===\n'
run_installer "${ARCHIVE_B}" "${SHA_B}" "${COMMIT_B}" \
  ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade \
  "UPGRADE_TEST_FAIL_BEFORE_MIGRATE=${VERSION_B}" \
  "UPGRADE_TEST_WRITE_DURING_UPGRADE=${VERSION_B}" UPGRADE_TEST_WRITE_ID=6
(( installer_status != 0 )) \
  && pass "the installer reported the failed upgrade (exit ${installer_status})" \
  || { bad "the installer exited 0 despite the induced pre-migration failure"; report_installer_output; }
[[ "$(display_name_columns)" == "0" ]] \
  && pass "no migration ran, so the database is still on A's schema" \
  || bad "the schema moved despite a failure injected before the migrations"
assert_deployment_at "after a pre-migration failure" "${VERSION_A}" "${COMMIT_A}" "001-baseline.sql" "0"
assert_seeded_data_intact "after a pre-migration failure"
[[ "$(live_write_rows 6)" == "1" ]] \
  && pass "the row written during the upgrade survived, so an untouched database was left untouched" \
  || bad "the row written during the upgrade was destroyed by a restore that was not needed"
record="$(rollback_record)"
[[ "${record}" == *'"databaseRestored":false'* ]] \
  && pass "the record states that the database was deliberately not restored" \
  || bad "the record does not state that the database was left alone: ${record}"

# ---------------------------------------------------------------------------
# 7. The operator's escape hatch, and the runbook it leaves them with
# ---------------------------------------------------------------------------
# install.sh is run by hand as well as by the update agent, and an operator
# debugging a failed upgrade has to be able to keep the failed state. This is
# that switch, exercised: the same post-migration failure with the rollback
# turned off must leave exactly what it left before increment 4 -- new source,
# new schema, a dump, and a panel naming it -- and the documented recovery must
# still put it back.
printf '\n=== ORCASYNAPSE_UPGRADE_ROLLBACK=off leaves the failed state in place ===\n'
run_installer "${ARCHIVE_B}" "${SHA_B}" "${COMMIT_B}" \
  ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade ORCASYNAPSE_UPGRADE_ROLLBACK=off \
  "UPGRADE_TEST_FAIL_AFTER_MIGRATE=${VERSION_B}"
if (( installer_status == 3 )); then
  bad "the failure was injected before the migration was visible, so this scenario proved nothing"
  report_installer_output
elif (( installer_status != 0 )); then
  pass "the installer reported the failed upgrade (exit ${installer_status})"
else
  bad "the installer exited 0 despite the induced post-migration failure"
  report_installer_output
fi
[[ "$(installed_marker)" == "${VERSION_B}" && "$(installed_commit)" == "${COMMIT_B}" ]] \
  && pass "with the rollback off the deployment is left on B's source, as it was before increment 4" \
  || bad "the rollback ran despite ORCASYNAPSE_UPGRADE_ROLLBACK=off: the deployment is at '$(installed_marker)'"
[[ "$(display_name_columns)" == "1" ]] \
  && pass "with the rollback off the migrated schema is left in place for inspection" \
  || bad "the database was restored despite ORCASYNAPSE_UPGRADE_ROLLBACK=off"
grep -Fq 'THE PRE-UPGRADE DATABASE DUMP IS INTACT' "${installer_output}" \
  && pass "the operator is still told where the dump is" \
  || { bad "no restore notice was printed, so an operator who turned the rollback off is left with nothing"; report_installer_output; }
[[ "$(leftover_directories '.orcasynapse.backup.*')" == "0" ]] \
  && pass "with the rollback off no source backup is retained, exactly as before" \
  || bad "$(leftover_directories '.orcasynapse.backup.*') source backup(s) were retained despite the rollback being off"

printf '\n=== the documented recovery still works from that state ===\n'
escape_dump="$(newest_dump)"
recover_to_a "recovery with the rollback turned off" "${escape_dump}" || true
assert_deployment_at "after the documented recovery" "${VERSION_A}" "${COMMIT_A}" "001-baseline.sql" "0"
assert_seeded_data_intact "after the documented recovery"

# ---------------------------------------------------------------------------
# 8. Retrying the upgrade succeeds
# ---------------------------------------------------------------------------
printf '\n=== retrying the upgrade after all of that ===\n'
run_installer "${ARCHIVE_B}" "${SHA_B}" "${COMMIT_B}" ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade
(( installer_status == 0 )) \
  && pass "the retried upgrade completed" \
  || { bad "the retried upgrade exited ${installer_status}"; report_installer_output; }
assert_deployment_at "after retrying" "${VERSION_B}" "${COMMIT_B}" "001-baseline.sql,002-add-display-name.sql" "1"
assert_seeded_data_intact "after retrying"
# A ceiling rather than an equality. Six dumps were taken across this run and
# two of them can legitimately share a name -- the file is named
# <version>-<second> and two runs from the same version inside one second
# collapse to one file -- so an equality here would be a flake waiting for a
# fast machine. The ceiling is what retention actually promises, and it still
# fires if pruning is removed: eight upgrades would leave at least four files.
[[ "$(dump_count)" -le 3 && "$(dump_count)" -ge 1 ]] \
  && pass "retention never let the backups directory past three dumps across every upgrade in this run" \
  || bad "the backups directory holds $(dump_count) dump(s), which retention should never allow"

# ---------------------------------------------------------------------------
# 9. Containment
# ---------------------------------------------------------------------------
# Asserted rather than asserted-in-a-comment. The developer's real VM1 stack
# runs on the same daemon this test just used.
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
leftovers="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null | wc -l)"
[[ "${leftovers}" == "0" ]] \
  && pass "no container remains labelled for the ${PROJECT} project" \
  || bad "${leftovers} container(s) remain labelled for the ${PROJECT} project"
[[ "${INSTALL_DIR}" == /var/tmp/orcasynapse-upgrade-test.* ]] \
  && pass "every file this run created lives under ${WORK}, which the EXIT handler removes" \
  || bad "the install directory was outside the temporary work tree: ${INSTALL_DIR}"

printf '\n'
if (( failures > 0 )); then
  printf 'OrcaSynapse A->B upgrade test FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'OrcaSynapse A->B upgrade test passed.\n'
