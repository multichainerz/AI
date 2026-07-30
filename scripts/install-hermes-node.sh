#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

INSTALLER_VERSION="ai-v1.7.0"
STATE_ROOT="${AIHUB_HERMES_STATE_ROOT:-/var/lib/aihub-hermes}"
CONTAINER_NAME="aihub-hermes"
HEARTBEAT_SERVICE="aihub-hermes-heartbeat"

fail() {
  printf 'Hermes node installer error: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "run the installer as root (for example: sudo ./install-hermes-node.sh enrollment.json)"
}

install_host_dependencies() {
  if command -v docker >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1 \
    && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    return
  fi
  [[ -r /etc/os-release ]] || fail "automatic dependency installation supports Debian and Ubuntu"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) fail "automatic dependency installation supports Debian and Ubuntu; install Docker, OpenSSL, curl, and jq first" ;;
  esac
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl jq openssl docker.io
  systemctl enable --now docker
}

validate_bundle() {
  local bundle="$1"
  [[ -r "${bundle}" ]] || fail "the enrollment bundle is not readable"
  [[ "$(jq -r '.format // empty' "${bundle}")" == "aihub-hermes-enrollment/v1" ]] \
    || fail "the enrollment bundle format is unsupported"
  jq -e '
    (.nodeId | type == "string") and
    (.nodeSlug | type == "string") and
    (.token | type == "string" and length >= 32) and
    (.controlPlaneUrl | test("^https?://")) and
    (.hermesBaseUrl | test("^https?://")) and
    (.hermesImage | type == "string" and length >= 3) and
    (.expiresAt | type == "string")
  ' "${bundle}" >/dev/null || fail "the enrollment bundle is incomplete"

  local expires_at expires_epoch
  expires_at="$(jq -r '.expiresAt' "${bundle}")"
  expires_epoch="$(date --date="${expires_at}" '+%s' 2>/dev/null)" || fail "the enrollment expiry is invalid"
  (( expires_epoch > $(date '+%s') )) || fail "the enrollment bundle has expired; issue a new invitation in AIHub"
}

write_heartbeat_client() {
  install -d -m 0755 /usr/local/lib/aihub
  install -m 0755 /dev/stdin /usr/local/lib/aihub/hermes-heartbeat.sh <<'HEARTBEAT'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_ROOT="${AIHUB_HERMES_STATE_ROOT:-/var/lib/aihub-hermes}"
CONTROL_PLANE_URL="$(<"${STATE_ROOT}/control-plane-url")"
NODE_ID="$(<"${STATE_ROOT}/node-id")"
PRIVATE_KEY="${STATE_ROOT}/identity/node.key"
IMAGE_REFERENCE="$(<"${STATE_ROOT}/image-reference")"

sign_request() {
  local timestamp="$1" nonce="$2" body="$3"
  local body_digest message
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  message="$(printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}")"
  printf '%s' "${message}" \
    | openssl pkeyutl -sign -rawin -inkey "${PRIVATE_KEY}" \
    | openssl base64 -A \
    | tr '+/' '-_' \
    | tr -d '='
}

hermes_status="DEGRADED"
if curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null; then
  hermes_status="ONLINE"
fi
observed_at="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
payload="$(jq -cS -n \
  --arg observedAt "${observed_at}" \
  --arg status "${hermes_status}" \
  --arg version "${IMAGE_REFERENCE}" \
  '{observedAt:$observedAt,status:$status,hermesVersion:$version,capabilities:["gateway-api","signed-heartbeat"]}')"
timestamp="${observed_at}"
nonce="$(cat /proc/sys/kernel/random/uuid)"
signature="$(sign_request "${timestamp}" "${nonce}" "${payload}")"

curl --fail --silent --show-error --max-time 15 \
  -H 'Content-Type: application/json' \
  -H "X-AIHub-Node-Timestamp: ${timestamp}" \
  -H "X-AIHub-Node-Nonce: ${nonce}" \
  -H "X-AIHub-Node-Signature: ${signature}" \
  --data-binary "${payload}" \
  "${CONTROL_PLANE_URL}/api/v1/runtime-nodes/${NODE_ID}/heartbeat" >/dev/null
HEARTBEAT

  install -m 0644 /dev/stdin "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" <<EOF
[Unit]
Description=AIHub Hermes runtime node heartbeat
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=AIHUB_HERMES_STATE_ROOT=${STATE_ROOT}
ExecStart=/usr/local/lib/aihub/hermes-heartbeat.sh
User=root
Group=root
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=${STATE_ROOT}
EOF

  install -m 0644 /dev/stdin "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" <<EOF
[Unit]
Description=Send AIHub Hermes runtime node heartbeat every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
RandomizedDelaySec=10s
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

main() {
  require_root
  [[ "$#" -eq 1 ]] || fail "usage: install-hermes-node.sh <enrollment-bundle.json>"
  local bundle
  bundle="$(realpath "$1")"
  install_host_dependencies
  validate_bundle "${bundle}"

  [[ ! -e "${STATE_ROOT}/node-id" ]] || fail "this host is already enrolled; revoke it in AIHub before rebuilding the node"
  docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1 && fail "a container named '${CONTAINER_NAME}' already exists"

  local node_id token control_plane_url hermes_base_url hermes_image hostname_value public_key api_key
  node_id="$(jq -r '.nodeId' "${bundle}")"
  token="$(jq -r '.token' "${bundle}")"
  control_plane_url="$(jq -r '.controlPlaneUrl' "${bundle}" | sed 's:/*$::')"
  hermes_base_url="$(jq -r '.hermesBaseUrl' "${bundle}" | sed 's:/*$::')"
  hermes_image="$(jq -r '.hermesImage' "${bundle}")"
  hostname_value="$(hostname --fqdn 2>/dev/null || hostname)"

  install -d -m 0700 "${STATE_ROOT}" "${STATE_ROOT}/identity"
  install -d -m 0750 -o 10000 -g 10000 "${STATE_ROOT}/data"
  openssl genpkey -algorithm ED25519 -out "${STATE_ROOT}/identity/node.key"
  chmod 0600 "${STATE_ROOT}/identity/node.key"
  openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -out "${STATE_ROOT}/identity/node.pub"
  public_key="$(<"${STATE_ROOT}/identity/node.pub")"
  api_key="$(openssl rand -hex 32)"

  install -m 0600 /dev/stdin "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
EOF
  chown 10000:10000 "${STATE_ROOT}/data/.env"

  printf 'Pulling Hermes image %s...\n' "${hermes_image}"
  docker pull "${hermes_image}"
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --memory "${HERMES_MEMORY_LIMIT:-4g}" \
    --cpus "${HERMES_CPU_LIMIT:-2}" \
    --pids-limit 512 \
    --cap-drop ALL \
    --cap-add CHOWN \
    --cap-add DAC_OVERRIDE \
    --cap-add SETGID \
    --cap-add SETUID \
    --security-opt no-new-privileges:true \
    -e HERMES_UID=10000 \
    -e HERMES_GID=10000 \
    -e API_SERVER_ENABLED=true \
    -e API_SERVER_HOST=0.0.0.0 \
    -e API_SERVER_PORT=8642 \
    -e "API_SERVER_KEY=${api_key}" \
    -v "${STATE_ROOT}/data:/opt/data" \
    -p 8642:8642 \
    "${hermes_image}" gateway run >/dev/null

  local deadline=$((SECONDS + 180))
  until curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      docker logs --tail 100 "${CONTAINER_NAME}" >&2 || true
      docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
      fail "Hermes did not become healthy within three minutes"
    fi
    sleep 2
  done

  local request_file response_file http_status
  request_file="$(mktemp)"
  response_file="$(mktemp)"
  trap 'rm -f "${request_file:-}" "${response_file:-}"' EXIT
  jq -n \
    --arg nodeId "${node_id}" \
    --arg token "${token}" \
    --arg hostname "${hostname_value}" \
    --arg publicKeyPem "${public_key}" \
    --arg apiKey "${api_key}" \
    --arg hermesVersion "${hermes_image}" \
    --arg installerVersion "${INSTALLER_VERSION}" \
    '{nodeId:$nodeId,token:$token,hostname:$hostname,publicKeyPem:$publicKeyPem,apiKey:$apiKey,hermesVersion:$hermesVersion,installerVersion:$installerVersion,capabilities:["gateway-api","signed-heartbeat"]}' \
    > "${request_file}"
  http_status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' --data-binary "@${request_file}" \
    "${control_plane_url}/api/v1/runtime-nodes/enroll")"
  if [[ "${http_status}" != "200" ]]; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    fail "AIHub rejected enrollment (HTTP ${http_status}): $(jq -r '.message // "unknown error"' "${response_file}" 2>/dev/null)"
  fi

  jq -e '
    (.modelBootstrap.provider == "custom") and
    (.modelBootstrap.baseUrl | test("^https?://")) and
    (.modelBootstrap.modelAlias | type == "string" and length > 0) and
    (.modelBootstrap.apiKey | type == "string" and length > 0)
  ' "${response_file}" >/dev/null || fail "AIHub enrollment omitted the approved LiteLLM runtime route"
  local model_base_url_json model_alias_json model_api_key_json
  model_base_url_json="$(jq -c '.modelBootstrap.baseUrl' "${response_file}")"
  model_alias_json="$(jq -c '.modelBootstrap.modelAlias' "${response_file}")"
  model_api_key_json="$(jq -c '.modelBootstrap.apiKey' "${response_file}")"
  install -m 0640 -o 10000 -g 10000 /dev/stdin "${STATE_ROOT}/data/config.yaml" <<EOF
model:
  default: ${model_alias_json}
  provider: custom
  base_url: ${model_base_url_json}
EOF
  install -m 0600 -o 10000 -g 10000 /dev/stdin "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
OPENAI_BASE_URL=${model_base_url_json}
OPENAI_API_KEY=${model_api_key_json}
EOF
  docker restart "${CONTAINER_NAME}" >/dev/null
  deadline=$((SECONDS + 180))
  until curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null 2>&1; do
    (( SECONDS < deadline )) || fail "Hermes did not recover after applying the AIHub-managed LiteLLM route"
    sleep 2
  done

  printf '%s' "${node_id}" > "${STATE_ROOT}/node-id"
  printf '%s' "${control_plane_url}" > "${STATE_ROOT}/control-plane-url"
  printf '%s' "${hermes_base_url}" > "${STATE_ROOT}/hermes-base-url"
  printf '%s' "${hermes_image}" > "${STATE_ROOT}/image-reference"
  chmod 0600 "${STATE_ROOT}/node-id" "${STATE_ROOT}/control-plane-url" "${STATE_ROOT}/hermes-base-url" "${STATE_ROOT}/image-reference"

  write_heartbeat_client
  systemctl daemon-reload
  systemctl enable --now "${HEARTBEAT_SERVICE}.timer"
  systemctl start "${HEARTBEAT_SERVICE}.service"

  printf '\nHermes runtime node enrolled successfully.\n'
  printf 'Runtime API: %s\n' "${hermes_base_url}"
  printf 'Node identity: %s\n' "$(openssl pkey -pubin -in "${STATE_ROOT}/identity/node.pub" -outform DER | sha256sum | awk '{print $1}')"
  printf 'The enrollment token is consumed. AIHub now monitors this node without SSH or a Docker socket.\n'
  printf 'Enforce the VM firewall allowlist before production activation: AIHub to TCP/8642, and this node to AIHub HTTPS plus approved inference/MCP destinations.\n'
}

main "$@"
