#!/usr/bin/env bash
set -Eeuo pipefail

export ORCASYNAPSE_INSTALLER_LIBRARY_ONLY=1
export TERM=dumb

SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../install.sh
. "${SCRIPT_ROOT}/install.sh"

test_root="$(mktemp -d /tmp/orcasynapse-recovery-test.XXXXXX)"
temporary_root="${test_root}"
finish() {
  cleanup
  rm -rf -- "${test_root}"
}
trap finish EXIT

[[ "$(format_transfer_bytes 1536)" == "1.5 KB" ]]
printf 'progress-test-payload\n' > "${test_root}/download-source"
download_with_progress "Verify local transfer progress" \
  "file://${test_root}/download-source" "${test_root}/download-target"
cmp "${test_root}/download-source" "${test_root}/download-target"
# The progress UI has one source of truth: tree-resident scripts source the
# library, self-contained scripts embed it, and the sync tool proves the
# embedded regions have not drifted.
grep -Fq 'scripts/lib/installer-ui.sh' "${SCRIPT_ROOT}/scripts/install-orcasynapse.sh"
grep -Fq '>>> ORCASYNAPSE-INSTALLER-UI v1' "${SCRIPT_ROOT}/scripts/install-agentic-node.sh"
bash "${SCRIPT_ROOT}/scripts/sync-installer-ui.sh" --check

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
install -d -m 0700 "${ORCASYNAPSE_INSTALL_DIR}/.local/state"
printf 'https\n' > "${ORCASYNAPSE_INSTALL_DIR}/.local/state/public-scheme"
printf 'old-source\n' > "${ORCASYNAPSE_INSTALL_DIR}/obsolete-marker"

export ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade
unset ORCASYNAPSE_CONFIRM_ERASE || true
if (choose_existing_install_action 1 "${new_commit}"); then
  printf 'pre-epoch installation unexpectedly accepted a preserving upgrade\n' >&2
  exit 1
fi
printf 'hermes-native-v1\n' > "${ORCASYNAPSE_INSTALL_DIR}/.local/state/schema-epoch"
install_source_tree "${new_commit}" "${source_dir}"

[[ "$(<"${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit")" == "${new_commit}" ]]
[[ "$(<"${ORCASYNAPSE_INSTALL_DIR}/.local/secrets/recovery-material")" == "preserve-me" ]]
# The operator's public-scheme declaration lives under .local/state, not with
# the secrets. An upgrade that carried the secrets but dropped the state would
# return a TLS deployment to the http default on its next run, without saying
# so -- the same silent downgrade the declaration exists to prevent.
[[ "$(<"${ORCASYNAPSE_INSTALL_DIR}/.local/state/public-scheme")" == "https" ]]
[[ "$(<"${ORCASYNAPSE_INSTALL_DIR}/.local/state/schema-epoch")" == "hermes-native-v1" ]]
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
