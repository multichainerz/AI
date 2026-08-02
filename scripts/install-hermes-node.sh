#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

INSTALLER_VERSION="ai-v1.13.0"
STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTAINER_NAME="orcasynapse-hermes"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
SUPERMEMORY_ROOT="${ORCASYNAPSE_SUPERMEMORY_STATE_ROOT:-/var/lib/orcasynapse-supermemory}"
SUPERMEMORY_SERVICE="orcasynapse-supermemory"
SUPERMEMORY_USER="orcasynapse-supermemory"
SUPERMEMORY_EMBEDDING_MODEL="Xenova/bge-m3"
SUPERMEMORY_EMBEDDING_DIMENSIONS="1024"
SUPERMEMORY_START_TIMEOUT_SECONDS=600
ENROLLMENT_STATE="${STATE_ROOT}/enrollment-state.json"
TEMPORARY_FILES=()
RESOLVED_BUNDLE=""
INSTALLATION_COMPLETED=0

if [[ -t 1 && "${TERM:-dumb}" != "dumb" ]]; then
  UI_INTERACTIVE=1
else
  UI_INTERACTIVE=0
fi

if (( UI_INTERACTIVE )) && [[ -z "${NO_COLOR:-}" ]]; then
  UI_BOLD=$'\033[1m'
  UI_DIM=$'\033[2m'
  UI_BLUE=$'\033[38;5;75m'
  UI_CYAN=$'\033[38;5;80m'
  UI_GREEN=$'\033[38;5;78m'
  UI_AMBER=$'\033[38;5;214m'
  UI_RED=$'\033[38;5;203m'
  UI_RESET=$'\033[0m'
else
  UI_BOLD=""
  UI_DIM=""
  UI_BLUE=""
  UI_CYAN=""
  UI_GREEN=""
  UI_AMBER=""
  UI_RED=""
  UI_RESET=""
fi

ui_pause() {
  (( UI_INTERACTIVE )) && sleep "${1:-0.08}"
  return 0
}

banner() {
  printf '%b' "${UI_BLUE}${UI_BOLD}"
  cat <<'EOF'

     ____                _____
    / __ \___________ _ / ___/__  ______  ____ _____  ________
   / / / / ___/ ___/  '/\__ \/ / / / __ \/ __ `/ __ \/ ___/ _ \
  / /_/ / /  / /__/ /| |__/ / /_/ / / / / /_/ / /_/ (__  )  __/
  \____/_/   \___/_/ |_/____/\__, /_/ /_/\__,_/ .___/____/\___/
                             /____/            /_/

EOF
  printf '%b\n' "${UI_RESET}${UI_DIM}  AGENTIC SYSTEM  /  VM2 SECURE ENROLLMENT${UI_RESET}"
  printf '%b\n' "${UI_DIM}  ----------------------------------------------------------------------${UI_RESET}"
  if (( UI_INTERACTIVE )); then
    local dots
    printf '  Establishing node enrollment context'
    for dots in 1 2 3; do
      printf '%b.%b' "${UI_CYAN}" "${UI_RESET}"
      ui_pause 0.12
    done
    printf ' %bREADY%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  fi
}

step() {
  local current="$1" total="$2" label="$3" width=28 filled empty progress remainder
  filled=$((current * width / total))
  empty=$((width - filled))
  printf -v progress '%*s' "${filled}" ''
  printf -v remainder '%*s' "${empty}" ''
  progress="${progress// /#}"
  remainder="${remainder// /.}"
  printf '\n%b  STEP %02d OF %02d%b  %b%s%b\n' \
    "${UI_CYAN}${UI_BOLD}" "${current}" "${total}" "${UI_RESET}" "${UI_BOLD}" "${label}" "${UI_RESET}"
  printf '  %b[%s%s]%b %3d%%\n' "${UI_BLUE}" "${progress}" "${remainder}" "${UI_RESET}" "$((current * 100 / total))"
}

info() {
  printf '      %b>%b %s\n' "${UI_BLUE}" "${UI_RESET}" "$1"
}

success() {
  printf '  %b[ OK ]%b %s\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}" "$1"
}

warning() {
  printf '  %b[WARN]%b %s\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" "$1" >&2
}

run_with_spinner() {
  local label="$1"
  shift
  if (( ! UI_INTERACTIVE )); then
    info "${label}"
    "$@"
    success "${label}"
    return
  fi

  local log_file pid status=0 frame_index=0 started elapsed
  local frames=('|' '/' '-' '\')
  log_file="$(mktemp /tmp/orcasynapse-command.XXXXXX)"
  TEMPORARY_FILES+=("${log_file}")
  started="${SECONDS}"
  "$@" >"${log_file}" 2>&1 &
  pid=$!
  printf '\033[?25l'
  while kill -0 "${pid}" 2>/dev/null; do
    elapsed=$((SECONDS - started))
    printf '\r  %b[%s]%b %-48s %4ss' "${UI_CYAN}${UI_BOLD}" "${frames[frame_index]}" "${UI_RESET}" "${label}" "${elapsed}"
    frame_index=$(((frame_index + 1) % ${#frames[@]}))
    sleep 0.12
  done
  if wait "${pid}"; then status=0; else status=$?; fi
  printf '\r\033[2K\033[?25h'
  if (( status == 0 )); then
    rm -f -- "${log_file}"
    success "${label}"
    return 0
  fi

  printf '  %b[FAIL]%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "${label}" >&2
  tail -n 120 "${log_file}" >&2 || true
  rm -f -- "${log_file}"
  return "${status}"
}

fail() {
  printf '\n%bERROR%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  (( UI_INTERACTIVE )) && printf '\033[?25h'
  local file
  for file in "${TEMPORARY_FILES[@]:-}"; do
    [[ -z "${file}" || ! -e "${file}" ]] || rm -f -- "${file}"
  done
  if (( status != 0 )) && [[ -s "${ENROLLMENT_STATE}" ]] && (( INSTALLATION_COMPLETED == 0 )); then
    printf '\n%b[RECOVERY]%b Protected enrollment state was retained. Rerun the same installer command to resume safely.\n' \
      "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  fi
  return "${status}"
}
trap cleanup EXIT

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
  run_with_spinner "Refresh operating-system packages" apt-get update \
    || fail "could not refresh operating-system packages"
  run_with_spinner "Install runtime security dependencies" env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y ca-certificates curl jq openssl docker.io \
    || fail "could not install Docker and runtime security dependencies"
  run_with_spinner "Enable the Docker service" systemctl enable --now docker \
    || fail "could not enable the Docker service"
}

validate_bundle() {
  local bundle="$1"
  [[ -r "${bundle}" ]] || fail "the enrollment bundle is not readable"
  [[ "$(jq -r '.format // empty' "${bundle}")" == "orcasynapse-hermes-enrollment/v1" ]] \
    || fail "the enrollment bundle format is unsupported"
  jq -e '
    (.nodeId | type == "string") and
    (.nodeSlug | type == "string") and
    (.token | type == "string" and length >= 32) and
    (.controlPlaneUrl | test("^https?://")) and
    (.hermesBaseUrl | test("^https?://")) and
    (.hermesImage | type == "string" and length >= 3) and
    (.supermemoryVersion | type == "string" and length > 0) and
    (.expiresAt | type == "string")
  ' "${bundle}" >/dev/null || fail "the enrollment bundle is incomplete"

  local expires_at expires_epoch
  expires_at="$(jq -r '.expiresAt' "${bundle}")"
  expires_epoch="$(date --date="${expires_at}" '+%s' 2>/dev/null)" || fail "the enrollment expiry is invalid"
  (( expires_epoch > $(date '+%s') )) || fail "the enrollment bundle has expired; issue a new invitation in OrcaSynapse"
}

validate_resume_state() {
  local state_file="$1"
  [[ -r "${state_file}" ]] || return 1
  jq -e '
    (.format == "orcasynapse-hermes-resume/v1") and
    (.nodeId | type == "string" and length > 0) and
    (.controlPlaneUrl | test("^https?://")) and
    (.hermesBaseUrl | test("^https?://")) and
    (.hermesImage | type == "string" and length > 0) and
    (.supermemoryVersion | type == "string" and length > 0) and
    (.hostname | type == "string" and length > 0) and
    (.apiKey | type == "string" and length >= 32) and
    (.modelBootstrap.baseUrl | test("^https?://")) and
    (.modelBootstrap.modelAlias | type == "string" and length > 0) and
    (.modelBootstrap.apiKey | type == "string" and length > 0)
  ' "${state_file}" >/dev/null
}

supermemory_release_matches() {
  local requested_version="$1" installed_version="$2"
  [[ "${requested_version}" == "latest" || "${installed_version#v}" == "${requested_version#v}" ]]
}

normalize_supermemory_release() {
  local requested_version="$1"
  [[ "${requested_version}" == "latest" ]] && printf 'latest' || printf '%s' "${requested_version#v}"
}

resolve_bundle_from_orcasynapse() {
  local control_plane_url="$1"
  control_plane_url="${control_plane_url%/}"
  [[ "${control_plane_url}" =~ ^https?://[^/?#]+$ ]] \
    || fail "--connect must be an OrcaSynapse origin without a path, query, or fragment"

  local token=""
  if [[ -n "${ORCASYNAPSE_ENROLLMENT_TOKEN_FILE:-}" ]]; then
    [[ -r "${ORCASYNAPSE_ENROLLMENT_TOKEN_FILE}" ]] || fail "ORCASYNAPSE_ENROLLMENT_TOKEN_FILE is not readable"
    token="$(tr -d '\r\n' < "${ORCASYNAPSE_ENROLLMENT_TOKEN_FILE}")"
  else
    [[ -r /dev/tty && -w /dev/tty ]] \
      || fail "a terminal is required to enter the one-time claim; alternatively set ORCASYNAPSE_ENROLLMENT_TOKEN_FILE"
    printf '\n%bSECURE CLAIM%b\n' "${UI_CYAN}${UI_BOLD}" "${UI_RESET}" > /dev/tty
    printf 'Paste the one-time claim shown by OrcaSynapse (input hidden): ' > /dev/tty
    IFS= read -r -s token < /dev/tty
    printf '\n' > /dev/tty
  fi
  [[ ${#token} -ge 32 ]] || fail "the one-time enrollment claim is incomplete"

  local request_file response_file http_status returned_control_plane
  request_file="$(mktemp)"
  response_file="$(mktemp)"
  TEMPORARY_FILES+=("${request_file}" "${response_file}")
  jq -n --arg token "${token}" '{token:$token}' > "${request_file}"
  token=""
  http_status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' --data-binary "@${request_file}" \
    "${control_plane_url}/api/v1/runtime-nodes/bootstrap")"
  if [[ "${http_status}" != "200" ]]; then
    fail "OrcaSynapse rejected the bootstrap claim (HTTP ${http_status}): $(jq -r '.message // "unknown error"' "${response_file}" 2>/dev/null)"
  fi

  validate_bundle "${response_file}"
  returned_control_plane="$(jq -r '.controlPlaneUrl' "${response_file}" | sed 's:/*$::')"
  [[ "${returned_control_plane}" == "${control_plane_url}" ]] \
    || fail "OrcaSynapse returned a bundle bound to a different control-plane origin"
  RESOLVED_BUNDLE="${response_file}"
}

sign_node_payload() {
  local body="$1" timestamp="$2" nonce="$3"
  local body_digest message
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  message="$(printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}")"
  printf '%s' "${message}" \
    | openssl pkeyutl -sign -rawin -inkey "${STATE_ROOT}/identity/node.key" \
    | openssl base64 -A \
    | tr '+/' '-_' \
    | tr -d '='
}

install_supermemory_binary() {
  local requested_version="$1" install_dir="$2" bin_dir="$3"
  local install_target
  install_target="$(normalize_supermemory_release "${requested_version}")"
  curl -fsSL https://supermemory.ai/install \
    | SUPERMEMORY_INSTALL_DIR="${install_dir}" \
      SUPERMEMORY_BIN_DIR="${bin_dir}" \
      SUPERMEMORY_NO_START=1 \
      SUPERMEMORY_NO_PROMPT=1 \
      bash -s -- "${install_target}"
}

install_supermemory() {
  local inference_base_url="$1" model_alias="$2" gateway_key="$3" requested_version="$4"
  local install_dir="${SUPERMEMORY_ROOT}/install"
  local bin_dir="${SUPERMEMORY_ROOT}/bin"

  if ! id -u "${SUPERMEMORY_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir "${SUPERMEMORY_ROOT}" --shell /usr/sbin/nologin "${SUPERMEMORY_USER}"
  fi
  install -d -m 0750 -o "${SUPERMEMORY_USER}" -g "${SUPERMEMORY_USER}" \
    "${SUPERMEMORY_ROOT}" "${SUPERMEMORY_ROOT}/data" "${install_dir}" "${bin_dir}"

  if [[ -x "${install_dir}/bin/supermemory-server" && -s "${install_dir}/bin/supermemory-server.version" ]]; then
    local installed_version
    installed_version="$(<"${install_dir}/bin/supermemory-server.version")"
    if ! supermemory_release_matches "${requested_version}" "${installed_version}"; then
      fail "the retained Supermemory release '${installed_version}' does not match the dashboard-pinned release '${requested_version}'"
    fi
    info "Reusing the protected Supermemory Local installation already present on this node."
  else
    run_with_spinner "Install Supermemory Local (${requested_version})" \
      install_supermemory_binary "${requested_version}" "${install_dir}" "${bin_dir}" \
      || fail "Supermemory Local installation failed"
  fi
  chown -R "${SUPERMEMORY_USER}:${SUPERMEMORY_USER}" "${SUPERMEMORY_ROOT}"

  install -m 0600 -o "${SUPERMEMORY_USER}" -g "${SUPERMEMORY_USER}" /dev/stdin "${SUPERMEMORY_ROOT}/runtime.env" <<EOF
OPENAI_BASE_URL=${inference_base_url}
OPENAI_API_KEY=${gateway_key}
OPENAI_MODEL=${model_alias}
OPENAI_FAST_MODEL=${model_alias}
OPENAI_TEXT_MODEL=${model_alias}
SUPERMEMORY_DATA_DIR=${SUPERMEMORY_ROOT}/data
SUPERMEMORY_PORT=6767
SUPERMEMORY_EMBEDDING_PROVIDER=local
SUPERMEMORY_EMBEDDING_MODEL=${SUPERMEMORY_EMBEDDING_MODEL}
SUPERMEMORY_EMBEDDING_DIMENSIONS=${SUPERMEMORY_EMBEDDING_DIMENSIONS}
SUPERMEMORY_DISABLE_TELEMETRY=1
EOF

  install -m 0644 /dev/stdin "/etc/systemd/system/${SUPERMEMORY_SERVICE}.service" <<EOF
[Unit]
Description=OrcaSynapse Supermemory Local runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SUPERMEMORY_USER}
Group=${SUPERMEMORY_USER}
WorkingDirectory=${SUPERMEMORY_ROOT}
EnvironmentFile=${SUPERMEMORY_ROOT}/runtime.env
ExecStart=${install_dir}/bin/supermemory-server
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${SUPERMEMORY_ROOT}

[Install]
WantedBy=multi-user.target
EOF
  info "Supermemory will download and prewarm ${SUPERMEMORY_EMBEDDING_MODEL} locally on VM2."
  systemctl daemon-reload
  systemctl enable --now "${SUPERMEMORY_SERVICE}.service"

  local deadline=$((SECONDS + SUPERMEMORY_START_TIMEOUT_SECONDS))
  until curl --fail --silent --max-time 5 http://127.0.0.1:6767/health >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      journalctl -u "${SUPERMEMORY_SERVICE}.service" --no-pager -n 100 >&2 || true
      fail "Supermemory Local did not become healthy within ten minutes"
    fi
    sleep 2
  done

  local memory_api_key=""
  if [[ -s "${SUPERMEMORY_ROOT}/api-key" ]]; then
    memory_api_key="$(<"${SUPERMEMORY_ROOT}/api-key")"
  else
    local key_deadline=$((SECONDS + 120))
    while [[ -z "${memory_api_key}" && ${SECONDS} -lt ${key_deadline} ]]; do
      memory_api_key="$(journalctl -u "${SUPERMEMORY_SERVICE}.service" --no-pager -o cat 2>/dev/null \
        | grep -Eo 'sm_[A-Za-z0-9_-]{20,}' | tail -1 || true)"
      [[ -n "${memory_api_key}" ]] || sleep 1
    done
  fi
  [[ -n "${memory_api_key}" ]] || fail "Supermemory Local started but its first-boot API key could not be captured"
  printf '%s' "${memory_api_key}" > "${SUPERMEMORY_ROOT}/api-key"
  chown root:root "${SUPERMEMORY_ROOT}/api-key"
  chmod 0600 "${SUPERMEMORY_ROOT}/api-key"
  success "Supermemory Local is healthy with ${SUPERMEMORY_EMBEDDING_MODEL} (${SUPERMEMORY_EMBEDDING_DIMENSIONS} dimensions)."
}

wait_for_hermes() {
  local remove_on_failure="${1:-0}"
  local deadline=$((SECONDS + 180))
  until curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      docker logs --tail 100 "${CONTAINER_NAME}" >&2 || true
      if [[ "${remove_on_failure}" == "1" ]]; then
        docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
      fi
      return 1
    fi
    sleep 2
  done
}

write_heartbeat_client() {
  install -d -m 0755 /usr/local/lib/orcasynapse
  install -m 0755 /dev/stdin /usr/local/lib/orcasynapse/hermes-heartbeat.sh <<'HEARTBEAT'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
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
  -H "X-OrcaSynapse-Node-Timestamp: ${timestamp}" \
  -H "X-OrcaSynapse-Node-Nonce: ${nonce}" \
  -H "X-OrcaSynapse-Node-Signature: ${signature}" \
  --data-binary "${payload}" \
  "${CONTROL_PLANE_URL}/api/v1/runtime-nodes/${NODE_ID}/heartbeat" >/dev/null
HEARTBEAT

  install -m 0644 /dev/stdin "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" <<EOF
[Unit]
Description=OrcaSynapse Hermes runtime node heartbeat
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=ORCASYNAPSE_HERMES_STATE_ROOT=${STATE_ROOT}
ExecStart=/usr/local/lib/orcasynapse/hermes-heartbeat.sh
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
Description=Send OrcaSynapse Hermes runtime node heartbeat every minute

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
  banner

  step 1 7 "Validate the isolated host"
  require_root
  install_host_dependencies
  success "Docker, OpenSSL, curl, and jq are ready."

  step 2 7 "Resolve or resume the protected enrollment"
  local bundle="" resuming=0
  local node_id token control_plane_url hermes_base_url hermes_image supermemory_release hostname_value public_key api_key
  if [[ -s "${ENROLLMENT_STATE}" ]]; then
    validate_resume_state "${ENROLLMENT_STATE}" || fail "the protected enrollment recovery state is invalid"
    resuming=1
    node_id="$(jq -r '.nodeId' "${ENROLLMENT_STATE}")"
    control_plane_url="$(jq -r '.controlPlaneUrl' "${ENROLLMENT_STATE}" | sed 's:/*$::')"
    hermes_base_url="$(jq -r '.hermesBaseUrl' "${ENROLLMENT_STATE}" | sed 's:/*$::')"
    hermes_image="$(jq -r '.hermesImage' "${ENROLLMENT_STATE}")"
    supermemory_release="$(jq -r '.supermemoryVersion' "${ENROLLMENT_STATE}")"
    hostname_value="$(jq -r '.hostname' "${ENROLLMENT_STATE}")"
    api_key="$(jq -r '.apiKey' "${ENROLLMENT_STATE}")"
    if [[ "$#" -eq 2 && "$1" == "--connect" ]]; then
      [[ "${2%/}" == "${control_plane_url}" ]] || fail "the resume command points to a different OrcaSynapse origin"
    elif [[ "$#" -eq 1 && "$1" != "--connect" ]]; then
      [[ -r "$1" ]] || fail "the original enrollment bundle is not readable"
      [[ "$(jq -r '.nodeId // empty' "$1")" == "${node_id}" ]] \
        || fail "the enrollment bundle belongs to a different runtime node"
    else
      fail "resume with the same --connect command or the original enrollment-bundle path"
    fi
    success "Protected enrollment state found; continuing without another claim."
  else
    [[ ! -e "${STATE_ROOT}/node-id" ]] || fail "this host is already enrolled; revoke it in OrcaSynapse before rebuilding the node"
    if [[ "$#" -eq 1 && "$1" != "--connect" ]]; then
      bundle="$(realpath "$1")"
    elif [[ "$#" -eq 2 && "$1" == "--connect" ]]; then
      resolve_bundle_from_orcasynapse "$2"
      bundle="${RESOLVED_BUNDLE}"
    else
      fail "usage: install-hermes-node.sh <enrollment-bundle.json> | install-hermes-node.sh --connect <OrcaSynapse-origin>"
    fi
    validate_bundle "${bundle}"
    node_id="$(jq -r '.nodeId' "${bundle}")"
    token="$(jq -r '.token' "${bundle}")"
    control_plane_url="$(jq -r '.controlPlaneUrl' "${bundle}" | sed 's:/*$::')"
    hermes_base_url="$(jq -r '.hermesBaseUrl' "${bundle}" | sed 's:/*$::')"
    hermes_image="$(jq -r '.hermesImage' "${bundle}")"
    supermemory_release="$(jq -r '.supermemoryVersion' "${bundle}")"
    hostname_value="$(hostname --fqdn 2>/dev/null || hostname)"
    docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1 && fail "a container named '${CONTAINER_NAME}' already exists without resumable enrollment state"
    success "Enrollment bundle is valid, unexpired, and bound to OrcaSynapse."
  fi

  step 3 7 "Create the node identity"
  install -d -m 0700 "${STATE_ROOT}" "${STATE_ROOT}/identity"
  # Hermes managed scope is a root-owned, read-only policy layer. The
  # container receives it at /etc/hermes so users cannot override the exact
  # OrcaSynapse-pinned model route and baseline guardrails through /opt/data.
  install -d -m 0755 "${STATE_ROOT}/managed"
  install -d -m 0750 -o 10000 -g 10000 "${STATE_ROOT}/data"
  if (( resuming )); then
    [[ -s "${STATE_ROOT}/identity/node.key" && -s "${STATE_ROOT}/identity/node.pub" ]] \
      || fail "the retained enrollment state is missing its node identity"
    info "Reusing the protected Ed25519 identity created before enrollment."
  else
    info "Generating an Ed25519 identity locally; the private key never leaves VM2."
    openssl genpkey -algorithm ED25519 -out "${STATE_ROOT}/identity/node.key"
    chmod 0600 "${STATE_ROOT}/identity/node.key"
    openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -out "${STATE_ROOT}/identity/node.pub"
    api_key="$(openssl rand -hex 32)"
  fi
  public_key="$(<"${STATE_ROOT}/identity/node.pub")"
  success "Node identity and protected runtime state created."

  install -m 0600 /dev/stdin "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
EOF
  chown 10000:10000 "${STATE_ROOT}/data/.env"

  step 4 7 "Start the hardened Hermes runtime"
  if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    (( resuming )) || fail "a container named '${CONTAINER_NAME}' already exists"
    docker start "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    run_with_spinner "Verify retained Hermes runtime" wait_for_hermes 0 \
      || fail "the retained Hermes runtime is not healthy"
  else
    run_with_spinner "Pull approved Hermes image" docker pull "${hermes_image}" \
      || fail "could not pull the approved Hermes image '${hermes_image}'"
    run_with_spinner "Launch hardened Hermes container" docker run -d \
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
    --add-host host.docker.internal:host-gateway \
    -e HERMES_UID=10000 \
    -e HERMES_GID=10000 \
    -e HERMES_MANAGED_DIR=/etc/hermes \
    -e API_SERVER_ENABLED=true \
    -e API_SERVER_HOST=0.0.0.0 \
    -e API_SERVER_PORT=8642 \
    -e "API_SERVER_KEY=${api_key}" \
    -v "${STATE_ROOT}/data:/opt/data" \
    -v "${STATE_ROOT}/managed:/etc/hermes:ro" \
    -p 8642:8642 \
      "${hermes_image}" gateway run \
      || fail "the hardened Hermes container could not start"

    run_with_spinner "Verify Hermes runtime health" wait_for_hermes 1 \
      || fail "Hermes did not become healthy within three minutes"
  fi

  step 5 7 "Enroll with the OrcaSynapse control plane"
  local model_base_url_json model_alias_json model_api_key_json
  local model_base_url model_alias model_api_key
  if (( resuming )); then
    model_base_url_json="$(jq -c '.modelBootstrap.baseUrl' "${ENROLLMENT_STATE}")"
    model_alias_json="$(jq -c '.modelBootstrap.modelAlias' "${ENROLLMENT_STATE}")"
    model_api_key_json="$(jq -c '.modelBootstrap.apiKey' "${ENROLLMENT_STATE}")"
    model_base_url="$(jq -r '.modelBootstrap.baseUrl' "${ENROLLMENT_STATE}")"
    model_alias="$(jq -r '.modelBootstrap.modelAlias' "${ENROLLMENT_STATE}")"
    model_api_key="$(jq -r '.modelBootstrap.apiKey' "${ENROLLMENT_STATE}")"
    success "Enrollment is already complete; recovered its scoped inference configuration."
  else
    info "Registering the public node identity and requesting the approved inference route."
    local request_file response_file http_status resume_file
    request_file="$(mktemp)"
    response_file="$(mktemp)"
    resume_file="$(mktemp)"
    TEMPORARY_FILES+=("${request_file}" "${response_file}" "${resume_file}")
    jq -n \
    --arg nodeId "${node_id}" \
    --arg token "${token}" \
    --arg hostname "${hostname_value}" \
    --arg publicKeyPem "${public_key}" \
    --arg controlPlaneUrl "${control_plane_url}" \
    --arg apiKey "${api_key}" \
    --arg hermesVersion "${hermes_image}" \
    --arg installerVersion "${INSTALLER_VERSION}" \
    '{nodeId:$nodeId,token:$token,hostname:$hostname,publicKeyPem:$publicKeyPem,controlPlaneUrl:$controlPlaneUrl,apiKey:$apiKey,hermesVersion:$hermesVersion,installerVersion:$installerVersion,capabilities:["gateway-api","signed-heartbeat"]}' \
    > "${request_file}"
  http_status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' --data-binary "@${request_file}" \
    "${control_plane_url}/api/v1/runtime-nodes/enroll")"
    if [[ "${http_status}" != "200" ]]; then
      docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
      fail "OrcaSynapse rejected enrollment (HTTP ${http_status}): $(jq -r '.message // "unknown error"' "${response_file}" 2>/dev/null)"
    fi

    jq -e '
    (.modelBootstrap.provider == "custom") and
    (.modelBootstrap.baseUrl | test("^https?://")) and
    (.modelBootstrap.modelAlias | type == "string" and length > 0) and
    (.modelBootstrap.apiKey | type == "string" and length > 0)
    ' "${response_file}" >/dev/null || fail "OrcaSynapse enrollment omitted its approved inference-gateway route"
    model_base_url_json="$(jq -c '.modelBootstrap.baseUrl' "${response_file}")"
    model_alias_json="$(jq -c '.modelBootstrap.modelAlias' "${response_file}")"
    model_api_key_json="$(jq -c '.modelBootstrap.apiKey' "${response_file}")"
    model_base_url="$(jq -r '.modelBootstrap.baseUrl' "${response_file}")"
    model_alias="$(jq -r '.modelBootstrap.modelAlias' "${response_file}")"
    model_api_key="$(jq -r '.modelBootstrap.apiKey' "${response_file}")"
    jq -n \
      --arg nodeId "${node_id}" --arg controlPlaneUrl "${control_plane_url}" \
      --arg hermesBaseUrl "${hermes_base_url}" --arg hermesImage "${hermes_image}" \
      --arg supermemoryVersion "${supermemory_release}" \
      --arg hostname "${hostname_value}" --arg apiKey "${api_key}" \
      --argjson modelBootstrap "$(jq -c '.modelBootstrap' "${response_file}")" \
      '{format:"orcasynapse-hermes-resume/v1",nodeId:$nodeId,controlPlaneUrl:$controlPlaneUrl,hermesBaseUrl:$hermesBaseUrl,hermesImage:$hermesImage,supermemoryVersion:$supermemoryVersion,hostname:$hostname,apiKey:$apiKey,modelBootstrap:$modelBootstrap}' \
      > "${resume_file}"
    install -m 0600 -o root -g root "${resume_file}" "${ENROLLMENT_STATE}"
    success "Node enrolled; protected recovery state was saved before continuing."
  fi

  step 6 7 "Install memory and managed policy"
  install_supermemory "${model_base_url}" "${model_alias}" "${model_api_key}" "${supermemory_release}"
  local supermemory_api_key supermemory_version runtime_authority runtime_host supermemory_base_url
  supermemory_api_key="$(<"${SUPERMEMORY_ROOT}/api-key")"
  supermemory_version="$(<"${SUPERMEMORY_ROOT}/install/bin/supermemory-server.version")"
  runtime_authority="${hermes_base_url#*://}"
  runtime_authority="${runtime_authority%%/*}"
  if [[ "${runtime_authority}" == \[*\]* ]]; then
    runtime_host="${runtime_authority%%]*}]"
  else
    runtime_host="${runtime_authority%%:*}"
  fi
  [[ -n "${runtime_host}" ]] || fail "the Hermes base URL does not contain a usable runtime host"
  supermemory_base_url="http://${runtime_host}:6767"
  curl --fail --silent --max-time 5 "${supermemory_base_url}/health" >/dev/null 2>&1 \
    || fail "Supermemory is healthy on loopback but is not reachable through the invited runtime host on TCP 6767"

  run_with_spinner "Load the governed Hermes memory provider" \
    docker exec --user 10000:10000 "${CONTAINER_NAME}" python -c \
      'from tools.lazy_deps import ensure; ensure("memory.supermemory", prompt=False)' \
    || fail "Hermes could not load its governed Supermemory provider"
  install -m 0644 -o root -g root /dev/stdin "${STATE_ROOT}/managed/config.yaml" <<EOF
model:
  provider: custom
  default: ${model_alias_json}
  base_url: ${model_base_url_json}
  api_key: \${OPENAI_API_KEY}
# Hermes otherwise falls back to its broad api_server platform preset. Keep
# the production baseline tool-free (including dynamically configured MCP
# servers) until OrcaSynapse explicitly distributes and verifies a governed toolset.
platform_toolsets:
  api_server:
    - no_mcp
memory:
  provider: supermemory
security:
  redact_secrets: true
  allow_lazy_installs: false
tool_loop_guardrails:
  hard_stop_enabled: true
  hard_stop_after:
    exact_failure: 5
    idempotent_no_progress: 5
EOF
  install -m 0640 -o 10000 -g 10000 /dev/stdin "${STATE_ROOT}/data/supermemory.json" <<EOF
{
  "base_url": "http://host.docker.internal:6767",
  "container_tag": "orcasynapse-agent-{identity}",
  "auto_recall": true,
  "auto_capture": true,
  "search_mode": "hybrid",
  "max_recall_results": 10,
  "enable_custom_container_tags": false
}
EOF
  install -m 0600 -o 10000 -g 10000 /dev/stdin "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
OPENAI_BASE_URL=${model_base_url_json}
OPENAI_API_KEY=${model_api_key_json}
SUPERMEMORY_API_KEY=${supermemory_api_key}
EOF
  run_with_spinner "Apply the managed runtime policy" docker restart "${CONTAINER_NAME}" \
    || fail "Hermes could not restart with its managed policy"
  run_with_spinner "Verify governed runtime recovery" wait_for_hermes 0 \
    || fail "Hermes did not recover after applying the OrcaSynapse-managed inference route"

  step 7 7 "Register memory and enable monitoring"
  local memory_payload memory_timestamp memory_nonce memory_signature memory_status
  memory_payload="$(jq -cS -n \
    --arg baseUrl "${supermemory_base_url}" \
    --arg apiKey "${supermemory_api_key}" \
    --arg observedVersion "${supermemory_version}" \
    '{baseUrl:$baseUrl,apiKey:$apiKey,observedVersion:$observedVersion}')"
  memory_timestamp="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  memory_nonce="$(cat /proc/sys/kernel/random/uuid)"
  memory_signature="$(sign_node_payload "${memory_payload}" "${memory_timestamp}" "${memory_nonce}")"
  memory_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' \
    -H "X-OrcaSynapse-Node-Timestamp: ${memory_timestamp}" \
    -H "X-OrcaSynapse-Node-Nonce: ${memory_nonce}" \
    -H "X-OrcaSynapse-Node-Signature: ${memory_signature}" \
    --data-binary "${memory_payload}" \
    "${control_plane_url}/api/v1/runtime-nodes/${node_id}/memory")"
  [[ "${memory_status}" == "200" ]] || fail "OrcaSynapse rejected the Supermemory registration (HTTP ${memory_status})"

  printf '%s' "${node_id}" > "${STATE_ROOT}/node-id"
  printf '%s' "${control_plane_url}" > "${STATE_ROOT}/control-plane-url"
  printf '%s' "${hermes_base_url}" > "${STATE_ROOT}/hermes-base-url"
  printf '%s' "${hermes_image}" > "${STATE_ROOT}/image-reference"
  chmod 0600 "${STATE_ROOT}/node-id" "${STATE_ROOT}/control-plane-url" "${STATE_ROOT}/hermes-base-url" "${STATE_ROOT}/image-reference"

  write_heartbeat_client
  systemctl daemon-reload
  systemctl enable --now "${HEARTBEAT_SERVICE}.timer"
  systemctl start "${HEARTBEAT_SERVICE}.service"

  local node_fingerprint
  node_fingerprint="$(openssl pkey -pubin -in "${STATE_ROOT}/identity/node.pub" -outform DER | sha256sum | awk '{print $1}')"
  success "Signed heartbeat monitoring is active."
  rm -f -- "${ENROLLMENT_STATE}"
  INSTALLATION_COMPLETED=1

  printf '\n%b+======================================================================+%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  printf '%b|  %-68s|%b\n' "${UI_GREEN}${UI_BOLD}" "AGENTIC SYSTEM IS READY" "${UI_RESET}"
  printf '%b+======================================================================+%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  printf '|  %-20s %-47s|\n' 'Hermes API' "${hermes_base_url}"
  printf '|  %-20s %-47s|\n' 'Supermemory API' "${supermemory_base_url}"
  printf '|  %-68s|\n' 'Node identity fingerprint'
  printf '|  %-68s|\n' "${node_fingerprint}"
  printf '%b+======================================================================+%b\n\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  info "The one-time enrollment claim has been consumed."
  info "OrcaSynapse now monitors this node without SSH or a Docker socket."
  warning "Before production, allow OrcaSynapse to reach TCP/8642 and restrict VM2 egress to OrcaSynapse HTTPS plus approved inference and MCP destinations."
  printf '\n%b  NEXT%b  Return to OrcaSynapse and confirm this node reports Healthy.\n' \
    "${UI_CYAN}${UI_BOLD}" "${UI_RESET}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
