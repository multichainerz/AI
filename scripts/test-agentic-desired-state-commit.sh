#!/usr/bin/env bash
set -Eeuo pipefail

# What the VM2 desired-state client does with the Hermes commit the control
# plane names, exercised against the real script rather than a paraphrase of it.
#
# The client is extracted from its heredoc in install-agentic-node.sh and run
# with stubbed `curl`, `systemctl`, `git` and `sleep` on PATH, so every branch
# -- including the ones that install, fail and roll back -- runs end to end
# without a Hermes checkout or a live control plane.
#
# Deliberately does NOT source install-agentic-node.sh. Sourcing installs the
# installer's own `trap cleanup EXIT`, which replaces this file's, and a failed
# assertion then exits 0 with every check silently vacuous.

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

# The client writes with `install -o root -g root`, exactly as it does on a real
# node. Refused rather than skipped: a test that reports success while never
# running the code under test is worse than one that does not run.
[[ "${EUID}" -eq 0 ]] || {
  printf 'this test must run as root; it exercises the client'"'"'s own root-owned writes\n' >&2
  exit 1
}

OLD_COMMIT="1111111111111111111111111111111111111111"
NEW_COMMIT="2222222222222222222222222222222222222222"
THIRD_COMMIT="3333333333333333333333333333333333333333"
NODE_ID="9de260d7-bc51-4558-9d20-06916d393072"
DESIRED_STATE_PATH="/api/v1/runtime-nodes/${NODE_ID}/desired-state"
INSTALL_URL="http://install.invalid/hermes-install.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# The script under test, lifted out of the installer that writes it.

CLIENT="${TEST_ROOT}/hermes-desired-state.sh"
awk "/hermes-desired-state.sh <<'DESIREDSTATE'/{flag=1;next} /^DESIREDSTATE\$/{flag=0} flag" \
  "${INSTALLER}" > "${CLIENT}"
chmod 0755 "${CLIENT}"

# Guards the failure that would make every case below vacuous: a renamed marker
# leaving an empty file that runs, does nothing, and exits 0.
[[ "$(wc -l < "${CLIENT}")" -gt 150 ]] \
  || fail "the desired-state client could not be extracted from ${INSTALLER}"
head -n 1 "${CLIENT}" | grep -Fq '#!/usr/bin/env bash' \
  || fail "the extracted client does not start with its shebang"
grep -Fq 'orcasynapse-runtime-desired-state/v1' "${CLIENT}" \
  || fail "the extracted client is not the desired-state client"
bash -n "${CLIENT}" || fail "the extracted client is not valid bash"

# ---------------------------------------------------------------------------
# One case: a fresh state root, a signed document, and a stubbed world.

CASE_ROOT=""
STUB_DIR=""
STATE_ROOT=""

prepare_case() {
  local name="$1" document_commit="$2"
  CASE_ROOT="${TEST_ROOT}/${name}"
  STUB_DIR="${CASE_ROOT}/stub"
  STATE_ROOT="${CASE_ROOT}/state"
  mkdir -p "${STUB_DIR}/bin" "${STATE_ROOT}/identity" "${STATE_ROOT}/data" "${CASE_ROOT}/managed"

  openssl genpkey -algorithm ED25519 -out "${STUB_DIR}/control-plane.key" 2>/dev/null
  openssl pkey -in "${STUB_DIR}/control-plane.key" -pubout \
    -out "${STATE_ROOT}/control-plane-key.pem" 2>/dev/null
  openssl genpkey -algorithm ED25519 -out "${STATE_ROOT}/identity/node.key" 2>/dev/null

  printf '%s' "http://127.0.0.1:59123" > "${STATE_ROOT}/control-plane-url"
  printf '%s' "${NODE_ID}" > "${STATE_ROOT}/node-id"
  printf '%s' "${DESIRED_STATE_PATH}" > "${STATE_ROOT}/desired-state-path"
  printf '%s' "${OLD_COMMIT}" > "${STATE_ROOT}/commit-pin"
  printf 'API_SERVER_KEY=%s\n' "gateway-key" > "${STATE_ROOT}/data/.env"
  printf 'platform_toolsets:\n  api_server:\n    - no_mcp\n' > "${CASE_ROOT}/managed/config.yaml"

  # The document, signed over exactly the bytes the client will verify.
  if [[ "${document_commit}" == "__absent__" ]]; then
    jq -cn --arg nodeId "${NODE_ID}" \
      '{format:"orcasynapse-runtime-desired-state/v1",nodeId:$nodeId,generatedAt:"2026-08-15T00:00:00.000Z",admittedToolsets:["clarify"]}' \
      > "${STUB_DIR}/document.json"
  else
    jq -cn --arg nodeId "${NODE_ID}" --arg commit "${document_commit}" \
      '{format:"orcasynapse-runtime-desired-state/v1",nodeId:$nodeId,generatedAt:"2026-08-15T00:00:00.000Z",admittedToolsets:["clarify"],hermesCommit:$commit}' \
      > "${STUB_DIR}/document.json"
  fi
  openssl pkeyutl -sign -rawin -inkey "${STUB_DIR}/control-plane.key" \
    -in "${STUB_DIR}/document.json" -out "${STUB_DIR}/document.sig"
  write_response "${STUB_DIR}/document.json"

  printf '200' > "${STUB_DIR}/http-status"
  printf '0' > "${STUB_DIR}/health-status"
  printf '%s' "${OLD_COMMIT}" > "${STUB_DIR}/head-commit"
  printf '[{"name":"clarify"},{"name":"bfl"}]' > "${STUB_DIR}/catalogue.json"
  : > "${STUB_DIR}/order.log"

  write_stubs
}

# The signed envelope, built from whichever document bytes it is handed. Taking
# the payload as an argument is what lets a case sign one document and serve a
# different one.
write_response() {
  jq -cn \
    --arg documentBase64 "$(base64 -w0 < "$1")" \
    --arg signature "$(base64 -w0 < "${STUB_DIR}/document.sig")" \
    '{documentBase64:$documentBase64,signature:$signature,publicKeyFingerprint:"stub-fingerprint"}' \
    > "${STUB_DIR}/response.json"
}

write_stubs() {
  cat > "${STUB_DIR}/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -u
stub="${ORCASYNAPSE_TEST_STUB_DIR}"
url=""
out=""
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index++)); do
  case "${arguments[index]}" in
    --output) out="${arguments[index + 1]}" ;;
    http://*|https://*) url="${arguments[index]}" ;;
  esac
done
case "${url}" in
  *desired-state*)
    [[ -n "${out}" ]] && cp "${stub}/response.json" "${out}"
    printf '%s' "$(cat "${stub}/http-status")"
    ;;
  *hermes-install.sh*) cat "${stub}/hermes-installer.sh" ;;
  *health*) exit "$(cat "${stub}/health-status")" ;;
  *toolsets*) cat "${stub}/catalogue.json" ;;
  *) exit 1 ;;
esac
CURL

  cat > "${STUB_DIR}/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
set -u
stub="${ORCASYNAPSE_TEST_STUB_DIR}"
printf 'systemctl %s\n' "$*" >> "${stub}/order.log"
if [[ "${1:-}" == "stop" && -e "${stub}/stop-fails" ]]; then
  exit 1
fi
exit 0
SYSTEMCTL

  cat > "${STUB_DIR}/bin/git" <<'GIT'
#!/usr/bin/env bash
set -u
stub="${ORCASYNAPSE_TEST_STUB_DIR}"
[[ -s "${stub}/head-commit" ]] || exit 1
printf '%s\n' "$(cat "${stub}/head-commit")"
GIT

  # A no-op so the ninety-attempt health wait costs nothing here. The wait is
  # counted in attempts rather than seconds precisely so this is possible.
  printf '#!/usr/bin/env bash\nexit 0\n' > "${STUB_DIR}/bin/sleep"
  printf '#!/usr/bin/env bash\nexit 0\n' > "${STUB_DIR}/bin/journalctl"

  # What `curl -fsSL <install url> | bash -s -- --commit X --force-commit` runs.
  cat > "${STUB_DIR}/hermes-installer.sh" <<'HERMES'
#!/usr/bin/env bash
set -u
stub="${ORCASYNAPSE_TEST_STUB_DIR}"
commit=""
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index++)); do
  [[ "${arguments[index]}" == "--commit" ]] && commit="${arguments[index + 1]}"
done
printf 'install %s\n' "${commit}" >> "${stub}/order.log"
if [[ -e "${stub}/install-fails" ]]; then
  # A failed install can still have rewritten the checkout.
  [[ -e "${stub}/install-leaves" ]] && cp "${stub}/install-leaves" "${stub}/head-commit"
  exit 1
fi
# `install-lies` is upstream ignoring --commit: exit 0, checkout unmoved.
[[ -e "${stub}/install-lies" ]] || printf '%s' "${commit}" > "${stub}/head-commit"
exit 0
HERMES

  chmod 0755 "${STUB_DIR}/bin/"* "${STUB_DIR}/hermes-installer.sh"
}

# Runs the client for the prepared case and records its exit status and output.
# The status is captured from the command itself, never through a pipe.
run_client() {
  local status=0
  env -i \
    PATH="${STUB_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME="${CASE_ROOT}" \
    ORCASYNAPSE_TEST_STUB_DIR="${STUB_DIR}" \
    ORCASYNAPSE_HERMES_STATE_ROOT="${STATE_ROOT}" \
    ORCASYNAPSE_HERMES_MANAGED_DIR="${CASE_ROOT}/managed" \
    ORCASYNAPSE_HERMES_INSTALL_DIR="${CASE_ROOT}/hermes-agent" \
    ORCASYNAPSE_HERMES_INSTALL_URL="${INSTALL_URL}" \
    ORCASYNAPSE_HERMES_HEALTH_URL="http://127.0.0.1:8642/health" \
    bash "${CLIENT}" > "${CASE_ROOT}/stdout" 2> "${CASE_ROOT}/stderr" || status=$?
  printf '%s' "${status}" > "${CASE_ROOT}/status"
}

client_status() { cat "${CASE_ROOT}/status"; }
recorded_pin() { cat "${STATE_ROOT}/commit-pin"; }
journal() { cat "${CASE_ROOT}/stderr"; }
order() { cat "${STUB_DIR}/order.log"; }

# Proves the harness itself can fail: a case whose stubs never ran would report
# an empty order log, and several assertions below are about what is absent.
assert_ran() {
  grep -Fq 'clarify' "${STATE_ROOT}/admitted-toolsets" \
    || fail "$1: the client did not get as far as recording the admitted toolsets"
}

# The allowlist actually reaching the runtime's managed policy, which is a
# different fact from the document having been read. Asserting only the
# recorded document passed a client that skipped the policy entirely whenever
# a runtime move failed -- the exact regression this is here to catch.
assert_allowlist_applied() {
  grep -Fqx '    - clarify' "${CASE_ROOT}/managed/config.yaml" \
    || fail "$1: the admitted toolset never reached the managed policy"
  grep -Fq 'disabled_toolsets' "${CASE_ROOT}/managed/config.yaml" \
    || fail "$1: the unadmitted toolsets were never disabled in the managed policy"
}

# ---------------------------------------------------------------------------
# A new commit is installed, and only then recorded.

prepare_case "moves" "${NEW_COMMIT}"
run_client
[[ "$(client_status)" == "0" ]] || fail "moves: the client failed: $(journal)"
[[ "$(recorded_pin)" == "${NEW_COMMIT}" ]] || fail "moves: the pin says $(recorded_pin)"
assert_ran "moves"
assert_allowlist_applied "moves"
grep -Fq "install ${NEW_COMMIT}" "${STUB_DIR}/order.log" || fail "moves: Hermes was never installed at the new commit"
# Drained, not killed, and drained *before* the checkout was rewritten.
grep -Fq 'systemctl stop orcasynapse-hermes' "${STUB_DIR}/order.log" || fail "moves: the runtime was never stopped"
if grep -Eq 'systemctl (kill|--signal|-s SIGKILL)' "${STUB_DIR}/order.log"; then
  fail "moves: the runtime was killed rather than drained"
fi
stop_line="$(grep -n 'systemctl stop' "${STUB_DIR}/order.log" | head -n 1 | cut -d: -f1)"
install_line="$(grep -n "install ${NEW_COMMIT}" "${STUB_DIR}/order.log" | head -n 1 | cut -d: -f1)"
(( stop_line < install_line )) || fail "moves: the install ran before the runtime was stopped"
grep -Fq 'systemctl start orcasynapse-hermes' "${STUB_DIR}/order.log" || fail "moves: the runtime was never started again"
journal | grep -Fq "the Hermes runtime is now at ${NEW_COMMIT}" || fail "moves: the journal does not record the move"

# ---------------------------------------------------------------------------
# The commit it is already on is not an instruction to reinstall.

prepare_case "unchanged" "${OLD_COMMIT}"
run_client
[[ "$(client_status)" == "0" ]] || fail "unchanged: the client failed: $(journal)"
[[ "$(recorded_pin)" == "${OLD_COMMIT}" ]] || fail "unchanged: the pin moved to $(recorded_pin)"
assert_ran "unchanged"
assert_allowlist_applied "unchanged"
if grep -Fq 'systemctl stop' "${STUB_DIR}/order.log"; then
  fail "unchanged: the runtime was stopped for a commit it was already on"
fi
if grep -Fq 'install ' "${STUB_DIR}/order.log"; then
  fail "unchanged: Hermes was reinstalled for a commit it was already on"
fi

# ---------------------------------------------------------------------------
# A control plane that says nothing about the commit moves nothing, and still
# gets its toolset allowlist applied.

prepare_case "silent" "__absent__"
run_client
[[ "$(client_status)" == "0" ]] || fail "silent: the client failed: $(journal)"
[[ "$(recorded_pin)" == "${OLD_COMMIT}" ]] || fail "silent: the pin moved to $(recorded_pin)"
assert_ran "silent"
assert_allowlist_applied "silent"
if grep -Fq 'install ' "${STUB_DIR}/order.log"; then
  fail "silent: an absent commit was treated as an instruction"
fi

# ---------------------------------------------------------------------------
# Anything that is not a full SHA is refused before anything is applied.

for bad_commit in "main" "${NEW_COMMIT:0:12}" "${NEW_COMMIT:0:39}z" "../../etc/passwd"; do
  prepare_case "malformed" "${bad_commit}"
  run_client
  [[ "$(client_status)" != "0" ]] || fail "malformed(${bad_commit}): the client reported success"
  [[ "$(recorded_pin)" == "${OLD_COMMIT}" ]] || fail "malformed(${bad_commit}): the pin moved"
  [[ ! -e "${STATE_ROOT}/admitted-toolsets" ]] \
    || fail "malformed(${bad_commit}): the document was acted on despite a commit it could not read"
  [[ ! -s "${STUB_DIR}/order.log" ]] || fail "malformed(${bad_commit}): $(order)"
  journal | grep -Fq 'not a 40-character SHA' || fail "malformed(${bad_commit}): the journal does not say why"
done

# ---------------------------------------------------------------------------
# An unsigned or tampered document moves nothing at all.

prepare_case "tampered" "${OLD_COMMIT}"
jq -c --arg commit "${NEW_COMMIT}" '.hermesCommit = $commit' "${STUB_DIR}/document.json" \
  > "${STUB_DIR}/tampered.json"
write_response "${STUB_DIR}/tampered.json"
run_client
[[ "$(client_status)" != "0" ]] || fail "tampered: a document signed over other bytes was accepted"
[[ "$(recorded_pin)" == "${OLD_COMMIT}" ]] || fail "tampered: the pin moved on an unverified document"
[[ ! -e "${STATE_ROOT}/admitted-toolsets" ]] || fail "tampered: an unverified document was applied"
[[ ! -s "${STUB_DIR}/order.log" ]] || fail "tampered: $(order)"
journal | grep -Fq 'signature did not verify' || fail "tampered: the journal does not say why"

# ---------------------------------------------------------------------------
# An install that fails leaves the node on its previous pin, restarted, and
# still governed -- and says so.

prepare_case "install-fails" "${NEW_COMMIT}"
: > "${STUB_DIR}/install-fails"
run_client
[[ "$(client_status)" != "0" ]] || fail "install-fails: a failed move reported success"
[[ "$(recorded_pin)" == "${OLD_COMMIT}" ]] || fail "install-fails: the pin says $(recorded_pin)"
grep -Fq "install ${NEW_COMMIT}" "${STUB_DIR}/order.log" || fail "install-fails: the new commit was never attempted"
grep -Fq "install ${OLD_COMMIT}" "${STUB_DIR}/order.log" || fail "install-fails: the previous commit was not restored"
grep -Fq 'systemctl start orcasynapse-hermes' "${STUB_DIR}/order.log" || fail "install-fails: the runtime was left stopped"
journal | grep -Fq "could not be brought up at ${NEW_COMMIT}" || fail "install-fails: the journal does not record it"
# The failed move must not take the toolset allowlist down with it: a version
# that would not move must still be a runtime that stays governed.
assert_ran "install-fails"
assert_allowlist_applied "install-fails"

# ---------------------------------------------------------------------------
# An install that reports success without moving the checkout is a failed move.
# Upstream ignores --commit when the checkout is already newer, so the exit
# status of the installer is not evidence of anything.

prepare_case "install-lies" "${NEW_COMMIT}"
: > "${STUB_DIR}/install-lies"
run_client
[[ "$(client_status)" != "0" ]] || fail "install-lies: an unmoved checkout reported success"
[[ "$(recorded_pin)" == "${OLD_COMMIT}" ]] || fail "install-lies: the pin claims ${NEW_COMMIT} was installed"
journal | grep -Fq "could not be brought up at ${NEW_COMMIT}" || fail "install-lies: the journal does not record it"

# ---------------------------------------------------------------------------
# A runtime that will not stop is not overruled.

prepare_case "will-not-stop" "${NEW_COMMIT}"
: > "${STUB_DIR}/stop-fails"
run_client
[[ "$(client_status)" != "0" ]] || fail "will-not-stop: reported success"
[[ "$(recorded_pin)" == "${OLD_COMMIT}" ]] || fail "will-not-stop: the pin moved"
if grep -Fq 'install ' "${STUB_DIR}/order.log"; then
  fail "will-not-stop: Hermes was reinstalled underneath a runtime that never stopped"
fi
journal | grep -Fq 'would not stop' || fail "will-not-stop: the journal does not say why"

# ---------------------------------------------------------------------------
# A rollback that also fails leaves some third commit on disk. The pin must
# report what is there, not what was wanted or what used to be.

prepare_case "rollback-fails" "${NEW_COMMIT}"
: > "${STUB_DIR}/install-fails"
printf '%s' "${THIRD_COMMIT}" > "${STUB_DIR}/install-leaves"
run_client
[[ "$(client_status)" != "0" ]] || fail "rollback-fails: reported success"
[[ "$(recorded_pin)" == "${THIRD_COMMIT}" ]] \
  || fail "rollback-fails: the pin says $(recorded_pin) while the checkout is at ${THIRD_COMMIT}"
journal | grep -Fq "the Hermes checkout is at ${THIRD_COMMIT}" \
  || fail "rollback-fails: the journal does not record the commit actually installed"

printf 'Agentic System desired-state commit checks passed.\n'
