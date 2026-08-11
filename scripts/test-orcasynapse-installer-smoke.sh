#!/usr/bin/env bash
# Runs the VM1 installer's main() end to end.
#
# The companion to test-agentic-installer-smoke.sh, and the more important of
# the two: this is the script a customer runs first. Three tests touch it today
# -- recovery paths, secret permissions, version consistency -- but none of them
# execute the install itself, so "does a fresh control plane actually come up"
# has never had an answer before the customer's VM produced one.
#
# Runs from an isolated copy of the tree rather than in place. That is how a
# release actually installs (an extracted tarball, not a checkout), and it keeps
# generated secrets out of the working tree entirely.
#
# Needs Ubuntu with systemd, Docker Compose v2 and root.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d /var/tmp/orcasynapse-vm1-smoke.XXXXXX)"
RELEASE="${WORK}/release"
HTTP_PORT="${ORCASYNAPSE_SMOKE_PORT:-8399}"
failures=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

cleanup() {
  if [[ -d "${RELEASE}" ]]; then
    docker compose --project-directory "${RELEASE}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  # The captured stdout holds the Installation Key and the temporary password.
  # It is shredded rather than merely unlinked, and never printed.
  [[ -f "${WORK}/install.out" ]] && shred -u "${WORK}/install.out" 2>/dev/null
  rm -rf -- "${WORK}"
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || { echo "run as root: sudo bash scripts/test-orcasynapse-installer-smoke.sh" >&2; exit 2; }
# Only the daemon is required up front. Compose v2 is something the installer
# provisions itself, so demanding it here would skip the path that does.
docker info >/dev/null 2>&1 || { echo "this test needs a reachable Docker daemon" >&2; exit 2; }

printf '\n=== staging an isolated release tree ===\n'
mkdir -p "${RELEASE}"
tar -C "${ROOT}" \
  --exclude=./.git --exclude=./node_modules --exclude='*/node_modules' \
  --exclude='*/dist' --exclude=./.local \
  -cf - . | tar -C "${RELEASE}" -xf -
pass "release tree staged at ${RELEASE}"

printf '\n=== running the installer (this builds three images) ===\n'
install -d -m 0700 "${WORK}"
: > "${WORK}/install.out"
chmod 0600 "${WORK}/install.out"
set +e
ORCASYNAPSE_HTTP_PORT="${HTTP_PORT}" \
  bash "${RELEASE}/scripts/install-orcasynapse.sh" >"${WORK}/install.out" 2>&1
installer_status=$?
set -e
if [[ "${installer_status}" -eq 0 ]]; then
  pass "installer main() completed"
else
  bad "installer main() exited ${installer_status}"
  # The installer's own log, not its stdout: by the UI logging contract secrets
  # never pass through ui_* helpers, so this is the one safe diagnostic.
  tail -n 40 "${RELEASE}"/.local/state/install-*.log 2>/dev/null >&2 || true
fi

printf '\n=== asserting the installed control plane ===\n'
compose() { docker compose --project-directory "${RELEASE}" "$@"; }

for service in postgres api web worker; do
  if [[ "$(compose ps --status running --services 2>/dev/null | grep -cx "${service}")" == "1" ]]; then
    pass "${service} is running"
  else
    bad "${service} is not running"
  fi
done

curl --fail --silent --max-time 10 "http://127.0.0.1:${HTTP_PORT}/" >/dev/null \
  && pass "dashboard is served on ${HTTP_PORT}" || bad "dashboard did not answer on ${HTTP_PORT}"
curl --fail --silent --max-time 10 "http://127.0.0.1:${HTTP_PORT}/api/v1/platform" >/dev/null \
  && pass "API answers through the reverse proxy" || bad "API did not answer through the proxy"

# Migrations are the gate api and worker wait on, so a running api already
# implies they applied -- this proves the schema is really there.
if compose exec -T postgres psql -U orcasynapse -d orcasynapse -tAc \
     "select \"epoch\" from \"SchemaMetadata\" where \"id\" = 'current'" 2>/dev/null | grep -qx 'hermes-native-v1'; then
  pass "greenfield schema epoch applied"
else
  bad "the greenfield schema epoch is missing"
fi

if compose exec -T postgres psql -U orcasynapse -d orcasynapse -tAc \
     "select count(*) from pg_extension where extname = 'vector'" 2>/dev/null | grep -qx '0'; then
  pass "stock PostgreSQL has no vector extension"
else
  bad "retired vector extension is present"
fi

# postgres_password is read by the postgres image as root, so it stays 0600.
# The three application secrets are group-readable by GID 1000, the
# unprivileged node group the api, worker and migrate containers run as.
assert_secret() {
  local name="$1" expected="$2" file="${RELEASE}/.local/secrets/$1" mode
  if [[ ! -s "${file}" ]]; then bad "${name} was not generated"; return; fi
  mode="$(stat -c '%a' "${file}")"
  if [[ "${mode}" == "${expected}" ]]; then
    pass "${name} present and protected (${mode})"
  else
    bad "${name} has mode ${mode}, expected ${expected}"
  fi
}
assert_secret postgres_password 600
assert_secret orcasynapse_database_url 640
assert_secret orcasynapse_master_key 640
assert_secret orcasynapse_installation_key 640
if [[ "$(stat -c '%a' "${RELEASE}/.local/secrets")" == "700" ]]; then
  pass "secret directory is root-only"
else
  bad "secret directory is not 0700"
fi



[[ -s "${RELEASE}/.local/state/install-complete.json" ]] \
  && pass "completion marker written" || bad "completion marker missing"
[[ "$(<"${RELEASE}/.local/state/schema-epoch")" == "hermes-native-v1" ]] \
  && pass "schema epoch marker written" || bad "schema epoch marker missing"
# Structural check only: the surrounding panel holds the Installation Key.
grep -q 'ORCASYNAPSE IS READY' "${WORK}/install.out" \
  && pass "completion panel rendered" || bad "completion panel did not render"

printf '\n'
if (( failures > 0 )); then
  printf 'OrcaSynapse installer smoke test FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'OrcaSynapse installer smoke test passed.\n'
