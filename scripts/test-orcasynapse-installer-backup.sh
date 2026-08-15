#!/usr/bin/env bash
# Drives install.sh's upgrade path against a real PostgreSQL container.
#
# The VM1 smoke test installs a control plane once, from nothing. Nothing has
# ever exercised the other path -- an installation that already exists being
# upgraded in place -- which is the path that runs forward-only migrations over
# a live database. This suite is that harness, narrowed to the one behaviour
# that decides whether an upgrade can be undone: the pre-migration dump.
#
# What is real here and what is not:
#   real  -- install.sh's main(), its existing-installation decision, the
#            source-tree swap, and `docker compose exec -T postgres pg_dump`
#            against a live postgres:17-bookworm holding a seeded row.
#   stubbed -- the GitHub download (a curl shim serves a staged tarball) and the
#            host installer install.sh hands off to (a stub that records that it
#            ran). The stub stands in for everything after the handoff, and the
#            `migrate` service is the first thing in it, so "the stub did not
#            run" is exactly "no migration ran".
#
# The compose project is named orcasynapse-backup-test and publishes no ports,
# so it cannot adopt, restart or collide with a real `orcasynapse` stack on the
# same host.
#
# Needs root and a reachable Docker daemon.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d /var/tmp/orcasynapse-backup-test.XXXXXX)"
INSTALL_PARENT="${WORK}/opt"
INSTALL_DIR="${INSTALL_PARENT}/orcasynapse"
BACKUPS_DIR="${INSTALL_DIR}/.local/state/backups"
SECRETS_DIR="${INSTALL_DIR}/.local/secrets"
SHIM_DIR="${WORK}/shims"
RELEASE_DIR="${WORK}/release/orcasynapse-release"
ARCHIVE="${WORK}/release.tar.gz"
OLD_COMMIT="1111111111111111111111111111111111111111"
NEW_COMMIT="2222222222222222222222222222222222222222"
OLD_VERSION="v5.2.2"
PROBE_ROW="orcasynapse-backup-probe-row"
failures=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

cleanup() {
  if [[ -f "${INSTALL_DIR}/compose.yaml" ]]; then
    docker compose --project-directory "${INSTALL_DIR}" down --volumes --remove-orphans \
      >/dev/null 2>&1 || true
  fi
  rm -rf -- "${WORK}"
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || { echo "run as root: sudo bash scripts/test-orcasynapse-installer-backup.sh" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "this test needs a reachable Docker daemon" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "this test needs Docker Compose v2" >&2; exit 2; }

compose() { docker compose --project-directory "${INSTALL_DIR}" "$@"; }

# ---------------------------------------------------------------------------
# The installation that already exists
# ---------------------------------------------------------------------------
printf '\n=== staging an existing installation ===\n'
install -d -m 0755 "${INSTALL_PARENT}"
install -d -m 0750 "${INSTALL_DIR}/scripts"
install -d -m 0700 "${SECRETS_DIR}" "${INSTALL_DIR}/.local/state"

# postgres only, and deliberately close to the real compose.yaml where this test
# depends on it: the secret file the dump reads inside the container, the
# database and role names the dump derives from the URL secret, and a TCP
# healthcheck. No published port and a project name of its own, so a real stack
# on this host is untouched.
write_compose_file() {
  cat > "$1" <<'COMPOSE'
name: orcasynapse-backup-test

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

# Stands in for scripts/install-orcasynapse.sh, whose first real act is
# `docker compose up -d` and therefore the `migrate` service. It records that it
# ran into .local/state, which the upgrade carries across the source swap, so
# the marker is at the same path whichever tree is in place.
write_host_installer_stub() {
  cat > "$1" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
stub_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
install -d -m 0700 "${stub_root}/.local/state"
printf 'handoff\n' >> "${stub_root}/.local/state/handoff-ran"
printf 'STUB HOST INSTALLER RAN -- this is where the migrate service would run\n'
if [[ "${BACKUP_TEST_HANDOFF_FAIL:-0}" == "1" ]]; then
  printf 'stub host installer failing on purpose\n' >&2
  exit 1
fi
STUB
  chmod 0755 "$1"
}

write_compose_file "${INSTALL_DIR}/compose.yaml"
write_host_installer_stub "${INSTALL_DIR}/scripts/install-orcasynapse.sh"
printf '%s' "${OLD_COMMIT}" > "${INSTALL_DIR}/.orcasynapse-source-commit"
printf 'hermes-native-v1\n' > "${INSTALL_DIR}/.local/state/schema-epoch"
printf '{"version":"%s","commit":"%s","completedAt":"2026-08-01T00:00:00Z","publicScheme":"http"}\n' \
  "${OLD_VERSION}" "${OLD_COMMIT}" > "${INSTALL_DIR}/.local/state/install-complete.json"

postgres_password="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
printf '%s' "${postgres_password}" > "${SECRETS_DIR}/postgres_password"
chmod 0600 "${SECRETS_DIR}/postgres_password"
printf 'postgresql://orcasynapse:%s@postgres:5432/orcasynapse' "${postgres_password}" \
  > "${SECRETS_DIR}/orcasynapse_database_url"
chmod 0640 "${SECRETS_DIR}/orcasynapse_database_url"
cp -- "${SECRETS_DIR}/orcasynapse_database_url" "${WORK}/database-url.good"
pass "existing installation staged at ${INSTALL_DIR}"

# ---------------------------------------------------------------------------
# The release being installed over it
# ---------------------------------------------------------------------------
install -d -m 0755 "${RELEASE_DIR}/scripts"
write_compose_file "${RELEASE_DIR}/compose.yaml"
write_host_installer_stub "${RELEASE_DIR}/scripts/install-orcasynapse.sh"
printf 'new-source\n' > "${RELEASE_DIR}/release-marker"
tar -czf "${ARCHIVE}" -C "${WORK}/release" orcasynapse-release
ARCHIVE_SHA256="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
pass "release tarball staged (${ARCHIVE_SHA256:0:12})"

# ---------------------------------------------------------------------------
# Shims: the GitHub download, and a docker that can be made to fail the dump
# ---------------------------------------------------------------------------
install -d -m 0755 "${SHIM_DIR}"
cat > "${SHIM_DIR}/curl" <<SHIM
#!/usr/bin/env bash
# Stands in for codeload.github.com: install.sh asks for a HEAD and then a body,
# and gets the staged tarball both times.
archive="${ARCHIVE}"
head=0
out=""
while (( \$# )); do
  case "\$1" in
    --head) head=1 ;;
    --output) out="\$2"; shift ;;
  esac
  shift
done
if (( head )); then
  printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "\$(stat -c '%s' "\${archive}")"
  exit 0
fi
[[ -n "\${out}" ]] || exit 1
cp -- "\${archive}" "\${out}"
SHIM
chmod 0755 "${SHIM_DIR}/curl"

REAL_DOCKER="$(command -v docker)"
cat > "${SHIM_DIR}/docker" <<SHIM
#!/usr/bin/env bash
# Everything reaches the real Docker except the dump itself, which
# BACKUP_TEST_DOCKER_MODE can turn into each of the three ways a dump fails
# while still leaving a file behind.
mode="\${BACKUP_TEST_DOCKER_MODE:-pass}"
is_dump=0
for arg in "\$@"; do
  case "\${arg}" in
    *pg_dump*) is_dump=1 ;;
  esac
done
if (( is_dump )) && [[ "\${mode}" != "pass" ]]; then
  case "\${mode}" in
    dumpfail)
      printf 'pg_dump: error: connection to server failed (induced by the backup test)\n' >&2
      exit 1
      ;;
    truncate)
      # A complete gzip wrapping an incomplete dump: header, no end marker.
      printf -- '--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\n'
      exit 0
      ;;
    empty)
      exit 0
      ;;
    *)
      printf 'unknown BACKUP_TEST_DOCKER_MODE %s\n' "\${mode}" >&2
      exit 1
      ;;
  esac
fi
exec "${REAL_DOCKER}" "\$@"
SHIM
chmod 0755 "${SHIM_DIR}/docker"
pass "curl and docker shims staged"

# ---------------------------------------------------------------------------
# Bring the existing installation's database up and put a row in it
# ---------------------------------------------------------------------------
printf '\n=== starting the existing database ===\n'
compose up -d --wait postgres >/dev/null 2>&1 || compose up -d postgres >/dev/null 2>&1
ready=0
deadline=$((SECONDS + 180))
until compose exec -T postgres pg_isready -h 127.0.0.1 -U orcasynapse -d orcasynapse >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then break; fi
  sleep 2
done
if compose exec -T postgres pg_isready -h 127.0.0.1 -U orcasynapse -d orcasynapse >/dev/null 2>&1; then
  ready=1
fi
(( ready )) || { echo "the test database never became ready" >&2; exit 2; }
compose exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q -c \
  "create table if not exists backup_probe (id int primary key, note text); \
   insert into backup_probe values (1, '${PROBE_ROW}') on conflict (id) do nothing;" >/dev/null
pass "database is up with a seeded row"

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
installer_status=0
installer_output=""

# Resets only the source tree, never the database: every scenario upgrades the
# same live installation, which is what an upgrade actually is.
reset_installation() {
  write_compose_file "${INSTALL_DIR}/compose.yaml"
  write_host_installer_stub "${INSTALL_DIR}/scripts/install-orcasynapse.sh"
  printf '%s' "${OLD_COMMIT}" > "${INSTALL_DIR}/.orcasynapse-source-commit"
  printf 'hermes-native-v1\n' > "${INSTALL_DIR}/.local/state/schema-epoch"
  printf '{"version":"%s","commit":"%s","completedAt":"2026-08-01T00:00:00Z","publicScheme":"http"}\n' \
    "${OLD_VERSION}" "${OLD_COMMIT}" > "${INSTALL_DIR}/.local/state/install-complete.json"
  rm -f -- "${INSTALL_DIR}/release-marker" "${INSTALL_DIR}/.local/state/handoff-ran"
  rm -f -- "${INSTALL_DIR}/.local/state/last-database-backup.json"
  rm -rf -- "${BACKUPS_DIR}"
}

run_installer() {
  installer_output="${WORK}/installer.out"
  : > "${installer_output}"
  chmod 0600 "${installer_output}"
  set +e
  env PATH="${SHIM_DIR}:${PATH}" \
    TERM=dumb \
    ORCASYNAPSE_INSTALL_DIR="${INSTALL_DIR}" \
    ORCASYNAPSE_REF="${NEW_COMMIT}" \
    ORCASYNAPSE_ARCHIVE_SHA256="${ARCHIVE_SHA256}" \
    ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade \
    "$@" \
    bash "${ROOT}/install.sh" >"${installer_output}" 2>&1
  installer_status=$?
  set -e
}

# Both helpers have to survive a backups directory that does not exist, which is
# the state every aborted upgrade leaves behind. `find` on a missing path exits
# 1 even with its stderr discarded, and an unguarded `dump="$(newest_dump)"`
# then ends the whole run under `set -e` -- which is exactly what happened on
# the first baseline run of this suite: it stopped after the fourth assertion
# and reported one failure, having silently skipped the other sixty.
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
# dies on the broken pipe, and under `set -o pipefail` the newest dump would be
# reported as a failure to find one.
newest_dump() {
  list_dumps
  (( ${#DUMPS[@]} > 0 )) || return 0
  printf '%s' "${DUMPS[0]#* }"
}

report_installer_output() {
  printf '  ---- installer output (last 25 lines) ----\n' >&2
  tail -n 25 "${installer_output}" >&2 || true
  printf '  ------------------------------------------\n' >&2
}

# ---------------------------------------------------------------------------
# 1. An upgrade produces a dump
# ---------------------------------------------------------------------------
printf '\n=== an upgrade dumps the database before handing off ===\n'
reset_installation
run_installer BACKUP_TEST_DOCKER_MODE=pass
if (( installer_status == 0 )); then
  pass "the upgrade completed"
else
  bad "the upgrade exited ${installer_status}"
  report_installer_output
fi
[[ -f "${INSTALL_DIR}/release-marker" ]] \
  && pass "the new source tree is in place" || bad "the new source tree was not installed"
[[ -f "${INSTALL_DIR}/.local/state/handoff-ran" ]] \
  && pass "the host installer ran (migrations would have run here)" \
  || bad "the host installer never ran"

if [[ "$(dump_count)" == "1" ]]; then
  pass "exactly one dump was written"
else
  bad "expected one dump, found $(dump_count)"
fi
dump="$(newest_dump)"
if [[ -n "${dump}" ]]; then
  case "$(basename -- "${dump}")" in
    "${OLD_VERSION}"-*.sql.gz) pass "the dump is named for the release it was taken from" ;;
    *) bad "the dump name does not carry the installed release: $(basename -- "${dump}")" ;;
  esac
  # The assertion that this is a dump of the real database rather than a file
  # that merely exists: the row seeded above has to be inside it. Decompressed
  # to a file first, because `gzip -cd | grep -q` under `set -o pipefail` fails
  # on a *successful* match -- grep exits at the first hit and gzip dies on the
  # broken pipe.
  if gzip -cd -- "${dump}" > "${WORK}/dump.sql" 2>/dev/null \
    && grep -Fq -- "${PROBE_ROW}" "${WORK}/dump.sql"; then
    pass "the dump contains the seeded row"
  else
    bad "the dump does not contain the seeded row"
  fi
  mode="$(stat -c '%a' "${dump}")"
  [[ "${mode}" == "600" ]] && pass "the dump is 0600" || bad "the dump has mode ${mode}, expected 600"
  dir_mode="$(stat -c '%a' "${BACKUPS_DIR}")"
  [[ "${dir_mode}" == "700" ]] \
    && pass "the backup directory is root-only" \
    || bad "the backup directory has mode ${dir_mode}, expected 700"
  # Stated separately from the exact modes above because it is the property that
  # actually matters: a dump is the whole application database in plain SQL.
  # Both digits are checked, since a readable file inside an unreadable
  # directory and an unreadable file inside a readable one are each one chmod
  # away from exposure.
  if [[ "${mode: -1}" == "0" && "${dir_mode: -1}" == "0" ]]; then
    pass "neither the dump nor its directory grants any world permission"
  else
    bad "world permissions are set: dump ${mode}, directory ${dir_mode}"
  fi
else
  bad "no dump was written at all"
fi

receipt="${INSTALL_DIR}/.local/state/last-database-backup.json"
if [[ -s "${receipt}" ]]; then
  pass "the backup receipt was written"
  recorded="$(sed -nE 's/.*"path"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "${receipt}")"
  if [[ -n "${recorded}" && -f "${recorded}" ]]; then
    pass "the receipt points at a dump that exists"
  else
    bad "the receipt path does not resolve: ${recorded:-<empty>}"
  fi
  grep -q "\"fromCommit\":\"${OLD_COMMIT}\"" "${receipt}" \
    && pass "the receipt records the commit being replaced" \
    || bad "the receipt does not record the replaced commit"
  grep -q "\"toCommit\":\"${NEW_COMMIT}\"" "${receipt}" \
    && pass "the receipt records the commit being installed" \
    || bad "the receipt does not record the installed commit"
  receipt_mode="$(stat -c '%a' "${receipt}")"
  [[ "${receipt_mode}" == "600" ]] \
    && pass "the receipt is 0600" || bad "the receipt has mode ${receipt_mode}, expected 600"
else
  bad "no backup receipt was written"
fi

# ---------------------------------------------------------------------------
# 2. A stopped database is started rather than skipped
# ---------------------------------------------------------------------------
printf '\n=== a stopped database is started to be dumped ===\n'
reset_installation
compose stop postgres >/dev/null 2>&1
run_installer BACKUP_TEST_DOCKER_MODE=pass
if (( installer_status == 0 )); then
  pass "the upgrade completed with the database stopped"
else
  bad "the upgrade exited ${installer_status} with the database stopped"
  report_installer_output
fi
dump="$(newest_dump)"
if [[ -n "${dump}" ]] && gzip -cd -- "${dump}" > "${WORK}/dump.sql" 2>/dev/null \
  && grep -Fq -- "${PROBE_ROW}" "${WORK}/dump.sql"; then
  pass "the stopped database was started and dumped with its data intact"
else
  bad "a stopped database produced no usable dump"
  report_installer_output
fi

# ---------------------------------------------------------------------------
# 3. Retention keeps three and prunes the fourth
# ---------------------------------------------------------------------------
printf '\n=== retention keeps the newest three ===\n'
reset_installation
install -d -m 0700 "${BACKUPS_DIR}"
# Named so that lexical order and chronological order disagree: v5.9.0 sorts
# last by name and first by time. A pruner that sorted by name would keep it and
# delete v5.10.0 -- the newest release -- so this arrangement tells the two
# implementations apart instead of passing under either.
seed_dump() {
  local name="$1" stamp="$2"
  printf 'seeded\n' | gzip -9 > "${BACKUPS_DIR}/${name}.sql.gz"
  chmod 0600 "${BACKUPS_DIR}/${name}.sql.gz"
  touch -t "${stamp}" "${BACKUPS_DIR}/${name}.sql.gz"
}
seed_dump v5.9.0-20260101T000000Z 202601010000
seed_dump v5.10.0-20260201T000000Z 202602010000
seed_dump v5.11.0-20260301T000000Z 202603010000
run_installer BACKUP_TEST_DOCKER_MODE=pass
if (( installer_status == 0 )); then
  pass "the upgrade completed with three dumps already present"
else
  bad "the upgrade exited ${installer_status} with three dumps already present"
  report_installer_output
fi
if [[ "$(dump_count)" == "3" ]]; then
  pass "three dumps are retained"
else
  bad "expected three retained dumps, found $(dump_count)"
fi
[[ ! -e "${BACKUPS_DIR}/v5.9.0-20260101T000000Z.sql.gz" ]] \
  && pass "the oldest dump was pruned" || bad "the oldest dump was not pruned"
[[ -e "${BACKUPS_DIR}/v5.10.0-20260201T000000Z.sql.gz" ]] \
  && pass "v5.10.0 survived a name that sorts below v5.9.0" \
  || bad "v5.10.0 was pruned, so retention is sorting by name rather than by time"
[[ -e "${BACKUPS_DIR}/v5.11.0-20260301T000000Z.sql.gz" ]] \
  && pass "the second newest seeded dump survived" || bad "the second newest seeded dump was pruned"

# ---------------------------------------------------------------------------
# 3-5. A dump that fails, truncates, or comes back empty aborts the upgrade
# ---------------------------------------------------------------------------
assert_upgrade_aborted() {
  local label="$1" expected_message="$2"
  if (( installer_status != 0 )); then
    pass "${label}: the installer exited ${installer_status}"
  else
    bad "${label}: the installer exited 0"
    report_installer_output
  fi
  if [[ ! -f "${INSTALL_DIR}/.local/state/handoff-ran" ]]; then
    pass "${label}: no migration ran"
  else
    bad "${label}: the host installer ran anyway, so migrations would have run"
  fi
  [[ ! -e "${INSTALL_DIR}/release-marker" ]] \
    && pass "${label}: the source tree was not replaced" \
    || bad "${label}: the source tree was replaced"
  [[ "$(<"${INSTALL_DIR}/.orcasynapse-source-commit")" == "${OLD_COMMIT}" ]] \
    && pass "${label}: the installed commit is unchanged" \
    || bad "${label}: the installed commit changed"
  [[ "$(dump_count)" == "0" ]] \
    && pass "${label}: no dump was left behind" \
    || bad "${label}: a dump was left behind"
  if [[ -z "$(find "${BACKUPS_DIR}" -maxdepth 1 -name '*.partial' 2>/dev/null)" ]]; then
    pass "${label}: no partial file was left behind"
  else
    bad "${label}: a .partial file was left behind"
  fi
  if grep -Fq "${expected_message}" "${installer_output}"; then
    pass "${label}: the failure says why"
  else
    bad "${label}: the failure message did not mention '${expected_message}'"
    report_installer_output
  fi
}

printf '\n=== a failing pg_dump aborts before any migration ===\n'
reset_installation
run_installer BACKUP_TEST_DOCKER_MODE=dumpfail
assert_upgrade_aborted "failed dump" "the pre-upgrade database dump failed"

printf '\n=== a truncated dump aborts before any migration ===\n'
reset_installation
run_installer BACKUP_TEST_DOCKER_MODE=truncate
assert_upgrade_aborted "truncated dump" "pg_dump did not write its end marker"

printf '\n=== an empty dump aborts before any migration ===\n'
reset_installation
run_installer BACKUP_TEST_DOCKER_MODE=empty
assert_upgrade_aborted "empty dump" "PostgreSQL returned no data"

printf '\n=== an unusable database URL secret aborts before any migration ===\n'
reset_installation
printf 'not-a-connection-url' > "${SECRETS_DIR}/orcasynapse_database_url"
run_installer BACKUP_TEST_DOCKER_MODE=pass
assert_upgrade_aborted "unusable secret" "is not a connection URL this installer can dump"
cp -- "${WORK}/database-url.good" "${SECRETS_DIR}/orcasynapse_database_url"
chmod 0640 "${SECRETS_DIR}/orcasynapse_database_url"

# ---------------------------------------------------------------------------
# 6. A failure after the dump prints where the dump is
# ---------------------------------------------------------------------------
printf '\n=== a failure after the dump prints the restore path ===\n'
reset_installation
run_installer BACKUP_TEST_DOCKER_MODE=pass BACKUP_TEST_HANDOFF_FAIL=1
if (( installer_status != 0 )); then
  pass "the installer reported the host installer's failure"
else
  bad "the installer exited 0 after the host installer failed"
  report_installer_output
fi
[[ -f "${INSTALL_DIR}/.local/state/handoff-ran" ]] \
  && pass "the failure happened after the handoff" || bad "the handoff never ran"
dump="$(newest_dump)"
if [[ -n "${dump}" && -f "${dump}" ]]; then
  pass "the dump survived the failed upgrade"
else
  bad "the dump did not survive the failed upgrade"
fi
grep -Fq 'THE PRE-UPGRADE DATABASE DUMP IS INTACT' "${installer_output}" \
  && pass "the restore notice was printed" || { bad "the restore notice was not printed"; report_installer_output; }
# Scoped to the notice rather than the whole transcript. The successful-dump
# line names the same path earlier in the run, so a whole-file grep passed even
# with the notice deleted entirely -- it was asserting that a dump happened, not
# that the operator was told where it is.
notice="$(grep -A 8 -F 'THE PRE-UPGRADE DATABASE DUMP IS INTACT' "${installer_output}" || true)"
if [[ -n "${dump}" && "${notice}" == *"${dump}"* ]]; then
  pass "the notice names the dump path"
else
  bad "the notice does not name the dump path"
fi
grep -Fq 'DATABASE_RESTORE_RUNBOOK.md' "${installer_output}" \
  && pass "the notice points at the restore runbook" || bad "the notice does not reference the runbook"

# ---------------------------------------------------------------------------
# 7. The documented restore actually restores
# ---------------------------------------------------------------------------
printf '\n=== the documented restore command restores the row ===\n'
dump="$(newest_dump)"
if [[ -n "${dump}" ]]; then
  compose exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q -c \
    "delete from backup_probe;" >/dev/null
  if [[ "$(compose exec -T postgres psql -U orcasynapse -d orcasynapse -tAc \
        "select count(*) from backup_probe" | tr -d '\r')" == "0" ]]; then
    pass "the seeded row was deleted, standing in for a bad migration"
  else
    bad "the seeded row could not be deleted"
  fi
  # Exactly the command docs/DATABASE_RESTORE_RUNBOOK.md gives an operator.
  if gzip -cd -- "${dump}" \
    | compose exec -T postgres psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1 -q \
    >"${WORK}/restore.out" 2>&1; then
    pass "the restore command completed"
  else
    bad "the restore command failed"
    tail -n 20 "${WORK}/restore.out" >&2 || true
  fi
  if [[ "$(compose exec -T postgres psql -U orcasynapse -d orcasynapse -tAc \
        "select note from backup_probe where id = 1" | tr -d '\r')" == "${PROBE_ROW}" ]]; then
    pass "the restored database has the row back"
  else
    bad "the restore did not bring the row back"
  fi
else
  bad "there was no dump to restore"
fi

# ---------------------------------------------------------------------------
# 8. An installation with no database is not blocked by a dump it cannot take
# ---------------------------------------------------------------------------
printf '\n=== an installation with no database secret still upgrades ===\n'
reset_installation
mv -- "${SECRETS_DIR}/orcasynapse_database_url" "${WORK}/database-url.parked"
run_installer BACKUP_TEST_DOCKER_MODE=pass
if (( installer_status == 0 )); then
  pass "the upgrade completed without a database to dump"
else
  bad "the upgrade exited ${installer_status} with no database to dump"
  report_installer_output
fi
[[ "$(dump_count)" == "0" ]] \
  && pass "no dump was invented" || bad "a dump appeared with no database to dump"
grep -Fq 'has no database to preserve' "${installer_output}" \
  && pass "the skip is stated out loud" || bad "the skip was silent"
mv -- "${WORK}/database-url.parked" "${SECRETS_DIR}/orcasynapse_database_url"

printf '\n'
if (( failures > 0 )); then
  printf 'OrcaSynapse pre-upgrade backup test FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'OrcaSynapse pre-upgrade backup test passed.\n'
