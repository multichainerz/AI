#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT

export ORCASYNAPSE_HERMES_STATE_ROOT="${TEST_ROOT}/hermes"
# shellcheck source=install-hermes-node.sh
source "${REPOSITORY_ROOT}/scripts/install-hermes-node.sh"

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

grep -Fq 'default: ${model_alias_json}' "${REPOSITORY_ROOT}/scripts/install-hermes-node.sh"
grep -Fq 'local key_deadline=' "${REPOSITORY_ROOT}/scripts/install-hermes-node.sh"

piped_output="$(
  sed 's/^  main .*$/  printf '\''piped entrypoint invoked\\n'\''/' \
    "${REPOSITORY_ROOT}/scripts/install-hermes-node.sh" \
    | bash -s -- --connect https://orcasynapse.internal
)"
[[ "${piped_output}" == "piped entrypoint invoked" ]]

printf 'Hermes installer recovery checks passed.\n'
