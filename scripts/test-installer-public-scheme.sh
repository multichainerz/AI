#!/usr/bin/env bash
# The operator's public-scheme declaration, measured across the sudo boundary.
#
# The bundled proxy takes the scheme browsers really use from an operator
# declaration rather than from an inbound header, and that declaration is the
# only thing that puts Secure on the administrator and enterprise session
# cookies behind an upstream TLS terminator. The mechanism worked; the
# declaration could not reach it. Every command deploy/BOOTSTRAP.md prints is a
# sudo command, stock sudoers is `Defaults env_reset`, and an exported variable
# does not survive that -- so a TLS deployment installed itself on http without
# a word, and rotate-installation-key.sh force-recreated the web container on
# http even on installs that had been correct before it ran.
#
# Everything below crosses a real sudo, invoked from a script file, with the
# variable under test exported in the caller's environment. That last part is
# the point: an inline `VAR=x sudo something-that-echoes-$VAR` is expanded by
# the calling shell and reports a pass the real invocation never had. The first
# section proves the boundary is actually there on this host before any
# conclusion is drawn from it, because a measurement that cannot come out
# negative is not a measurement.
#
# docker and curl are stubbed, so this runs in seconds and needs no daemon. The
# docker stub is the measuring instrument rather than a convenience:
# compose.yaml interpolates ${ORCASYNAPSE_PUBLIC_SCHEME} out of the environment
# of the `docker compose` process, so the environment that process was handed is
# exactly what the web container gets rendered with.
#
# PATH and ORCASYNAPSE_HTTP_PORT are handed across sudo with `env` so the stubs
# are reachable under secure_path and the port preflight cannot collide with
# whatever the host already runs on 8080. Neither is the value under test, and
# `sudo env PATH=...` is asserted below to still drop ORCASYNAPSE_PUBLIC_SCHEME.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d /var/tmp/orcasynapse-public-scheme.XXXXXX)"
STUBS="${WORK}/stubs"
STUB_LOG="${WORK}/docker-invocations.log"
TEST_PORT="${ORCASYNAPSE_PUBLIC_SCHEME_TEST_PORT:-18391}"
failures=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

cleanup() {
  # The installer prints a generated Installation Key and temporary password to
  # stdout even on this throwaway tree, so the captures are shredded rather than
  # unlinked and are never echoed.
  local capture
  for capture in "${WORK}"/*.out; do
    [[ -f "${capture}" ]] && shred -u "${capture}" 2>/dev/null
  done
  # The release fixtures hold root-owned 0700 state written under sudo.
  sudo rm -rf -- "${WORK}" 2>/dev/null || rm -rf -- "${WORK}"
}
trap cleanup EXIT

command -v sudo >/dev/null 2>&1 || { echo "this test needs sudo" >&2; exit 2; }
sudo -n true 2>/dev/null || { echo "this test needs passwordless sudo" >&2; exit 2; }

install -d -m 0755 "${STUBS}"
: > "${STUB_LOG}"
# Root appends through the stub; the caller reads it back.
chmod 0666 "${STUB_LOG}"

{
  printf '%s\n' '#!/usr/bin/env bash'
  printf 'log=%s\n' "${STUB_LOG}"
  printf '%s\n' \
    'printf "%s | ORCASYNAPSE_PUBLIC_SCHEME=%s\n" "$*" "${ORCASYNAPSE_PUBLIC_SCHEME:-UNSET}" >> "${log}"' \
    'case "$*" in' \
    '  *"volume inspect"*) exit 1 ;;' \
    '  *"exec -T api node"*) printf "{\"created\":true}\n" ;;' \
    'esac' \
    'exit 0'
} > "${STUBS}/docker"
chmod 0755 "${STUBS}/docker"

# Readiness polling only. Returning success immediately is honest here: this
# test is about which scheme reached the proxy, not about whether a stack came up.
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${STUBS}/curl"
chmod 0755 "${STUBS}/curl"

printf '%s\n' '#!/usr/bin/env bash' \
  'printf "ORCASYNAPSE_PUBLIC_SCHEME=[%s]\n" "${ORCASYNAPSE_PUBLIC_SCHEME:-UNSET}"' \
  > "${WORK}/show-scheme.sh"
chmod 0755 "${WORK}/show-scheme.sh"

# A release bundle as an operator receives one: an extracted tree, not a
# checkout. Only what these two scripts read is copied.
stage_release() {
  local release="$1"
  install -d -m 0755 "${release}/packages/contracts/src"
  cp -a -- "${ROOT}/scripts" "${release}/scripts"
  cp -- "${ROOT}/compose.yaml" "${release}/compose.yaml"
  cp -- "${ROOT}/packages/contracts/src/version.ts" "${release}/packages/contracts/src/version.ts"
}

# The last scheme a given docker compose sub-command was invoked with.
scheme_handed_to() {
  local needle="$1" line
  line="$(grep -F -- "${needle}" "${STUB_LOG}" | tail -n 1)"
  if [[ -z "${line}" ]]; then
    printf 'NO-SUCH-INVOCATION\n'
    return
  fi
  printf '%s\n' "${line##*ORCASYNAPSE_PUBLIC_SCHEME=}"
}

state_value() {
  local release="$1"
  sudo cat "${release}/.local/state/public-scheme" 2>/dev/null || printf 'NO-STATE\n'
}

printf '\n=== the sudo boundary is real on this host ===\n'
observed="$(ORCASYNAPSE_PUBLIC_SCHEME=https sudo "${WORK}/show-scheme.sh")"
if [[ "${observed}" != "ORCASYNAPSE_PUBLIC_SCHEME=[UNSET]" ]]; then
  printf 'This host'"'"'s sudoers hands the caller environment through (%s).\n' "${observed}" >&2
  printf 'Every measurement below would report a pass the documented invocation never has.\n' >&2
  exit 2
fi
pass "an exported declaration does not survive sudo (${observed})"
observed="$(ORCASYNAPSE_PUBLIC_SCHEME=https sudo env PATH="${STUBS}:${PATH}" "${WORK}/show-scheme.sh")"
if [[ "${observed}" == "ORCASYNAPSE_PUBLIC_SCHEME=[UNSET]" ]]; then
  pass "the harness carries PATH across sudo and nothing else (${observed})"
else
  bad "the PATH affordance smuggled the declaration across: ${observed}"
fi

printf '\n=== an install with nothing declared stays http, and says so ===\n'
plain_release="${WORK}/plain"
stage_release "${plain_release}"
install_status=0
ORCASYNAPSE_PUBLIC_SCHEME=https sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" \
  bash "${plain_release}/scripts/install-orcasynapse.sh" \
  > "${WORK}/plain-install.out" 2>&1 || install_status=$?
if (( install_status != 0 )); then
  bad "the installer exited ${install_status} with nothing declared"
  tail -n 25 "${WORK}/plain-install.out" >&2 || true
else
  pass "the installer completed with nothing declared"
fi
observed="$(scheme_handed_to 'compose up -d --no-build')"
if [[ "${observed}" == "http" ]]; then
  pass "the web container is rendered with http when nothing was declared"
else
  bad "an undeclared install handed compose '${observed}', expected http"
fi
if grep -q 'not Secure' "${WORK}/plain-install.out"; then
  pass "the completion summary says the session cookies are not Secure"
else
  bad "an http-only install finished without saying the session cookies are not Secure"
fi
if grep -q -- '--public-scheme https' "${WORK}/plain-install.out"; then
  pass "the summary names the flag that changes it"
else
  bad "the summary does not tell the operator how to declare https"
fi

printf '\n=== the flag survives sudo, and is what carries the declaration ===\n'
tls_release="${WORK}/tls"
stage_release "${tls_release}"
install_status=0
sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" \
  bash "${tls_release}/scripts/install-orcasynapse.sh" --public-scheme https \
  > "${WORK}/tls-install.out" 2>&1 || install_status=$?
if (( install_status != 0 )); then
  bad "the installer exited ${install_status} for --public-scheme https"
  tail -n 25 "${WORK}/tls-install.out" >&2 || true
else
  pass "the installer accepted --public-scheme https"
fi
observed="$(scheme_handed_to 'compose up -d --no-build')"
if [[ "${observed}" == "https" ]]; then
  pass "the web container is rendered with the declared https"
else
  bad "a declared https install handed compose '${observed}'"
fi
observed="$(state_value "${tls_release}")"
if [[ "${observed}" == "https" ]]; then
  pass "the declaration is persisted for later runs (${observed})"
else
  bad "the declaration was not persisted; state holds '${observed}'"
fi
if grep -q 'not Secure' "${WORK}/tls-install.out"; then
  bad "a declared https install warned about Secure anyway"
else
  pass "a declared https install does not warn about Secure"
fi

printf '\n=== a declared install cannot be downgraded by re-running it ===\n'
install_status=0
sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" \
  bash "${tls_release}/scripts/install-orcasynapse.sh" \
  > "${WORK}/tls-rerun.out" 2>&1 || install_status=$?
if (( install_status != 0 )); then
  bad "re-running the installer exited ${install_status}"
  tail -n 25 "${WORK}/tls-rerun.out" >&2 || true
fi
observed="$(scheme_handed_to 'compose up -d --no-build')"
if [[ "${observed}" == "https" ]]; then
  pass "a re-run with no flag reads the persisted declaration back"
else
  bad "a re-run silently downgraded the install to '${observed}'"
fi

printf '\n=== rotation cannot downgrade an install that was correct ===\n'
rotate_status=0
sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" \
  bash "${tls_release}/scripts/rotate-installation-key.sh" --confirm-revoke-recovery-sessions \
  > "${WORK}/tls-rotate.out" 2>&1 || rotate_status=$?
if (( rotate_status != 0 )); then
  bad "the documented rotation command exited ${rotate_status}"
  tail -n 25 "${WORK}/tls-rotate.out" >&2 || true
else
  pass "the documented rotation command completed"
fi
observed="$(scheme_handed_to 'compose up -d --no-build --force-recreate api web')"
if [[ "${observed}" == "https" ]]; then
  pass "break-glass rotation recreates web with the install's declared https"
else
  bad "rotation recreated web with '${observed}'; the install was https before it ran"
fi

printf '\n=== rotation on an http install says what it is doing ===\n'
rotate_status=0
sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" \
  bash "${plain_release}/scripts/rotate-installation-key.sh" --confirm-revoke-recovery-sessions \
  > "${WORK}/plain-rotate.out" 2>&1 || rotate_status=$?
if (( rotate_status != 0 )); then
  bad "rotation on the undeclared install exited ${rotate_status}"
  tail -n 25 "${WORK}/plain-rotate.out" >&2 || true
fi
observed="$(scheme_handed_to 'compose up -d --no-build --force-recreate api web')"
if [[ "${observed}" == "http" ]]; then
  pass "rotation on an undeclared install stays http"
else
  bad "rotation on an undeclared install used '${observed}'"
fi
if grep -q 'not Secure' "${WORK}/plain-rotate.out"; then
  pass "rotation tells the operator the recreated proxy carries no Secure cookie"
else
  bad "rotation recreated the proxy on http without saying so"
fi

printf '\n=== the declaration is state, not a secret ===\n'
observed="$(sudo stat -c '%a' "${tls_release}/.local/state/public-scheme" 2>/dev/null || printf 'missing')"
if [[ "${observed}" == "600" ]]; then
  pass "the persisted declaration is a 0600 file in the root-only state directory"
else
  bad "the persisted declaration has mode '${observed}'"
fi
if [[ "$(sudo ls "${tls_release}/.local/secrets" | sort | tr '\n' ' ')" \
      == "orcasynapse_database_url orcasynapse_installation_key orcasynapse_master_key postgres_password " ]]; then
  pass "nothing new was written into the secret directory"
else
  bad "the secret directory gained a file: $(sudo ls "${tls_release}/.local/secrets" | tr '\n' ' ')"
fi
# The install log is the artifact an operator sends to support. A non-secret
# operator declaration belongs in it; the key and the password never do.
if sudo grep -rq 'public-scheme=https' "${tls_release}/.local/state/"install-*.log; then
  pass "the declaration is logged as ordinary configuration"
else
  bad "the install log does not record the declared scheme"
fi
if sudo grep -rqF "$(sudo cat "${tls_release}/.local/secrets/orcasynapse_installation_key")" \
     "${tls_release}/.local/state/"install-*.log; then
  bad "the Installation Key reached the install log"
else
  pass "the Installation Key is still absent from the install log"
fi

printf '\n=== a damaged recording can be re-declared, and is never assumed ===\n'
# The recording is root-only, but a truncated write, a full disk or a
# half-restored backup leaves bytes that are neither word. Refusing to guess is
# right. Refusing the flag that repairs it is not -- and the refusal names that
# flag as the remedy, so getting this wrong sends an operator in a circle at
# break-glass time, which is the same failure this file exists to remove.
sudo cp "${tls_release}/.local/state/public-scheme" "${WORK}/public-scheme.bak"
printf 'HTTPS\n' | sudo tee "${tls_release}/.local/state/public-scheme" >/dev/null
repair_status=0
sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" \
  bash "${tls_release}/scripts/rotate-installation-key.sh" --confirm-revoke-recovery-sessions \
  --public-scheme https > "${WORK}/repair-rotate.out" 2>&1 || repair_status=$?
if (( repair_status == 0 )); then
  pass "the flag the refusal names actually repairs a damaged recording"
else
  bad "break-glass rotation is bricked by a damaged recording; --public-scheme could not rescue it"
  tail -n 15 "${WORK}/repair-rotate.out" >&2 || true
fi
observed="$(scheme_handed_to 'compose up -d --no-build --force-recreate api web')"
if [[ "${observed}" == "https" ]]; then
  pass "the repaired rotation recreates web on the re-declared https"
else
  bad "the repaired rotation used '${observed}'"
fi
if [[ "$(state_value "${tls_release}")" == "https" ]]; then
  pass "the damaged recording is replaced by the declaration that repaired it"
else
  bad "the recording is still damaged after a successful declaration"
fi
# The half that must not change: with nothing declared, a file nobody can read
# is still not evidence of http.
printf 'HTTPS\n' | sudo tee "${tls_release}/.local/state/public-scheme" >/dev/null
undeclared_status=0
sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" \
  bash "${tls_release}/scripts/rotate-installation-key.sh" --confirm-revoke-recovery-sessions \
  > "${WORK}/damaged-rotate.out" 2>&1 || undeclared_status=$?
if (( undeclared_status != 0 )); then
  pass "a damaged recording with nothing declared still refuses rather than assuming http"
else
  bad "a damaged recording was silently treated as http"
fi
sudo cp "${WORK}/public-scheme.bak" "${tls_release}/.local/state/public-scheme"

printf '\n=== a scheme that cannot be honoured is refused, not assumed ===\n'
refuses() {
  local label="$1"
  shift
  local status=0
  sudo env PATH="${STUBS}:${PATH}" ORCASYNAPSE_HTTP_PORT="${TEST_PORT}" "$@" \
    > "${WORK}/refusal.out" 2>&1 || status=$?
  if (( status != 0 )); then
    pass "${label} is refused (exit ${status})"
  else
    bad "${label} was accepted"
  fi
}
reject_release="${WORK}/reject"
stage_release "${reject_release}"
installer="${reject_release}/scripts/install-orcasynapse.sh"
rotator="${reject_release}/scripts/rotate-installation-key.sh"
refuses "--public-scheme HTTPS"      bash "${installer}" --public-scheme HTTPS
refuses "--public-scheme ftp"        bash "${installer}" --public-scheme ftp
refuses "--public-scheme with no value" bash "${installer}" --public-scheme
refuses "an unknown installer flag"  bash "${installer}" --public-schema https
refuses "a bad scheme during rotation" \
  bash "${rotator}" --confirm-revoke-recovery-sessions --public-scheme HTTPS
refuses "rotation without its confirmation" \
  bash "${rotator}" --public-scheme https

printf '\n=== the public bootstrap takes the same flag ===\n'
# install.sh is fetched and piped rather than sourced from a tree, so it carries
# its own copy of the parser. Sourced in library mode for the positive case --
# the value it hands on is an export, and an export always survives the exec
# into scripts/install-orcasynapse.sh -- and piped through sudo for the negative,
# which is the documented invocation itself and must refuse before any download.
bootstrap_probe="${WORK}/bootstrap-probe.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'export ORCASYNAPSE_INSTALLER_LIBRARY_ONLY=1' \
  '. "$1"' \
  'shift' \
  'orcasynapse_take_public_scheme_flag "$@" >/dev/null' \
  'printf "%s\n" "${ORCASYNAPSE_PUBLIC_SCHEME:-UNSET}"' \
  > "${bootstrap_probe}"
chmod 0755 "${bootstrap_probe}"
observed="$(bash "${bootstrap_probe}" "${ROOT}/install.sh" --public-scheme https 2>&1 || true)"
if [[ "${observed}" == "https" ]]; then
  pass "install.sh parses --public-scheme and exports it across the handoff"
else
  bad "install.sh did not carry --public-scheme through: ${observed}"
fi
bootstrap_status=0
# The stub PATH and a redirected install directory are containment, not
# convenience: a bootstrap that does not reject the flag falls through to
# resolve_commit and would otherwise download and install a real control plane
# into /opt on whatever host runs this test. With the stub curl it stops at an
# unresolvable commit instead, which is why the refusal is identified by its
# message and not merely by a non-zero exit.
ORCASYNAPSE_PUBLIC_SCHEME=https sudo env PATH="${STUBS}:${PATH}" \
  ORCASYNAPSE_INSTALL_DIR="${WORK}/bootstrap-target" \
  bash -s -- --public-scheme ftp \
  < "${ROOT}/install.sh" > "${WORK}/bootstrap.out" 2>&1 || bootstrap_status=$?
if (( bootstrap_status != 0 )) && grep -q 'public-scheme' "${WORK}/bootstrap.out"; then
  pass "the piped bootstrap refuses a scheme it cannot honour (exit ${bootstrap_status})"
else
  bad "the piped bootstrap did not refuse --public-scheme ftp (exit ${bootstrap_status})"
fi
# The inspect-first form BOOTSTRAP.md also prints: a downloaded file run through
# sudo rather than a pipe. Same parser, different invocation, and the invocation
# is the thing that has been wrong before.
bootstrap_status=0
ORCASYNAPSE_PUBLIC_SCHEME=https sudo env PATH="${STUBS}:${PATH}" \
  ORCASYNAPSE_INSTALL_DIR="${WORK}/bootstrap-target" \
  bash "${ROOT}/install.sh" --public-scheme ftp \
  > "${WORK}/bootstrap-file.out" 2>&1 || bootstrap_status=$?
if (( bootstrap_status != 0 )) && grep -q 'public-scheme' "${WORK}/bootstrap-file.out"; then
  pass "the downloaded-file bootstrap refuses it too (exit ${bootstrap_status})"
else
  bad "the downloaded-file bootstrap did not refuse --public-scheme ftp (exit ${bootstrap_status})"
fi

printf '\n'
if (( failures > 0 )); then
  printf 'Public-scheme declaration FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'Public-scheme declaration survives every documented invocation.\n'
