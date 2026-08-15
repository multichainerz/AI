#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

export ORCASYNAPSE_HERMES_STATE_ROOT="${TEST_ROOT}/hermes"
# shellcheck source=install-agentic-node.sh
source "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# Sourcing installs the installer's own `trap cleanup EXIT`, which replaces the
# one above. Take the trap back, and exit with this script's status rather than
# whatever the installer's handler reports -- without this a failed assertion
# below exits 0, which silently turns every check in this file into a no-op.
trap 'recovery_status=$?; rm -rf -- "${TEST_ROOT}"; exit "${recovery_status}"' EXIT

mkdir -p "${STATE_ROOT}/identity"
openssl genpkey -algorithm ED25519 -out "${STATE_ROOT}/identity/node.key"
openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -out "${STATE_ROOT}/identity/node.pub"
[[ "$(public_identity_fingerprint)" == "$(private_identity_fingerprint)" ]]
signature_body='{"capabilities":["gateway-api","signed-heartbeat"],"hermesVersion":"c015663b215c0e14de4295346b0727db602cbb1d","observedAt":"2026-08-03T00:00:00Z","status":"ONLINE"}'
signature_timestamp='2026-08-03T00:00:00Z'
signature_nonce='c634de85-7087-426a-b4f5-f4c2857f55c2'
# The method and path are part of the signed message, so a heartbeat signature
# cannot be replayed against a desired-state endpoint. Both are rebuilt by hand
# below rather than read back from the installer, so a change to the field order
# has to be made twice on purpose.
signature_method='POST'
signature_path='/api/v1/runtime-nodes/9d1c5b0e-1f2a-4f3b-8c7d-6e5a4b3c2d10/heartbeat'
signature_value="$(sign_node_payload "${signature_body}" "${signature_timestamp}" "${signature_nonce}" "${signature_method}" "${signature_path}")"
[[ "${signature_value}" =~ ^[A-Za-z0-9_-]{86}$ ]]
signature_digest="$(printf '%s' "${signature_body}" | sha256sum | awk '{print $1}')"
printf '%s\n%s\n%s\n%s\n%s' \
  "${signature_method}" "${signature_path}" "${signature_timestamp}" "${signature_nonce}" "${signature_digest}" \
  > "${TEST_ROOT}/signature-message"
printf '%s==' "${signature_value}" \
  | tr '_-' '/+' \
  | openssl base64 -d -A \
  > "${TEST_ROOT}/signature-bytes"
# Both the verdict text and the exit code are checked, and the reason is a
# correction rather than caution.
#
# This was changed once on the belief that `openssl pkeyutl -verify` returns 0
# for a signature it had rejected. It does not. Measured on OpenSSL 3.0.13 in
# the VM2 bed, it exits 1 on a corrupted message under all three forms --
# stdout inherited, redirected to /dev/null, and captured through `$( )` with
# `2>&1` -- and prints its verdict in each. The earlier reading came from a
# probe that reported the calling shell's status instead of openssl's, and the
# claim survived into a comment, a commit message and a changelog before anyone
# re-measured it.
#
# So the exit code was load-bearing all along and the text is belt and braces.
# Keep both: whichever is redundant, the pair cannot pass a rejected signature.
openssl_status=0
openssl_verdict="$(openssl pkeyutl -verify -rawin -pubin \
  -inkey "${STATE_ROOT}/identity/node.pub" \
  -in "${TEST_ROOT}/signature-message" \
  -sigfile "${TEST_ROOT}/signature-bytes" 2>&1)" || openssl_status=$?
if (( openssl_status != 0 )) || [[ "${openssl_verdict}" != *"Signature Verified Successfully"* ]]; then
  printf 'the installer signature did not verify with openssl (exit %d): %s\n' \
    "${openssl_status}" "${openssl_verdict}" >&2
  exit 1
fi
SIGNATURE_BODY="${signature_body}" \
SIGNATURE_TIMESTAMP="${signature_timestamp}" \
SIGNATURE_NONCE="${signature_nonce}" \
SIGNATURE_METHOD="${signature_method}" \
SIGNATURE_PATH="${signature_path}" \
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
  // Mirrors `signatureMessage` in drizzle-runtime-node-manager.ts: this check
  // exists because the shell signer and the control-plane verifier are separate
  // implementations that nothing else compares at runtime.
  const message = [
    process.env.SIGNATURE_METHOD,
    process.env.SIGNATURE_PATH,
    process.env.SIGNATURE_TIMESTAMP,
    process.env.SIGNATURE_NONCE,
    digest,
  ].join("\n");
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
    hermesCommit:"c015663b215c0e14de4295346b0727db602cbb1d",
    hostname:"hermes-01.internal",
    apiKey:$apiKey,
    identityFingerprint:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    heartbeatPath:"/runtime-control/nodes/node-1/heartbeat",
    desiredStatePath:"/runtime-control/nodes/node-1/desired-state",
    modelBootstrap:{baseUrl:"https://orcasynapse.internal/internal/v1",modelAlias:"hermes-agent",apiKey:$gatewayKey}
  }' > "${valid_state}"

validate_resume_state "${valid_state}"
# Legacy receipts remain resumable and take the historical routes, but current
# endpoint paths must be validated and consumed rather than ignored.
jq 'del(.heartbeatPath, .desiredStatePath)' "${valid_state}" > "${TEST_ROOT}/legacy.json"
validate_resume_state "${TEST_ROOT}/legacy.json"
[[ "$(resolve_control_plane_path "" "/api/v1/runtime-nodes/node-1/heartbeat" "heartbeat")" == "/api/v1/runtime-nodes/node-1/heartbeat" ]]
[[ "$(resolve_control_plane_path "/runtime-control/nodes/node-1/heartbeat" "/unused" "heartbeat")" == "/runtime-control/nodes/node-1/heartbeat" ]]
jq 'del(.modelBootstrap.apiKey)' "${valid_state}" > "${TEST_ROOT}/invalid.json"
if validate_resume_state "${TEST_ROOT}/invalid.json"; then
  printf 'invalid recovery state was accepted\n' >&2
  exit 1
fi
jq '.heartbeatPath = "//different-authority.invalid/heartbeat"' "${valid_state}" > "${TEST_ROOT}/invalid-path.json"
if validate_resume_state "${TEST_ROOT}/invalid-path.json"; then
  printf 'cross-authority recovery path was accepted\n' >&2
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
grep -Fq 'corpus-sync-v1' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq '/install/hermes-corpus-reconciler.py' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'CORPUS_SERVICE="orcasynapse-hermes-corpus"' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'systemctl enable --now "${CORPUS_SERVICE}.timer"' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'HERMES_PYTHON="${HERMES_INSTALL_DIR}/venv/bin/python"' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'ExecStart=${HERMES_PYTHON} /usr/local/lib/orcasynapse/hermes-corpus-reconciler.py' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'Environment=HERMES_MANAGED_DIR=${HERMES_MANAGED_DIR}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# The corpus coordinator needs CAP_SETUID in its active process sets to use
# Python's native user= transition. Keep only that capability ambient: the
# kernel clears it when the child leaves UID 0.
[[ "$(grep -Fc 'AmbientCapabilities=CAP_SETUID' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh")" -eq 1 ]]
if grep -Eq '^AmbientCapabilities=.*CAP_(DAC_OVERRIDE|SETGID)' \
    "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'corpus coordinator ambient capability scope is broader than CAP_SETUID\n' >&2
  exit 1
fi
grep -Fq 'from tools.memory_tool import load_on_disk_store' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'from tools.skill_manager_tool import apply_skill_pending' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# The UI block is generated from scripts/lib/installer-ui.sh; the marker must
# survive refactors or the sync tool can no longer maintain this script.
grep -Fq '>>> ORCASYNAPSE-INSTALLER-UI v1' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# The pin is read back from the checkout rather than trusted, because the
# requested SHA is not proof of the installed one.
grep -Fq 'installed_hermes_commit()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'instead of the approved' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# The wizard skip is load-bearing: without it a `curl | bash` install hangs.
grep -Fq -- '--skip-setup' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# So is the force: upstream ignores --commit when the checkout is already newer,
# so without this the control plane's approved revision loses to whatever the
# host happens to have, and no downgrade to an earlier approved commit is
# possible.
grep -Fq -- '--force-commit' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
# Hermes is code, not a secret: installed under a relaxed umask or systemd
# cannot execute it as the unprivileged service account.
grep -Fq 'umask 022' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'Environment=HOME=${HERMES_HOME_DIR}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'WorkingDirectory=${HERMES_HOME_DIR}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'cwd: ${HERMES_HOME_DIR}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'memory_enabled: true' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq 'user_profile_enabled: true' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
if grep -Eq '^Environment=(MESSAGING_CWD|TERMINAL_CWD)=' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'deprecated Hermes cwd environment configuration reappeared\n' >&2
  exit 1
fi
grep -Fq 'repair_runtime_installation()' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq '${CONTROL_PLANE_URL}${HEARTBEAT_PATH}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
grep -Fq '${CONTROL_PLANE_URL}${DESIRED_STATE_PATH}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
if grep -Eq 'OPENAI_(BASE_URL|API_KEY)=\$\{model_(base_url|api_key)_json\}' \
  "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Hermes .env values must be raw, not JSON-quoted\n' >&2
  exit 1
fi
if grep -Fq 'Authorization: Bearer ${KEY}' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"; then
  printf 'Hermes gateway credential is exposed through desired-state process arguments\n' >&2
  exit 1
fi
grep -Fq -- '--header "@${RUNTIME_AUTH_HEADER}"' "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh"
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

# Runtime state belongs to the service account by name, not to the numeric
# container identity the Docker runtime used. Skipped when the account is absent,
# which is the normal state on a host that has never enrolled: the assertion is
# about ownership, not about this test being allowed to create system users.
if [[ "${EUID}" -eq 0 ]] && id -u "${HERMES_USER}" >/dev/null 2>&1; then
  ownership_root="${TEST_ROOT}/service-account-ownership"
  install_hermes_directory 0750 "${ownership_root}"
  printf 'protected=true\n' | install_hermes_file_from_stdin 0600 "${ownership_root}/runtime.env"
  [[ "$(stat -c '%U:%G:%a' "${ownership_root}")" == "${HERMES_USER}:${HERMES_USER}:750" ]]
  [[ "$(stat -c '%U:%G:%a' "${ownership_root}/runtime.env")" == "${HERMES_USER}:${HERMES_USER}:600" ]]
fi

if [[ "${EUID}" -eq 0 ]]; then
  # The gateway only consumes the managed platform overlay when its primary
  # user config exists. The anchor is private, service-owned, and must never
  # replace an existing user configuration during repair.
  (
    STATE_ROOT="${TEST_ROOT}/gateway-config-anchor"
    HERMES_USER=root
    mkdir -p "${STATE_ROOT}/data"
    ensure_hermes_gateway_config_anchor
    [[ "$(stat -c '%U:%G:%a' "${STATE_ROOT}/data/config.yaml")" == "root:root:600" ]]
    grep -Fqx '{}' "${STATE_ROOT}/data/config.yaml"
    printf 'existing: true\n' > "${STATE_ROOT}/data/config.yaml"
    ensure_hermes_gateway_config_anchor
    grep -Fqx 'existing: true' "${STATE_ROOT}/data/config.yaml"
  )

  # Fresh installs must use the same literal provider identity Hermes persists
  # after turn 1. The credential remains an environment reference, never YAML.
  (
    HERMES_MANAGED_DIR="${TEST_ROOT}/fresh-managed-policy"
    write_hermes_managed_policy '"fresh-model"' '"http://192.0.2.5:4000/internal/v1"'
    grep -Fqx '  provider: custom' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '  custom:' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '    key_env: OPENAI_API_KEY' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '          provider: custom' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Fq 'custom:orcasynapse' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Eq '^  api_key\s*:' "${HERMES_MANAGED_DIR}/config.yaml"
  )

  # Repair must preserve the enrolled policy, reconcile terminal.cwd, and add
  # the native memory block once for nodes installed before the transition.
  # Exercise the atomic renderer as root because the real managed file is
  # root-owned; a Python/render failure must occur before the original moves.
  (
    HERMES_MANAGED_DIR="${TEST_ROOT}/managed-policy"
    HERMES_HOME_DIR="${TEST_ROOT}/runtime-home"
    mkdir -p "${HERMES_MANAGED_DIR}"
    printf 'model:\n  provider: custom\n  default: smoke-model\n  base_url: "http://192.0.2.10:4000/internal/v1"\n  api_key: ${OPENAI_API_KEY}\nmemory:\n  provider: stale-external\n  memory_enabled: false\nsecurity:\n  redact_secrets: true\n' \
      > "${HERMES_MANAGED_DIR}/config.yaml"
    reconcile_managed_runtime_policy
    grep -Fqx '  provider: custom' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '  default: smoke-model' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Eq '^  api_key\s*:' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '    key_env: OPENAI_API_KEY' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '    api: "http://192.0.2.10:4000/internal/v1"' "${HERMES_MANAGED_DIR}/config.yaml"
    [[ "$(grep -Fc '  custom:' "${HERMES_MANAGED_DIR}/config.yaml")" == "1" ]]
    grep -Fqx '        hermes-agent:' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '          model: smoke-model' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '          provider: custom' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '  redact_secrets: true' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx "  cwd: ${HERMES_HOME_DIR}" "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '  memory_enabled: true' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '  user_profile_enabled: true' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Fq 'stale-external' "${HERMES_MANAGED_DIR}/config.yaml"
    reconcile_managed_runtime_policy
    [[ "$(grep -Fc '  cwd:' "${HERMES_MANAGED_DIR}/config.yaml")" == "1" ]]
    [[ "$(grep -Fc 'memory:' "${HERMES_MANAGED_DIR}/config.yaml")" == "1" ]]
    [[ "$(grep -Fc '  custom:' "${HERMES_MANAGED_DIR}/config.yaml")" == "1" ]]
    [[ "$(grep -Fc '        hermes-agent:' "${HERMES_MANAGED_DIR}/config.yaml")" == "1" ]]

    HERMES_MANAGED_DIR="${TEST_ROOT}/managed-policy-drift"
    mkdir -p "${HERMES_MANAGED_DIR}"
    printf 'model:\n  provider: custom:orcasynapse\n  default: repaired-model\n  base_url: "http://192.0.2.20:4000/internal/v1"\nproviders:\n  orcasynapse:\n    name: Stale\n    api: "https://openrouter.ai/api/v1"\n    key_env: OPENROUTER_API_KEY\n    default_model: stale-model\nplatforms:\n  api_server:\n    enabled: false\n    extra:\n      model_routes:\n        other-agent:\n          model: preserved-model\n          provider: preserved-provider\n        hermes-agent:\n          model: stale-model\n          provider: openrouter\n' \
      > "${HERMES_MANAGED_DIR}/config.yaml"
    reconcile_managed_runtime_policy
    grep -Fqx '    enabled: true' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '    key_env: OPENAI_API_KEY' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '    api: "http://192.0.2.20:4000/internal/v1"' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '          model: repaired-model' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '          provider: custom' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '        other-agent:' "${HERMES_MANAGED_DIR}/config.yaml"
    grep -Fqx '          model: preserved-model' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Fq 'OPENROUTER_API_KEY' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Fq 'custom:orcasynapse' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Fqx '  orcasynapse:' "${HERMES_MANAGED_DIR}/config.yaml"
    ! grep -Fq 'stale-model' "${HERMES_MANAGED_DIR}/config.yaml"
    reconcile_managed_runtime_policy
    [[ "$(grep -Fc '  custom:' "${HERMES_MANAGED_DIR}/config.yaml")" == "1" ]]
    [[ "$(grep -Fc '        hermes-agent:' "${HERMES_MANAGED_DIR}/config.yaml")" == "1" ]]
  )
fi

piped_output="$(
  sed 's/^  main .*$/  printf '\''piped entrypoint invoked\\n'\''/' \
    "${REPOSITORY_ROOT}/scripts/install-agentic-node.sh" \
    | bash -s -- --connect https://orcasynapse.internal
)"
[[ "${piped_output}" == "piped entrypoint invoked" ]]

printf 'Agentic System installer recovery checks passed.\n'
