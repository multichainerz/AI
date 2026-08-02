#!/usr/bin/env bash
set -Eeuo pipefail

export ORCASYNAPSE_INSTALLER_LIBRARY_ONLY=1
export TERM=dumb

SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../install.sh
. "${SCRIPT_ROOT}/install.sh"

test_root="$(mktemp -d /tmp/orcasynapse-recovery-test.XXXXXX)"
finish() {
  cleanup
  rm -rf -- "${test_root}"
}
trap finish EXIT

old_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
new_commit="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
source_dir="${test_root}/release"
install -d -m 0700 "${source_dir}/scripts"
printf 'name: orcasynapse\n' > "${source_dir}/compose.yaml"
printf '#!/usr/bin/env bash\n' > "${source_dir}/scripts/install-orcasynapse.sh"
printf 'new-source\n' > "${source_dir}/release-marker"

ORCASYNAPSE_INSTALL_DIR="${test_root}/verified-install"
install -d -m 0750 "${ORCASYNAPSE_INSTALL_DIR}/scripts" "${ORCASYNAPSE_INSTALL_DIR}/.local/secrets"
printf 'name: orcasynapse\n' > "${ORCASYNAPSE_INSTALL_DIR}/compose.yaml"
printf '#!/usr/bin/env bash\n' > "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
printf '%s' "${old_commit}" > "${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit"
printf 'preserve-me\n' > "${ORCASYNAPSE_INSTALL_DIR}/.local/secrets/recovery-material"
printf 'old-source\n' > "${ORCASYNAPSE_INSTALL_DIR}/obsolete-marker"

export ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade
unset ORCASYNAPSE_CONFIRM_ERASE || true
install_source_tree "${new_commit}" "${source_dir}"

[[ "$(<"${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit")" == "${new_commit}" ]]
[[ "$(<"${ORCASYNAPSE_INSTALL_DIR}/.local/secrets/recovery-material")" == "preserve-me" ]]
[[ -f "${ORCASYNAPSE_INSTALL_DIR}/release-marker" ]]
[[ ! -e "${ORCASYNAPSE_INSTALL_DIR}/obsolete-marker" ]]

ORCASYNAPSE_INSTALL_DIR="${test_root}/unverified-residue"
install -d -m 0750 "${ORCASYNAPSE_INSTALL_DIR}"
printf 'remove-me\n' > "${ORCASYNAPSE_INSTALL_DIR}/residue"
export ORCASYNAPSE_EXISTING_INSTALL_ACTION=erase
export ORCASYNAPSE_CONFIRM_ERASE=ERASE
install_source_tree "${new_commit}" "${source_dir}"

[[ "$(<"${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit")" == "${new_commit}" ]]
[[ -f "${ORCASYNAPSE_INSTALL_DIR}/release-marker" ]]
[[ ! -e "${ORCASYNAPSE_INSTALL_DIR}/residue" ]]

printf 'Existing-installation update and clean-reinstall paths verified.\n'
