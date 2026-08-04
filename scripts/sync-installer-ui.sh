#!/usr/bin/env bash
# Keeps the embedded UI regions of the self-contained installer scripts
# identical to scripts/lib/installer-ui.sh. Default mode rewrites the regions
# in place; --check verifies them and fails with a diff on drift. CI runs
# --check, so the sync tool and the drift test are one implementation.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${ROOT}"

LIBRARY="scripts/lib/installer-ui.sh"
BEGIN_MARKER='# >>> ORCASYNAPSE-INSTALLER-UI v1 - generated from scripts/lib/installer-ui.sh; edit the library, then run: bash scripts/sync-installer-ui.sh >>>'
END_MARKER='# <<< ORCASYNAPSE-INSTALLER-UI <<<'
TARGETS=(install.sh scripts/install-agentic-node.sh scripts/remove-agentic-node.sh)

mode="${1:-sync}"
case "${mode}" in
  sync|--check) ;;
  *)
    printf 'usage: bash scripts/sync-installer-ui.sh [--check]\n' >&2
    exit 2
    ;;
esac

[[ -r "${LIBRARY}" ]] || { printf 'FAIL missing %s\n' "${LIBRARY}" >&2; exit 1; }

assert_markers() {
  local target="$1" begins ends
  begins="$(grep -cF "${BEGIN_MARKER}" "${target}")" || true
  ends="$(grep -cF "${END_MARKER}" "${target}")" || true
  if [[ "${begins}" != "1" || "${ends}" != "1" ]]; then
    printf 'FAIL %s: expected exactly one begin and one end ORCASYNAPSE-INSTALLER-UI marker (found %s/%s)\n' \
      "${target}" "${begins}" "${ends}" >&2
    exit 1
  fi
}

extract_region() {
  awk -v begin="${BEGIN_MARKER}" -v end="${END_MARKER}" '
    $0 == end { inside = 0 }
    inside { print }
    $0 == begin { inside = 1 }
  ' "$1"
}

drift=0
for target in "${TARGETS[@]}"; do
  assert_markers "${target}"
  if [[ "${mode}" == "--check" ]]; then
    if ! diff -u --label "${LIBRARY}" --label "${target} (embedded)" "${LIBRARY}" <(extract_region "${target}"); then
      drift=1
    fi
    continue
  fi
  replacement="$(mktemp)"
  awk -v begin="${BEGIN_MARKER}" -v end="${END_MARKER}" -v library="${LIBRARY}" '
    $0 == begin {
      print
      while ((getline line < library) > 0) print line
      close(library)
      skipping = 1
      next
    }
    $0 == end { skipping = 0; print; next }
    !skipping { print }
  ' "${target}" > "${replacement}"
  if ! bash -n "${replacement}"; then
    rm -f -- "${replacement}"
    printf 'FAIL %s: the refreshed script does not parse\n' "${target}" >&2
    exit 1
  fi
  mv -f -- "${replacement}" "${target}"
  printf 'synced %s\n' "${target}"
done

if [[ "${mode}" == "--check" ]]; then
  if (( drift == 0 )); then
    printf 'Installer UI regions match %s.\n' "${LIBRARY}"
  fi
  exit "${drift}"
fi
