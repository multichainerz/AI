#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

export ORCASYNAPSE_HERMES_STATE_ROOT="${TEST_ROOT}/hermes"
# shellcheck source=install-agentic-node.sh
source "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"

mkdir -p "${STATE_ROOT}/identity"
openssl genpkey -algorithm ED25519 -out "${STATE_ROOT}/identity/node.key"
openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -out "${STATE_ROOT}/identity/node.pub"
[[ "$(public_identity_fingerprint)" == "$(private_identity_fingerprint)" ]]
signature_body='{"capabilities":["gateway-api","signed-heartbeat"],"hermesVersion":"nousresearch/hermes-agent:latest","observedAt":"2026-08-03T00:00:00Z","status":"ONLINE"}'
signature_timestamp='2026-08-03T00:00:00Z'
signature_nonce='c634de85-7087-426a-b4f5-f4c2857f55c2'
signature_value="$(sign_node_payload "${signature_body}" "${signature_timestamp}" "${signature_nonce}")"
[[ "${signature_value}" =~ ^[A-Za-z0-9_-]{86}$ ]]
signature_digest="$(printf '%s' "${signature_body}" | sha256sum | awk '{print $1}')"
printf '%s\n%s\n%s' "${signature_timestamp}" "${signature_nonce}" "${signature_digest}" \
  > "${TEST_ROOT}/signature-message"
printf '%s==' "${signature_value}" \
  | tr '_-' '/+' \
  | openssl base64 -d -A \
  > "${TEST_ROOT}/signature-bytes"
openssl pkeyutl -verify -rawin -pubin \
  -inkey "${STATE_ROOT}/identity/node.pub" \
  -in "${TEST_ROOT}/signature-message" \
  -sigfile "${TEST_ROOT}/signature-bytes" >/dev/null
SIGNATURE_BODY="${signature_body}" \
SIGNATURE_TIMESTAMP="${signature_timestamp}" \
SIGNATURE_NONCE="${signature_nonce}" \
SIGNATURE_VALUE="${signature_value}" \
SIGNATURE_PUBLIC_KEY="${STATE_ROOT}/identity/node.pub" \
node --input-type=module -e '
  import { createHash, verify } from "node:crypto";
  import { readFileSync } from "node:fs";
  const body = JSON.parse(process.env.SIGNATURE_BODY);
  const canonicalize = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  };
  const digest = createHash("sha256").update(canonicalize(body)).digest("hex");
  const message = `${process.env.SIGNATURE_TIMESTAMP}\n${process.env.SIGNATURE_NONCE}\n${digest}`;
  const valid = verify(
    null,
    Buffer.from(message, "utf8"),
    readFileSync(process.env.SIGNATURE_PUBLIC_KEY, "utf8"),
    Buffer.from(process.env.SIGNATURE_VALUE, "base64url"),
  );
  if (!valid) process.exit(1);
'

valid_state="${TEST_ROOT}/valid.json"
jq -n \
  --arg apiKey "$(printf 'a%.0s' {1..64})" \
  --arg gatewayKey "$(printf 'g%.0s' {1..64})" \
  '{
    format:"orcasynapse-hermes-resume/v1",
    nodeId:"9de260d7-bc51-4558-9d20-06916d393072",
    controlPlaneUrl:"https://orcasynapse.internal",
    hermesBaseUrl:"http://10.0.0.12:8642",
    hermesImage:"nousresearch/hermes-agent:latest",
    hostname:"hermes-01.internal",
    apiKey:$apiKey,
    identityFingerprint:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    modelBootstrap:{baseUrl:"https://orcasynapse.internal/internal/v1",modelAlias:"hermes-agent",apiKey:$gatewayKey}
  }' > "${valid_state}"

validate_resume_state "${valid_state}"
jq 'del(.modelBootstrap.apiKey)' "${valid_state}" > "${TEST_ROOT}/invalid.json"
if validate_resume_state "${TEST_ROOT}/invalid.json"; then
  printf 'invalid recovery state was accepted\n' >&2
  exit 1
fi

grep -Fq 'default: ${model_alias_json}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'write_file_from_stdin()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'allow_lazy_installs: false' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'VM1 rejected the enrolled VM2 identity ${node_fingerprint}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'VM1 accepted the signed VM2 trust handshake.' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'The retained VM2 state and dashboard record no longer share the same trust binding.' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'render_activity_progress()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'download_with_progress()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# The UI block is generated from scripts/lib/installer-ui.sh; the marker must
# survive refactors or the sync tool can no longer maintain this script.
grep -Fq '>>> ORCASYNAPSE-INSTALLER-UI v1' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'resolved_image_reference()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'the approved Hermes image has no immutable registry digest' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
if grep -Eq 'OPENAI_(BASE_URL|API_KEY)=\$\{model_(base_url|api_key)_json\}' \
  "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Hermes .env values must be raw, not JSON-quoted\n' >&2
  exit 1
fi
if grep -Fq '/dev/stdin' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Agentic System installer still depends on non-portable /dev/stdin file copies\n' >&2
  exit 1
fi
if grep -Eq 'install .*-[og] (10000|"?\$\{HERMES_(UID|GID)\})' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Agentic System installer passes a numeric identity through install -o/-g\n' >&2
  exit 1
fi

# VM2 runs exactly one plane. Agent memory and knowledge are served by the
# control plane, so no second service may reappear in this installer.
if grep -qi 'supermemory' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'the Agentic System installer reintroduced an external memory service\n' >&2
  exit 1
fi
if grep -Fq '6767' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'the Agentic System installer still references the removed memory port\n' >&2
  exit 1
fi

atomic_write_root="${TEST_ROOT}/atomic-write"
mkdir -p "${atomic_write_root}"
printf 'protected=true\n' | write_file_from_stdin 0640 "$(id -u)" "$(id -g)" "${atomic_write_root}/runtime.env"
[[ "$(<"${atomic_write_root}/runtime.env")" == "protected=true" ]]
[[ "$(stat -c '%a' "${atomic_write_root}/runtime.env")" == "640" ]]

if [[ "${EUID}" -eq 0 ]]; then
  ownership_root="${TEST_ROOT}/numeric-ownership"
  install_hermes_directory 0750 "${ownership_root}"
  printf 'protected=true\n' | install_hermes_file_from_stdin 0600 "${ownership_root}/runtime.env"
  [[ "$(stat -c '%u:%g:%a' "${ownership_root}")" == "${HERMES_UID}:${HERMES_GID}:750" ]]
  [[ "$(stat -c '%u:%g:%a' "${ownership_root}/runtime.env")" == "${HERMES_UID}:${HERMES_GID}:600" ]]
fi

piped_output="$(
  sed 's/^  main .*$/  printf '\''piped entrypoint invoked\\n'\''/' \
    "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh" \
    | bash -s -- --connect https://orcasynapse.internal
)"
[[ "${piped_output}" == "piped entrypoint invoked" ]]

printf 'Agentic System installer recovery checks passed.\n'
