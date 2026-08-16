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

# The installation parent is created when it is absent and left exactly as found
# when it is not.
#
# `install -d -m 0750 "${install_parent}"` applies the mode either way, and this
# runs as uid 0 on every install *and* every upgrade. The default parent is
# /opt, which Ubuntu ships at 0755, so the unconditional call took traversal
# away from every non-root user of every unrelated package installed under it --
# on a host whose operator asked us to install one application. Nothing about
# that is visible while it happens, which is why it is pinned here.
existing_parent="${test_root}/parent-already-there"
mkdir -m 0755 -p "${existing_parent}"
ORCASYNAPSE_INSTALL_DIR="${existing_parent}/orcasynapse"
staging_dir=""
stage_source_tree "${new_commit}" "${source_dir}"
[[ "$(stat -c '%a' "${existing_parent}")" == "755" ]]
# ...and the directory this installer does own still gets 0750, which is what
# the Compose secrets under it depend on. Without this line the assertion above
# is satisfied by removing the mode entirely, which would be the worse bug.
[[ "$(stat -c '%a' "${staging_dir}")" == "750" ]]
rm -rf -- "${staging_dir}"

absent_parent="${test_root}/parent-not-there/deeper"
ORCASYNAPSE_INSTALL_DIR="${absent_parent}/orcasynapse"
staging_dir=""
stage_source_tree "${new_commit}" "${source_dir}"
[[ -d "${absent_parent}" ]]
rm -rf -- "${staging_dir}"
staging_dir=""

# ORCASYNAPSE_EXISTING_INSTALL_ACTION is read on the already-installed-commit
# path too.
#
# deploy/BOOTSTRAP.md tells automation to set this variable, and the one path
# that skips choose_existing_install_action -- "the commit you asked for is the
# one that is installed" -- used to skip its only reader with it: `abort`
# rebuilt and recreated the stack, and `erase` announced that existing data and
# secrets would be preserved and then preserved them. Both are the opposite of
# what was asked for, and neither said so.
same_commit="cccccccccccccccccccccccccccccccccccccccc"
ORCASYNAPSE_INSTALL_DIR="${test_root}/already-at-this-commit"
install -d -m 0750 "${ORCASYNAPSE_INSTALL_DIR}/scripts" "${ORCASYNAPSE_INSTALL_DIR}/.local/state"
printf 'name: orcasynapse\n' > "${ORCASYNAPSE_INSTALL_DIR}/compose.yaml"
printf '#!/usr/bin/env bash\nprintf "HOST-INSTALLER-RAN\\n"\n' \
  > "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
printf '%s' "${same_commit}" > "${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit"
printf 'hermes-native-v1\n' > "${ORCASYNAPSE_INSTALL_DIR}/.local/state/schema-epoch"

# Asserted before the refusals below, because those only mean anything if the
# shortcut still exists for them to decline. install_source_tree execs the host
# installer here, so it is run in a subshell and identified by what it prints.
unset ORCASYNAPSE_EXISTING_INSTALL_ACTION || true
staging_dir=""
same_commit_output="$( (install_source_tree "${same_commit}" "${source_dir}") 2>&1 )"
grep -qF 'HOST-INSTALLER-RAN' <<<"${same_commit_output}"

export ORCASYNAPSE_EXISTING_INSTALL_ACTION=abort
staging_dir=""
if same_commit_output="$( (install_source_tree "${same_commit}" "${source_dir}") 2>&1 )"; then
  printf 'abort was ignored at the already-installed commit\n' >&2
  exit 1
fi
grep -qF 'installation cancelled' <<<"${same_commit_output}"
# Negative assertions are spelled out rather than written `! grep -q ...`:
# errexit does not fire for a status inverted with `!`, so that spelling is a
# line that cannot fail.
if grep -qF 'HOST-INSTALLER-RAN' <<<"${same_commit_output}"; then
  printf 'abort ran the host installer anyway\n' >&2
  exit 1
fi

# A value nothing understands is refused rather than silently treated as
# "carry on", which is what the unconditional shortcut did with every value.
export ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgraed
staging_dir=""
if same_commit_output="$( (install_source_tree "${same_commit}" "${source_dir}") 2>&1 )"; then
  printf 'a misspelt existing-install action was accepted\n' >&2
  exit 1
fi
grep -qF 'must be upgrade, erase, or abort' <<<"${same_commit_output}"
unset ORCASYNAPSE_EXISTING_INSTALL_ACTION || true
# `erase` at the same commit shares this one condition with `abort` and is not
# exercised here: reaching its destruction step drives
# `docker compose --project-directory ... down --remove-orphans --volumes`
# against whatever daemon the host has, which is not a thing a test that
# advertises itself as needing nothing but a Linux host should do.

printf 'Existing-installation update and clean-reinstall paths verified.\n'
