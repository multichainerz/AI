#!/usr/bin/env bash
# Runs the VM2 installer's main() end to end against stubs.
#
# Every other installer test sources this script and exercises functions in
# isolation. main() -- the sequence that installs dependencies, generates an
# identity, launches the runtime, enrolls, writes the managed policy, installs
# the systemd timers and preseeds the toolset allowlist -- had never been
# executed by anything, so a break in it reached a customer's VM first.
#
# The stubs are deliberately shallow but the plumbing is real: Hermes is
# genuinely installed at the pinned commit and the pin is read back from the
# checkout, a real Ed25519 control-plane key so the desired-state signature is
# actually verified, and a real service answering /health so the readiness waits
# are not skipped.
#
# Needs Ubuntu LTS with systemd and root, plus egress to GitHub and PyPI for the
# Hermes install. WSL2 with `systemd=true` counts.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d /tmp/orcasynapse-smoke.XXXXXX)"
# Not under /tmp: the heartbeat unit sets PrivateTmp=true, so a state root
# there is invisible inside the service namespace and systemd fails the mount
# setup with 226/NAMESPACE. Production uses /var/lib, so the test does too.
STATE_ROOT="/var/lib/orcasynapse-smoke"
STUB_NAME="orcasynapse-smoke-controlplane"
RUNTIME_SERVICE="orcasynapse-hermes"
CONTROL_PLANE_PORT=8099
NODE_ID="6cf6ce1b-a8c6-49d7-b6aa-019d35888acb"
failures=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

cleanup() {
  systemctl disable --now orcasynapse-hermes-heartbeat.timer >/dev/null 2>&1 || true
  systemctl disable --now orcasynapse-hermes-desired-state.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/orcasynapse-hermes-*.service /etc/systemd/system/orcasynapse-hermes-*.timer
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl disable --now "${RUNTIME_SERVICE}" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${RUNTIME_SERVICE}.service"
  systemctl daemon-reload >/dev/null 2>&1 || true
  [[ -n "${STUB_PID:-}" ]] && kill "${STUB_PID}" 2>/dev/null || true
  rm -rf -- "${WORK}" "${STATE_ROOT}" /usr/local/lib/orcasynapse
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || { echo "run as root: sudo bash scripts/test-agentic-installer-smoke.sh" >&2; exit 2; }
[[ -d /run/systemd/system ]] || { echo "this test needs a systemd host" >&2; exit 2; }
command -v systemctl >/dev/null 2>&1 || { echo "this test needs systemd" >&2; exit 2; }

printf '
=== pinning the runtime ===
'
# No registry and no stub image: the runtime is a commit, and the installer
# resolves it by checking the tree out and reading HEAD back. Nothing to fake,
# which is a stronger test than the image path ever was.
HERMES_COMMIT="${ORCASYNAPSE_SMOKE_COMMIT:-c015663b215c0e14de4295346b0727db602cbb1d}"
pass "pinned to ${HERMES_COMMIT:0:12}"

printf '\n=== starting the stub control plane ===\n'
openssl genpkey -algorithm ED25519 -out "${WORK}/cp.key" 2>/dev/null
openssl pkey -in "${WORK}/cp.key" -pubout -out "${WORK}/cp.pub" 2>/dev/null
# Signed over the exact document bytes, which is what the node verifies.
printf '{"format":"orcasynapse-runtime-desired-state/v1","nodeId":"%s","generatedAt":"2026-08-07T00:00:00Z","admittedToolsets":["clarify","todo_write"]}' \
  "${NODE_ID}" > "${WORK}/desired.json"
openssl pkeyutl -sign -rawin -inkey "${WORK}/cp.key" -in "${WORK}/desired.json" -out "${WORK}/desired.sig"

cat > "${WORK}/controlplane.py" <<'CONTROLPLANE'
import hashlib, json, os, subprocess, sys, http.server
NODE = os.environ["NODE_ID"]


def fingerprint(raw):
    """The value the real control plane derives in parseIdentity()."""
    pem = json.loads(raw or b"{}").get("publicKeyPem", "")
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"],
                         input=pem.encode(), capture_output=True, check=True).stdout
    return hashlib.sha256(der).hexdigest()

class H(http.server.BaseHTTPRequestHandler):
    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path.endswith("/enroll"):
            return self._json({
                "node": {"id": NODE, "identityFingerprint": fingerprint(raw)},
                "heartbeatPath": f"/api/v1/runtime-nodes/{NODE}/heartbeat",
                "desiredStatePath": f"/api/v1/runtime-nodes/{NODE}/desired-state",
                "controlPlanePublicKeyPem": os.environ["CP_PUB"],
                "modelBootstrap": {
                    "provider": "custom",
                    "baseUrl": "http://127.0.0.1:8099",
                    "modelAlias": "smoke-model",
                    "apiKey": "smoke-inference-key",
                },
            })
        return self._json({"accepted": True})
    def do_GET(self):
        if self.path.endswith("/desired-state"):
            return self._json({
                "documentBase64": os.environ["DOC_B64"],
                "signature": os.environ["SIG_B64"],
                "publicKeyFingerprint": "smoke",
            })
        return self._json({"status": "ok"})
    def log_message(self, *_): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
CONTROLPLANE

CP_PUB="$(cat "${WORK}/cp.pub")" \
DOC_B64="$(base64 -w0 "${WORK}/desired.json")" \
SIG_B64="$(base64 -w0 "${WORK}/desired.sig")" \
NODE_ID="${NODE_ID}" \
  python3 "${WORK}/controlplane.py" "${CONTROL_PLANE_PORT}" >/dev/null 2>&1 &
STUB_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl --fail --silent --max-time 2 "http://127.0.0.1:${CONTROL_PLANE_PORT}/health" >/dev/null && break
  sleep 1
done
pass "stub control plane answering on ${CONTROL_PLANE_PORT}"

printf '\n=== running the installer ===\n'

jq -n --arg nodeId "${NODE_ID}" --arg commit "${HERMES_COMMIT}" --arg cp "http://127.0.0.1:${CONTROL_PLANE_PORT}" \
  '{format:"orcasynapse-hermes-enrollment/v1",nodeId:$nodeId,nodeSlug:"smoke",token:"a-one-time-claim-that-is-long-enough-to-pass",controlPlaneUrl:$cp,hermesBaseUrl:"http://127.0.0.1:8642",hermesCommit:$commit,expiresAt:"2030-01-01T00:00:00Z"}' \
  > "${WORK}/bundle.json"

set +e
ORCASYNAPSE_HERMES_STATE_ROOT="${STATE_ROOT}" \
  bash "${ROOT}/scripts/install-agentic-node.sh" "${WORK}/bundle.json"
installer_status=$?
set -e
[[ "${installer_status}" -eq 0 ]] && pass "installer main() completed" || bad "installer main() exited ${installer_status}"

printf '\n=== asserting the installed state ===\n'
systemctl is-active "${RUNTIME_SERVICE}" >/dev/null 2>&1 \
  && pass "runtime service is active" || bad "runtime service is not active"
[[ "$(git -C /usr/local/lib/hermes-agent rev-parse HEAD 2>/dev/null)" == "${HERMES_COMMIT}" ]] \
  && pass "installed commit matches the pin" || bad "installed commit does not match the pin"
curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null \
  && pass "runtime answers /health" || bad "runtime does not answer /health"
grep -q 'smoke-model' /etc/hermes/config.yaml 2>/dev/null \
  && pass "managed policy pins the enrolled model route" || bad "managed policy is missing the model route"
grep -q 'allow_lazy_installs: false' /etc/hermes/config.yaml 2>/dev/null \
  && pass "managed policy keeps the hardened baseline" || bad "managed policy lost its baseline"
# A unit file is world-readable by convention, so the gateway key must not be in
# it. It authenticates every governed call to 8642; publishing it to any local
# reader would undo the point of running the runtime as an unprivileged account.
runtime_unit="/etc/systemd/system/${RUNTIME_SERVICE}.service"
gateway_key="$(sed -n 's/^API_SERVER_KEY=//p' "${STATE_ROOT}/data/.env" 2>/dev/null || true)"
if [[ -z "${gateway_key}" ]]; then
  bad "no gateway key was written to the protected env file"
elif grep -Fq "${gateway_key}" "${runtime_unit}" 2>/dev/null; then
  bad "the gateway key is exposed in the world-readable unit file"
else
  pass "gateway key kept out of the unit file"
fi
[[ "$(stat -c '%a' "${STATE_ROOT}/data/.env" 2>/dev/null)" == "600" ]] \
  && pass "gateway key file is owner-only" || bad "gateway key file is not mode 0600"

systemctl is-enabled orcasynapse-hermes-heartbeat.timer >/dev/null 2>&1 \
  && pass "heartbeat timer enabled" || bad "heartbeat timer not enabled"
systemctl is-enabled orcasynapse-hermes-desired-state.timer >/dev/null 2>&1 \
  && pass "desired-state timer enabled" || bad "desired-state timer not enabled"

# The ai-v1.76.0 preseed: the node must already hold the admitted allowlist
# rather than waiting out the first timer tick.
if [[ -s "${STATE_ROOT}/admitted-toolsets" ]]; then
  if grep -qx 'clarify' "${STATE_ROOT}/admitted-toolsets" && grep -qx 'todo_write' "${STATE_ROOT}/admitted-toolsets"; then
    pass "desired state preseeded with the admitted toolsets"
  else
    bad "admitted-toolsets holds unexpected content: $(tr '\n' ' ' < "${STATE_ROOT}/admitted-toolsets")"
  fi
else
  bad "admitted-toolsets was not written during installation"
fi
grep -q 'disabled_toolsets' /etc/hermes/config.yaml 2>/dev/null \
  && pass "unadmitted toolsets explicitly disabled" || bad "unadmitted toolsets were not disabled"
[[ -s "${STATE_ROOT}/control-plane-key.pem" ]] \
  && pass "control-plane signing key pinned" || bad "control-plane key was not pinned"
[[ ! -e "${STATE_ROOT}/enrollment-state.json" ]] \
  && pass "resume state cleared after success" || bad "resume state survived a successful install"

printf '\n'
printf '\n=== running the decommissioner ===\n'
# The remover permanently destroys a runtime and had no test either. `script`
# allocates the pty its DESTROY prompt reads from -- it deliberately reads
# /dev/tty rather than stdin so a piped `curl | bash` cannot auto-confirm, which
# is exactly the property that makes it awkward to test and worth testing.
set +e
printf 'DESTROY\n' | ORCASYNAPSE_HERMES_STATE_ROOT="${STATE_ROOT}" \
  script -qec "bash ${ROOT}/scripts/remove-agentic-node.sh" /dev/null >"${WORK}/remove.log" 2>&1
remover_status=$?
set -e
if [[ "${remover_status}" -eq 0 ]]; then
  pass "remover completed"
else
  bad "remover exited ${remover_status}"
  tail -n 20 "${WORK}/remove.log" >&2
fi

systemctl is-active "${RUNTIME_SERVICE}" >/dev/null 2>&1 \
  && bad "the runtime service survived decommission" || pass "runtime service stopped"
[[ ! -e "${STATE_ROOT}/identity/node.key" ]] \
  && pass "node private identity purged" || bad "the node private key survived decommission"
[[ ! -e "${STATE_ROOT}/control-plane-key.pem" ]] \
  && pass "pinned control-plane key purged" || bad "the pinned control-plane key survived"
systemctl is-enabled orcasynapse-hermes-heartbeat.timer >/dev/null 2>&1 \
  && bad "heartbeat timer survived decommission" || pass "heartbeat timer removed"
systemctl is-enabled orcasynapse-hermes-desired-state.timer >/dev/null 2>&1 \
  && bad "desired-state timer survived decommission" || pass "desired-state timer removed"

if (( failures > 0 )); then
  printf 'Agentic System installer smoke test FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'Agentic System installer smoke test passed.\n'
