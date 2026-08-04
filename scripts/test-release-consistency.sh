#!/usr/bin/env bash
# Static guard: the release version must agree across every bump surface, and
# the deployment descriptors must agree with each other. A missed surface
# ships a release that misreports itself; a compose/CI image mismatch ships a
# stack CI never tested.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${ROOT}"
command -v node >/dev/null 2>&1 || { echo "node is required for this check" >&2; exit 1; }

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

# --- deployment descriptors agree ------------------------------------------
compose_image="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]]+)[[:space:]]*$/\1/p' compose.yaml)"
[[ "${compose_image}" == *$'\n'* ]] && fail "expected exactly one image: line in compose.yaml"
workflow_image="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]]+)[[:space:]]*$/\1/p' .github/workflows/verify.yml)"
[[ "${compose_image}" == "${workflow_image}" ]] \
  || fail "compose postgres image (${compose_image}) differs from the CI service image (${workflow_image})"
[[ "${compose_image}" == "pgvector/pgvector:pg17" ]] \
  || fail "the postgres image must be pgvector/pgvector:pg17; the migrator creates the vector extension"

grep -Fq 'packages/database/dist/drizzle/migrate-cli.js' compose.yaml \
  || fail "the compose migrate service no longer runs the Drizzle migrate CLI"
[[ -f packages/database/src/drizzle/migrate-cli.ts ]] \
  || fail "the migrate CLI source has moved; update compose.yaml"

for secret in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
  grep -Eq "^[[:space:]]+${secret}:$" compose.yaml || fail "secret '${secret}' is not declared in compose.yaml"
  grep -Fq "${secret}" scripts/install-orcasynapse.sh || fail "secret '${secret}' is not managed by scripts/install-orcasynapse.sh"
done

# --- version surfaces agree -------------------------------------------------
version="$(node -p "require('./package.json').version")"
[[ -n "${version}" ]] || fail "the root package.json version is empty"
for manifest in apps/*/package.json packages/*/package.json; do
  manifest_version="$(node -p "require('./${manifest}').version")"
  [[ "${manifest_version}" == "${version}" ]] || fail "${manifest} is at ${manifest_version}, expected ${version}"
done

contract_version="$(sed -nE 's/.*ORCASYNAPSE_VERSION = "([^"]+)".*/\1/p' packages/contracts/src/version.ts)"
[[ "${contract_version}" == "ai-v${version}" ]] \
  || fail "packages/contracts/src/version.ts declares '${contract_version}', expected 'ai-v${version}'"

agentic_version="$(sed -nE 's/^INSTALLER_VERSION="([^"]+)"$/\1/p' scripts/install-agentic-node.sh)"
[[ "${agentic_version}" == "ai-v${version}" ]] \
  || fail "scripts/install-agentic-node.sh INSTALLER_VERSION is '${agentic_version}', expected 'ai-v${version}'"

remover_version="$(sed -nE 's/^INSTALLER_VERSION="([^"]+)"$/\1/p' scripts/remove-agentic-node.sh)"
[[ "${remover_version}" == "ai-v${version}" ]] \
  || fail "scripts/remove-agentic-node.sh INSTALLER_VERSION is '${remover_version}', expected 'ai-v${version}'"

echo "Release consistency check passed at ai-v${version} (postgres image ${compose_image})."
