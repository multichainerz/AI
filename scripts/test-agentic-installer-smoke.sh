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
SMOKE_OWNS_RUNTIME=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

cleanup() {
  systemctl disable --now orcasynapse-hermes-heartbeat.timer >/dev/null 2>&1 || true
  systemctl disable --now orcasynapse-hermes-desired-state.timer >/dev/null 2>&1 || true
  systemctl disable --now orcasynapse-hermes-corpus.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/orcasynapse-hermes-*.service /etc/systemd/system/orcasynapse-hermes-*.timer
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl disable --now "${RUNTIME_SERVICE}" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${RUNTIME_SERVICE}.service"
  systemctl daemon-reload >/dev/null 2>&1 || true
  [[ -n "${STUB_PID:-}" ]] && kill "${STUB_PID}" 2>/dev/null || true
  rm -rf -- "${WORK}" "${STATE_ROOT}" /usr/local/lib/orcasynapse
  if [[ "${SMOKE_OWNS_RUNTIME}" == "1" ]]; then
    rm -rf -- /usr/local/lib/hermes-agent
    rm -f -- /usr/local/bin/hermes /usr/local/bin/hermes-agent /usr/local/bin/hermes-acp
    id -u orcasynapse-hermes >/dev/null 2>&1 && userdel orcasynapse-hermes >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || { echo "run as root: sudo bash scripts/test-agentic-installer-smoke.sh" >&2; exit 2; }
[[ -d /run/systemd/system ]] || { echo "this test needs a systemd host" >&2; exit 2; }
command -v systemctl >/dev/null 2>&1 || { echo "this test needs systemd" >&2; exit 2; }
# The smoke owns and destroys these global names. Refuse to run over a real or
# manually installed runtime, then clean partial artifacts on every exit.
[[ ! -e /usr/local/lib/hermes-agent ]] || { echo "refusing to replace an existing Hermes checkout" >&2; exit 2; }
[[ ! -e /usr/local/bin/hermes && ! -e /usr/local/bin/hermes-agent && ! -e /usr/local/bin/hermes-acp ]] \
  || { echo "refusing to replace existing Hermes launchers" >&2; exit 2; }
systemctl list-unit-files "${RUNTIME_SERVICE}.service" --no-legend 2>/dev/null | grep -q . \
  && { echo "refusing to replace an existing ${RUNTIME_SERVICE} unit" >&2; exit 2; }
id -u orcasynapse-hermes >/dev/null 2>&1 \
  && { echo "refusing to replace an existing orcasynapse-hermes account" >&2; exit 2; }
SMOKE_OWNS_RUNTIME=1

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
printf '{"format":"orcasynapse-hermes-corpus-desired-state/v1","nodeId":"%s","generatedAt":"2026-08-07T00:00:00Z","mutation":null}' \
  "${NODE_ID}" > "${WORK}/corpus-desired.json"
openssl pkeyutl -sign -rawin -inkey "${WORK}/cp.key" -in "${WORK}/corpus-desired.json" -out "${WORK}/corpus-desired.sig"

cat > "${WORK}/controlplane.py" <<'CONTROLPLANE'
import hashlib, json, os, subprocess, sys, http.server
NODE = os.environ["NODE_ID"]
HEARTBEAT_PATH = f"/runtime-control/nodes/{NODE}/heartbeat"
DESIRED_STATE_PATH = f"/runtime-control/nodes/{NODE}/desired-state"
CORPUS_SNAPSHOT_PATH = f"/api/v1/runtime-nodes/{NODE}/corpus/snapshot"
CORPUS_DESIRED_PATH = f"/api/v1/runtime-nodes/{NODE}/corpus/desired-state"
CORPUS_RESULT_PATH = f"/api/v1/runtime-nodes/{NODE}/corpus/mutation-result"


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
    def _sse(self, events):
        body = b"".join(f"data: {json.dumps(event)}\n\n".encode() for event in events)
        body += b"data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path.endswith("/enroll"):
            enrollment = json.loads(raw or b"{}")
            if "corpus-sync-v1" in enrollment.get("capabilities", []):
                return self._json({"error": "corpus advertised before installation"}, 400)
            return self._json({
                "node": {"id": NODE, "identityFingerprint": fingerprint(raw)},
                # Deliberately not the historical hard-coded routes: the smoke
                # test proves VM2 consumes the enrollment contract.
                "heartbeatPath": HEARTBEAT_PATH,
                "desiredStatePath": DESIRED_STATE_PATH,
                "controlPlanePublicKeyPem": os.environ["CP_PUB"],
                "modelBootstrap": {
                    "provider": "custom",
                    "baseUrl": "http://127.0.0.1:8099",
                    "modelAlias": "smoke-model",
                    "apiKey": "smoke-inference-key",
                },
            })
        if self.path == HEARTBEAT_PATH:
            heartbeat = json.loads(raw or b"{}")
            if "corpus-sync-v1" not in heartbeat.get("capabilities", []):
                return self._json({"error": "installed corpus capability missing"}, 400)
            return self._json({"accepted": True})
        if self.path == CORPUS_SNAPSHOT_PATH:
            return self._json({"accepted": True, "snapshotId": "20fbc05f-6e6c-4b43-9dde-ab48d6baac07", "serverTime": "2026-08-07T00:00:00Z"})
        if self.path == CORPUS_RESULT_PATH:
            return self._json({"accepted": True, "serverTime": "2026-08-07T00:00:00Z"})
        if self.path.endswith("/chat/completions"):
            if self.headers.get("authorization") != "Bearer smoke-inference-key":
                return self._json({"error": "invalid inference credential"}, 401)
            request = json.loads(raw or b"{}")
            if request.get("stream"):
                return self._sse([{
                    "id": "chatcmpl-smoke",
                    "object": "chat.completion.chunk",
                    "created": 1786057200,
                    "model": "smoke-model",
                    "choices": [{
                        "index": 0,
                        "delta": {"role": "assistant", "content": "SMOKE_RUN_OK"},
                        "finish_reason": "stop",
                    }],
                    "usage": {"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7},
                }])
            return self._json({
                "id": "chatcmpl-smoke",
                "object": "chat.completion",
                "created": 1786057200,
                "model": "smoke-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "SMOKE_RUN_OK"},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7},
            })
        return self._json({"error": "unexpected POST path", "path": self.path}, 404)
    def do_GET(self):
        if self.path == "/install/hermes-corpus-reconciler.py":
            body = open(os.environ["CORPUS_CLIENT"], "rb").read()
            self.send_response(200)
            self.send_header("content-type", "text/x-python")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == DESIRED_STATE_PATH:
            return self._json({
                "documentBase64": os.environ["DOC_B64"],
                "signature": os.environ["SIG_B64"],
                "publicKeyFingerprint": "smoke",
            })
        if self.path == CORPUS_DESIRED_PATH:
            return self._json({
                "documentBase64": os.environ["CORPUS_DOC_B64"],
                "signature": os.environ["CORPUS_SIG_B64"],
                "publicKeyFingerprint": os.environ["CP_FINGERPRINT"],
            })
        if self.path == "/health":
            return self._json({"status": "ok"})
        return self._json({"error": "unexpected GET path", "path": self.path}, 404)
    def log_message(self, *_): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
CONTROLPLANE

CP_PUB="$(cat "${WORK}/cp.pub")" \
DOC_B64="$(base64 -w0 "${WORK}/desired.json")" \
SIG_B64="$(base64 -w0 "${WORK}/desired.sig")" \
CORPUS_DOC_B64="$(base64 -w0 "${WORK}/corpus-desired.json")" \
CORPUS_SIG_B64="$(base64 -w0 "${WORK}/corpus-desired.sig")" \
CP_FINGERPRINT="$(openssl pkey -pubin -in "${WORK}/cp.pub" -outform DER 2>/dev/null | sha256sum | awk '{print $1}')" \
CORPUS_CLIENT="${ROOT}/scripts/hermes-corpus-reconciler.py" \
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
grep -Fq 'ExecStart=/usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/orcasynapse/hermes-corpus-reconciler.py' \
  /etc/systemd/system/orcasynapse-hermes-corpus.service \
  && pass "corpus companion uses the pinned Hermes Python environment" \
  || bad "corpus companion is detached from the Hermes Python environment"
[[ "$(git -C /usr/local/lib/hermes-agent rev-parse HEAD 2>/dev/null)" == "${HERMES_COMMIT}" ]] \
  && pass "installed commit matches the pin" || bad "installed commit does not match the pin"
curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null \
  && pass "runtime answers /health" || bad "runtime does not answer /health"
grep -q 'smoke-model' /etc/hermes/config.yaml 2>/dev/null \
  && pass "managed policy pins the enrolled model route" || bad "managed policy is missing the model route"
grep -Fqx '  provider: custom' /etc/hermes/config.yaml \
  && pass "managed policy selects the session-stable custom provider" \
  || bad "managed policy does not select the session-stable custom provider"
grep -Fqx '  custom:' /etc/hermes/config.yaml \
  && pass "managed provider survives Hermes session normalization" \
  || bad "managed provider is not addressable after session normalization"
grep -Fqx '    key_env: OPENAI_API_KEY' /etc/hermes/config.yaml \
  && pass "managed policy authorizes the protected inference credential by env name" \
  || bad "managed policy does not bind the protected inference credential"
grep -Fqx '        hermes-agent:' /etc/hermes/config.yaml \
  && grep -Fqx '          model: "smoke-model"' /etc/hermes/config.yaml \
  && grep -Fqx '          provider: custom' /etc/hermes/config.yaml \
  && pass "native API sessions route the product alias through the enrolled model" \
  || bad "native API sessions can bypass the enrolled model route"
if grep -Eq '^  api_key\s*:' /etc/hermes/config.yaml; then
  bad "managed policy exposes or shadows the protected inference credential"
else
  pass "managed policy delegates inference credentials to the protected environment"
fi
[[ "$(sed -n 's/^OPENAI_API_KEY=//p' "${STATE_ROOT}/data/.env")" == "smoke-inference-key" ]] \
  && pass "protected environment holds the enrolled inference credential" \
  || bad "protected environment is missing the enrolled inference credential"
grep -q 'allow_lazy_installs: false' /etc/hermes/config.yaml 2>/dev/null \
  && pass "managed policy keeps the hardened baseline" || bad "managed policy lost its baseline"
grep -Fqx '  memory_enabled: true' /etc/hermes/config.yaml \
  && pass "Hermes native memory is enabled" || bad "Hermes native memory is not enabled"
grep -Fqx '  user_profile_enabled: true' /etc/hermes/config.yaml \
  && pass "Hermes native user profile is enabled" || bad "Hermes native user profile is not enabled"
if grep -Eq '^  provider:' /etc/hermes/config.yaml; then
  bad "managed policy enables an external memory provider"
else
  pass "managed policy keeps memory built-in only"
fi
grep -Fqx '    - memory' /etc/hermes/config.yaml \
  && pass "native memory is admitted by the platform allowlist" || bad "native memory is absent from the platform allowlist"
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

expected_home="${STATE_ROOT}/home"
[[ "$(getent passwd orcasynapse-hermes | cut -d: -f6)" == "${expected_home}" ]] \
  && pass "service account home is inside the managed state root" || bad "service account home was not reconciled"
[[ "$(stat -c '%U:%G:%a' "${expected_home}" 2>/dev/null)" == "orcasynapse-hermes:orcasynapse-hermes:750" ]] \
  && pass "runtime workspace is writable only by the service account" || bad "runtime workspace ownership or mode is wrong"
grep -Fqx "WorkingDirectory=${expected_home}" "${runtime_unit}" \
  && pass "runtime starts in its managed workspace" || bad "runtime has no managed working directory"
grep -Fqx "Environment=HOME=${expected_home}" "${runtime_unit}" \
  && pass "runtime has an explicit OS home" || bad "runtime HOME is not explicit"
grep -Fqx "  cwd: ${expected_home}" /etc/hermes/config.yaml \
  && pass "Hermes terminal cwd is pinned in managed policy" || bad "Hermes terminal cwd is not pinned"
[[ "$(<"${STATE_ROOT}/heartbeat-path")" == "/runtime-control/nodes/${NODE_ID}/heartbeat" ]] \
  && pass "enrolled heartbeat path was persisted" || bad "heartbeat path fell back to installer routing"
[[ "$(<"${STATE_ROOT}/desired-state-path")" == "/runtime-control/nodes/${NODE_ID}/desired-state" ]] \
  && pass "enrolled desired-state path was persisted" || bad "desired-state path fell back to installer routing"

systemctl is-enabled orcasynapse-hermes-heartbeat.timer >/dev/null 2>&1 \
  && pass "heartbeat timer enabled" || bad "heartbeat timer not enabled"
systemctl is-enabled orcasynapse-hermes-desired-state.timer >/dev/null 2>&1 \
  && pass "desired-state timer enabled" || bad "desired-state timer not enabled"
systemctl is-enabled orcasynapse-hermes-corpus.timer >/dev/null 2>&1 \
  && pass "corpus timer enabled" || bad "corpus timer not enabled"
[[ -x /usr/local/lib/orcasynapse/hermes-corpus-reconciler.py ]] \
  && pass "corpus reconciler installed" || bad "corpus reconciler missing"

# The v1.4.0 preseed: the node must already hold the admitted allowlist
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
if ! grep -q 'disabled_toolsets' /etc/hermes/config.yaml 2>/dev/null; then
  # The block is derived from the runtime's own /v1/toolsets catalogue, and an
  # empty catalogue silently yields no block at all. Report what the fetch
  # actually returns instead of leaving the cause to inference — this assertion
  # regressed once and was misdiagnosed twice from the log alone.
  diag_key="$(sed -n 's/^API_SERVER_KEY=//p' "${STATE_ROOT}/data/.env" 2>/dev/null || true)"
  diag_status="$(curl -s -o /tmp/diag-toolsets.json -w '%{http_code}' -m 10 \
    -H "Authorization: Bearer ${diag_key}" http://127.0.0.1:8642/v1/toolsets || echo curl-failed)"
  printf '  --- diagnostic: no disabled_toolsets block ---\n'
  printf '  api key resolved: %s chars\n' "${#diag_key}"
  printf '  GET /v1/toolsets -> %s\n' "${diag_status}"
  printf '  body: %s\n' "$(head -c 300 /tmp/diag-toolsets.json 2>/dev/null)"
  printf '  managed config now reads:\n'
  sed -n '/platform_toolsets/,$p' /etc/hermes/config.yaml 2>/dev/null | head -8 | sed 's/^/    /'
fi
grep -q 'disabled_toolsets' /etc/hermes/config.yaml 2>/dev/null \
  && pass "unadmitted toolsets explicitly disabled" || bad "unadmitted toolsets were not disabled"
[[ -s "${STATE_ROOT}/control-plane-key.pem" ]] \
  && pass "control-plane signing key pinned" || bad "control-plane key was not pinned"
[[ ! -e "${STATE_ROOT}/enrollment-state.json" ]] \
  && pass "resume state cleared after success" || bad "resume state survived a successful install"
[[ -s "${STATE_ROOT}/runtime-owned" ]]   && pass "installer recorded that it owns the runtime" || bad "runtime-owned marker was not written"

printf '\n=== repairing an older completed runtime in place ===\n'
# Reproduce the pre-fix account state, after enrollment has cleared its recovery
# receipt. --repair must not require a new claim or touch identity/model secrets.
systemctl stop "${RUNTIME_SERVICE}"
usermod --home /home/orcasynapse-hermes orcasynapse-hermes
set +e
ORCASYNAPSE_HERMES_STATE_ROOT="${STATE_ROOT}" \
  bash "${ROOT}/scripts/install-agentic-node.sh" --repair
repair_status=$?
set -e
[[ "${repair_status}" -eq 0 ]] \
  && pass "completed runtime repaired without re-enrollment" || bad "runtime repair exited ${repair_status}"
[[ "$(getent passwd orcasynapse-hermes | cut -d: -f6)" == "${expected_home}" ]] \
  && pass "repair reconciled the legacy passwd home" || bad "repair left the legacy passwd home in place"

printf '\n=== submitting consecutive Hermes-native session turns ===\n'
session_id="smoke-$(date +%s)"
session_response="$(curl --fail --silent --show-error --max-time 10 \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${gateway_key}" \
  --data-binary "{\"id\":\"${session_id}\",\"model\":\"hermes-agent\",\"source\":\"api_server\"}" \
  http://127.0.0.1:8642/api/sessions 2>/dev/null || true)"
first_stream_response=""
second_stream_response=""
if [[ -n "${session_response}" ]]; then
  first_stream_response="$(curl --fail --silent --show-error --max-time 90 --no-buffer \
    -H 'Accept: text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${gateway_key}" \
    --data-binary '{"message":"Return the smoke marker and do not call tools.","instructions":"Reply concisely.","model":"hermes-agent"}' \
    "http://127.0.0.1:8642/api/sessions/${session_id}/chat/stream" 2>/dev/null || true)"
  second_stream_response="$(curl --fail --silent --show-error --max-time 90 --no-buffer \
    -H 'Accept: text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${gateway_key}" \
    --data-binary '{"message":"Return the smoke marker again and do not call tools.","instructions":"Reply concisely.","model":"hermes-agent"}' \
    "http://127.0.0.1:8642/api/sessions/${session_id}/chat/stream" 2>/dev/null || true)"
fi
if grep -q '^event: run.completed' <<<"${first_stream_response}" \
  && grep -q 'SMOKE_RUN_OK' <<<"${first_stream_response}"; then
  pass "first Hermes-native session turn reached governed inference"
else
  bad "first Hermes-native session turn did not reach governed inference (create=${session_response:-empty})"
fi
if grep -q '^event: run.completed' <<<"${second_stream_response}" \
  && grep -q 'SMOKE_RUN_OK' <<<"${second_stream_response}"; then
  pass "restored Hermes session retained its inference credential on turn 2"
else
  bad "restored Hermes session lost governed inference on turn 2"
fi

printf '\n=== resuming from a protected enrollment receipt ===\n'
# The recovery journal's whole purpose is that an install interrupted after
# enrolment can be re-run. That path had never been executed: both smoke runs
# installed fresh, and the recovery test only exercised validate_resume_state.
# It was broken -- `control_plane_key` was assigned only in the fresh-enrolment
# branch and read unconditionally, so `set -u` aborted every resume with a raw
# bash error, leaving a node installed, enrolled, and permanently offline.
#
# Reconstructed from what the node kept, which is what a real interrupted host
# would still hold. Cheap to run: resume reuses the installed runtime.
jq -n \
  --arg nodeId "${NODE_ID}" \
  --arg cp "http://127.0.0.1:${CONTROL_PLANE_PORT}" \
  --arg commit "${HERMES_COMMIT}" \
  --arg fingerprint "$(openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -hex | awk '{print $NF}')" \
  --arg key "$(cat "${STATE_ROOT}/control-plane-key.pem")" \
  --arg apiKey "$(sed -n 's/^API_SERVER_KEY=//p' "${STATE_ROOT}/data/.env")" \
  '{format:"orcasynapse-hermes-resume/v1",nodeId:$nodeId,controlPlaneUrl:$cp,
    hermesBaseUrl:"http://127.0.0.1:8642",hermesCommit:$commit,hostname:"smoke.internal",
    apiKey:$apiKey,identityFingerprint:$fingerprint,controlPlanePublicKeyPem:$key,
    heartbeatPath:("/runtime-control/nodes/" + $nodeId + "/heartbeat"),
    desiredStatePath:("/runtime-control/nodes/" + $nodeId + "/desired-state"),
    modelBootstrap:{baseUrl:($cp + "/internal/v1"),modelAlias:"smoke-model",apiKey:$apiKey}}' \
  > "${STATE_ROOT}/enrollment-state.json"
chmod 0600 "${STATE_ROOT}/enrollment-state.json"
rm -f -- "${STATE_ROOT}/control-plane-key.pem"

set +e
ORCASYNAPSE_HERMES_STATE_ROOT="${STATE_ROOT}" \
  bash "${ROOT}/scripts/install-agentic-node.sh" --connect "http://127.0.0.1:${CONTROL_PLANE_PORT}" </dev/null
resume_status=$?
set -e
[[ "${resume_status}" -eq 0 ]] \
  && pass "installer resumed from the recovery journal" || bad "resume exited ${resume_status}"
# The receipt carried the signing key; a resume that does not restore it leaves
# the node unable to verify any desired-state document, forever.
[[ -s "${STATE_ROOT}/control-plane-key.pem" ]] \
  && pass "resume restored the pinned control-plane key" || bad "resume did not restore the control-plane key"
systemctl is-active "${RUNTIME_SERVICE}" >/dev/null 2>&1 \
  && pass "runtime still healthy after resume" || bad "runtime is not active after resume"
[[ ! -e "${STATE_ROOT}/enrollment-state.json" ]] \
  && pass "resume cleared the journal on success" || bad "resume left the journal behind"

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
[[ ! -e /usr/local/lib/hermes-agent ]]   && pass "hermes program removed" || bad "hermes program survived removal"
[[ ! -e /usr/local/bin/hermes ]]   && pass "hermes launcher removed" || bad "hermes launcher survived removal"

if (( failures > 0 )); then
  printf 'Agentic System installer smoke test FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'Agentic System installer smoke test passed.\n'
