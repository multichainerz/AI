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
[[ "${compose_image}" == "postgres:17-bookworm" ]] \
  || fail "the postgres image must be the pinned stock PostgreSQL 17 image"

grep -Fq 'packages/database/dist/drizzle/migrate-cli.js' compose.yaml \
  || fail "the compose migrate service no longer runs the Drizzle migrate CLI"
[[ -f packages/database/src/drizzle/migrate-cli.ts ]] \
  || fail "the migrate CLI source has moved; update compose.yaml"

for secret in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
  grep -Eq "^[[:space:]]+${secret}:$" compose.yaml || fail "secret '${secret}' is not declared in compose.yaml"
  grep -Fq "${secret}" scripts/install-orcasynapse.sh || fail "secret '${secret}' is not managed by scripts/install-orcasynapse.sh"
done

# --- install commands use the canonical short form --------------------------
# Every place an operator is told to pipe a script into a root shell must show
# the same command. -fsSL is the whole contract: fail on an HTTP error rather
# than piping an error page into bash, stay quiet, still report transport
# errors, and follow redirects.
# The bracket keeps this pattern from matching its own source line.
if grep -rn -- '--fail --show[-]error' README.md docs deploy scripts apps/web/src 2>/dev/null; then
  fail "the lines above must use the canonical 'curl -fsSL' install command form"
fi
grep -Fq 'curl -fsSL' README.md || fail "README.md no longer shows the canonical curl -fsSL install command"

# --- version surfaces agree -------------------------------------------------
version="$(node -p "require('./package.json').version")"
[[ -n "${version}" ]] || fail "the root package.json version is empty"
for manifest in apps/*/package.json packages/*/package.json; do
  manifest_version="$(node -p "require('./${manifest}').version")"
  [[ "${manifest_version}" == "${version}" ]] || fail "${manifest} is at ${manifest_version}, expected ${version}"
done

# --- the minor digit rolls at nine ------------------------------------------
# OrcaSynapse numbers releases so that the minor runs 0-9 and then the major
# increments: 2.9.0 was followed by 3.0.0, not 2.10.0. That rule was kept
# through the 2.x line and then quietly lost -- 3.9.0 was followed by 3.10.0,
# and eleven releases shipped before anyone noticed. It is checked here rather
# than remembered, because the surface that broke it is the one nobody reads
# twice.
minor="$(printf '%s' "${version}" | cut -d. -f2)"
(( minor <= 9 )) \
  || fail "the minor version must roll into a major at 9: ${version} should have become $(( $(printf '%s' "${version}" | cut -d. -f1) + 1 )).0.0"

contract_version="$(sed -nE 's/.*ORCASYNAPSE_VERSION = "([^"]+)".*/\1/p' packages/contracts/src/version.ts)"
[[ "${contract_version}" == "v${version}" ]] \
  || fail "packages/contracts/src/version.ts declares '${contract_version}', expected 'v${version}'"

# CONTRIBUTING requires a matching CHANGELOG entry. Nothing enforced it, so
# v9.2.0 through v9.5.1 shipped with the heading still at v9.1.0.
grep -Eq "^## v${version}( |$)" CHANGELOG.md \
  || fail "CHANGELOG.md has no heading for v${version}"

agentic_version="$(sed -nE 's/^INSTALLER_VERSION="([^"]+)"$/\1/p' scripts/install-agentic-node.sh)"
[[ "${agentic_version}" == "v${version}" ]] \
  || fail "scripts/install-agentic-node.sh INSTALLER_VERSION is '${agentic_version}', expected 'v${version}'"

remover_version="$(sed -nE 's/^INSTALLER_VERSION="([^"]+)"$/\1/p' scripts/remove-agentic-node.sh)"
[[ "${remover_version}" == "v${version}" ]] \
  || fail "scripts/remove-agentic-node.sh INSTALLER_VERSION is '${remover_version}', expected 'v${version}'"

# --- the operator CLIs travel with the release --------------------------------
for cli in scripts/orcasynapse-cli.sh scripts/orcasynapse-agent-cli.sh; do
  cli_version="$(sed -nE 's/^CLI_VERSION="([^"]+)"$/\1/p' "${cli}")"
  [[ "${cli_version}" == "v${version}" ]] \
    || fail "${cli} CLI_VERSION is '${cli_version}', expected 'v${version}'"
  bash -n "${cli}" || fail "${cli} does not parse"
done
bash -n scripts/install-agentic-node.sh || fail "scripts/install-agentic-node.sh does not parse"
bash -n scripts/install-orcasynapse.sh || fail "scripts/install-orcasynapse.sh does not parse"

# The node CLI's status/update depend on the breadcrumb both installer paths
# write; losing either call site strands `orcasynapse-agent update` at
# "missing" forever.
breadcrumb_calls="$(grep -c '^  record_installer_version$' scripts/install-agentic-node.sh)"
[[ "${breadcrumb_calls}" -ge 2 ]] \
  || fail "install-agentic-node.sh must record the installer version on both the install and repair paths (found ${breadcrumb_calls})"

# The dashboard's Maintenance block and the node CLI must hand the operator the
# same maintenance command; two spellings of it is how one of them rots.
repair_fragment='agentic-node.sh | sudo bash -s -- --repair'
grep -Fq "${repair_fragment}" apps/web/src/runtime-nodes-panel.tsx \
  || fail "runtime-nodes-panel.tsx no longer offers the --repair maintenance command"
grep -Fq "${repair_fragment}" scripts/orcasynapse-agent-cli.sh \
  || fail "orcasynapse-agent-cli.sh no longer prints the --repair maintenance command"

# --- every script the API serves ships in its image --------------------------
# apps/api reads these off disk at request time. Development serves them from
# the repo tree, so a script missing from Dockerfile.api works everywhere
# except the released container -- where the download 500s mid-enrollment on an
# operator's VM, which is exactly how the artifact publisher shipped in v9.1.0.
# The list is derived from the route file rather than maintained here, so a
# fifth served script is covered the day it is added.
served_scripts="$(sed -nE 's|.*new URL\("(\.\./)+(scripts/[^"]+)".*|\2|p' apps/api/src/runtime-nodes/routes.ts | sort -u)"
[[ -n "${served_scripts}" ]] || fail "found no served scripts in runtime-nodes/routes.ts; update this check's pattern"
while IFS= read -r served; do
  [[ -f "${served}" ]] || fail "apps/api serves ${served} but the file does not exist"
  grep -Fq "COPY ${served} ./${served}" Dockerfile.api \
    || fail "apps/api serves ${served} but Dockerfile.api does not copy it into the image"
done <<< "${served_scripts}"

# --- the lockfile matches every manifest -------------------------------------
# The Docker image builds run `pnpm install --frozen-lockfile`, so a dependency
# removed from a package.json without regenerating pnpm-lock.yaml ships a
# release that cannot install itself. Local development never notices: a plain
# `pnpm install` repairs the lockfile silently, and warm node_modules never
# re-resolve. v9.2.0 shipped exactly this -- `jose` left apps/api in the v9.0.0
# OIDC removal and the stale lockfile surfaced eleven releases of surfaces
# later, at "Build the pinned release" on an operator's VM. `--lockfile-only`
# makes the check pure: it validates and writes nothing.
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile --lockfile-only >/dev/null 2>&1 \
    || fail "pnpm-lock.yaml is out of date with a package.json; run 'pnpm install' and commit the lockfile"
else
  echo "warning: pnpm is not on PATH here, so the lockfile freshness gate did not run" >&2
fi

echo "Release consistency check passed at v${version} (postgres image ${compose_image})."
