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
signature_body='{"apiKey":"sm_test_registration_key_0123456789","baseUrl":"http://10.0.0.12:6767","observedVersion":"0.0.5"}'
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
    supermemoryVersion:"v1.2.3",
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

supermemory_release_matches "latest" "v9.9.9"
supermemory_release_matches "1.2.3" "v1.2.3"
[[ "$(normalize_supermemory_release "v1.2.3")" == "1.2.3" ]]
[[ "$(normalize_supermemory_release "latest")" == "latest" ]]
if supermemory_release_matches "1.2.4" "v1.2.3"; then
  printf 'mismatched pinned Supermemory releases were accepted\n' >&2
  exit 1
fi
assert_supermemory_release_usable "0.0.5"
assert_supermemory_release_usable "0.0.7-rc.2"
if (assert_supermemory_release_usable "v0.0.6" >/dev/null 2>&1); then
  printf 'known-broken Supermemory v0.0.6 was accepted\n' >&2
  exit 1
fi

progress_sample="$({
  printf '%s\n' '      [                        ] 0% · 717 B / 106 MB'
  printf '%s\n' '      [==========              ] 40% · 43 MB / 106 MB'
} | parse_supermemory_download_progress)"
[[ "${progress_sample}" == "40|43 MB / 106 MB" ]]
model_sample="$({
  printf '%s\n' '  * local embeddings  Xenova/bge-m3 · first-run download'
  printf '%s\n' '  + local embeddings  1 worker ready · native backend · 12s'
} | parse_supermemory_embedding_model)"
[[ "${model_sample}" == "Xenova/bge-m3" ]]
[[ "${SUPERMEMORY_READY_PATH}" == "/v4/openapi" ]]

grep -Fq 'default: ${model_alias_json}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'local key_deadline=' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'native_api_key_file="${SUPERMEMORY_ROOT}/data/api-key"' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'print_safe_supermemory_diagnostics' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
if grep -Fq 'supermemory_base_url}/health' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Agentic System installer still probes the nonexistent Supermemory /health route\n' >&2
  exit 1
fi
grep -Fq 'write_file_from_stdin()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'HERMES_MANAGED_DIR=/opt/data/.orcasynapse-bootstrap-managed' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'allow_lazy_installs: true' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'allow_lazy_installs: false' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'activate_durable_lazy_target' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'Local identity fingerprint:' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'VM1 accepted the signed VM2 trust handshake.' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'The retained VM2 state and dashboard record no longer share the same trust binding.' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'render_activity_progress()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'download_with_progress()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'resolved_image_reference()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'the approved Hermes image has no immutable registry digest' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'releases/download/server-v${release}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'the Supermemory release checksum did not match' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
if grep -Fq 'curl -fsSL https://supermemory.ai/install' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Agentic System installer still executes the mutable upstream Supermemory installer\n' >&2
  exit 1
fi
grep -Fq 'render_activity_progress "Initialize Supermemory embeddings"' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'verify_supermemory_document_pipeline "http://127.0.0.1:6767"' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq -- '--form '\''containerTags=orcasynapse-install-check'\''' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'BGE-M3 only embeds extracted text' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# A node must not report ONLINE on the Hermes port alone. Hermes answers /health
# well before Supermemory has loaded its model, so the heartbeat has to observe
# both planes or the control plane sees a healthy runtime with unusable memory.
grep -Fq 'http://127.0.0.1:6767/v4/openapi' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
if grep -Fq 'Restart=on-failure' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Supermemory unit can stay dead after a clean exit; use Restart=always\n' >&2
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
