#!/usr/bin/env bash
# Static guard: every workspace package that a containerized app depends on
# (transitively) must have its package.json copied into the image before
# `pnpm install --frozen-lockfile`, or the install fails on the missing
# workspace link. This prevents a fresh VM1 image from omitting an internal
# package that is present only in the developer workspace.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${ROOT}"
command -v node >/dev/null 2>&1 || { echo "node is required for this check" >&2; exit 1; }

# Workspace package name -> directory.
declare -A DIR_BY_NAME
for manifest in apps/*/package.json packages/*/package.json; do
  name="$(node -p "require('./${manifest}').name")"
  DIR_BY_NAME["${name}"]="${manifest%/package.json}"
done

workspace_dependencies() {
  node -p "
    const manifest = require('./$1/package.json');
    Object.entries({ ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) })
      .filter(([, version]) => String(version).startsWith('workspace:'))
      .map(([name]) => name)
      .join(' ');
  "
}

closure_for() {
  local app_dir="$1"
  declare -A seen=()
  local queue=("${app_dir}") current dependency name
  while (( ${#queue[@]} )); do
    current="${queue[0]}"
    queue=("${queue[@]:1}")
    [[ -n "${seen[${current}]:-}" ]] && continue
    seen["${current}"]=1
    for name in $(workspace_dependencies "${current}"); do
      dependency="${DIR_BY_NAME[${name}]:-}"
      if [[ -z "${dependency}" ]]; then
        echo "unknown workspace dependency '${name}' in ${current}" >&2
        exit 1
      fi
      queue+=("${dependency}")
    done
  done
  printf '%s\n' "${!seen[@]}"
}

status=0
check_dockerfile() {
  local dockerfile="$1" app_dir="$2" member members
  members="$(closure_for "${app_dir}")"
  while IFS= read -r member; do
    if ! grep -Fq "COPY ${member}/package.json" "${dockerfile}"; then
      echo "FAIL ${dockerfile}: missing manifest copy for ${member} — add: COPY ${member}/package.json ${member}/package.json" >&2
      status=1
    fi
  done <<< "${members}"
}

check_dockerfile Dockerfile.api apps/api
check_dockerfile Dockerfile.worker apps/worker
check_dockerfile Dockerfile.web apps/web

(( status == 0 )) && echo "Docker build closure check passed."
exit "${status}"
