#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

INSTALLER_VERSION="ai-v1.21.11"
STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTAINER_NAME="orcasynapse-hermes"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
HERMES_UID="10000"
HERMES_GID="10000"
SUPERMEMORY_ROOT="${ORCASYNAPSE_SUPERMEMORY_STATE_ROOT:-/var/lib/orcasynapse-supermemory}"
SUPERMEMORY_SERVICE="orcasynapse-supermemory"
SUPERMEMORY_USER="orcasynapse-supermemory"
SUPERMEMORY_EMBEDDING_MODEL="Xenova/bge-m3"
SUPERMEMORY_EMBEDDING_DIMENSIONS="1024"
SUPERMEMORY_START_TIMEOUT_SECONDS=600
SUPERMEMORY_READY_PATH="/v4/openapi"
ENROLLMENT_STATE="${STATE_ROOT}/enrollment-state.json"
TEMPORARY_FILES=()
RESOLVED_BUNDLE=""
INSTALLATION_COMPLETED=0
HERMES_BOOTSTRAP_MANAGED_DIR="${STATE_ROOT}/data/.orcasynapse-bootstrap-managed"

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
    printf '  Establishing node enrollment context'
    for _ in 1 2 3; do
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

render_activity_progress() {
  local label="$1" elapsed="$2" tick="$3" width=24 segment=6 span position
  local leading trailing active bar
  span=$((2 * (width - segment)))
  position=$((tick % span))
  (( position > width - segment )) && position=$((span - position))
  printf -v leading '%*s' "${position}" ''
  printf -v trailing '%*s' "$((width - segment - position))" ''
  printf -v active '%*s' "${segment}" ''
  active="${active// /=}"
  bar="${leading}${active}${trailing}"
  printf '\r\033[2K  %b[RUN]%b [%s] %-36.36s %4ss' \
    "${UI_CYAN}${UI_BOLD}" "${UI_RESET}" "${bar}" "${label}" "${elapsed}"
}

run_with_progress() {
  local label="$1"
  shift
  if (( ! UI_INTERACTIVE )); then
    info "${label}"
    "$@"
    success "${label}"
    return
  fi

  local log_file pid status=0 frame_index=0 started elapsed
  log_file="$(mktemp /tmp/orcasynapse-command.XXXXXX)"
  TEMPORARY_FILES+=("${log_file}")
  started="${SECONDS}"
  "$@" >"${log_file}" 2>&1 &
  pid=$!
  printf '\033[?25l'
  while kill -0 "${pid}" 2>/dev/null; do
    elapsed=$((SECONDS - started))
    render_activity_progress "${label}" "${elapsed}" "${frame_index}"
    frame_index=$((frame_index + 1))
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

format_transfer_bytes() {
  local bytes="${1:-0}" unit=1 suffix="B" tenths
  if (( bytes >= 1073741824 )); then unit=1073741824; suffix="GB"
  elif (( bytes >= 1048576 )); then unit=1048576; suffix="MB"
  elif (( bytes >= 1024 )); then unit=1024; suffix="KB"
  fi
  if (( unit == 1 )); then printf '%d B' "${bytes}"; return; fi
  tenths=$((bytes * 10 / unit))
  printf '%d.%d %s' "$((tenths / 10))" "$((tenths % 10))" "${suffix}"
}

render_download_progress() {
  local label="$1" current="$2" total="$3" elapsed="$4" width=24 percent=0 filled empty progress remainder speed
  (( total > 0 )) && percent=$((current * 100 / total))
  if (( current < total && percent > 99 )); then percent=99; fi
  (( percent > 100 )) && percent=100
  filled=$((percent * width / 100)); empty=$((width - filled))
  printf -v progress '%*s' "${filled}" ''; printf -v remainder '%*s' "${empty}" ''
  progress="${progress// /=}"; remainder="${remainder// / }"
  (( elapsed > 0 )) && speed=$((current / elapsed)) || speed=0
  printf '\r\033[2K  %b[DL]%b [%s%s] %3d%%  %-17.17s / %-9.9s  %8s/s  %-24.24s' \
    "${UI_CYAN}${UI_BOLD}" "${UI_RESET}" "${progress}" "${remainder}" "${percent}" \
    "$(format_transfer_bytes "${current}")" "$(format_transfer_bytes "${total}")" "$(format_transfer_bytes "${speed}")" "${label}"
}

download_with_progress() {
  local label="$1" url="$2" destination="$3"
  local headers total=0 log_file pid status=0 started current=0 elapsed=0 tick=0
  headers="$(curl --fail --silent --show-error --location --head --max-time 30 "${url}" 2>/dev/null || true)"
  total="$(printf '%s\n' "${headers}" | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" && $2 ~ /^[0-9]+$/ { size=$2 } END { print size+0 }')"
  log_file="$(mktemp /tmp/orcasynapse-download.XXXXXX)"
  TEMPORARY_FILES+=("${log_file}")
  started="${SECONDS}"
  curl --fail --silent --show-error --location --retry 3 --max-time 1800 \
    "${url}" --output "${destination}" 2>"${log_file}" &
  pid=$!
  if (( UI_INTERACTIVE )); then printf '\033[?25l'; else info "${label}"; fi
  while kill -0 "${pid}" 2>/dev/null; do
    current="$(stat -c '%s' "${destination}" 2>/dev/null || printf '0')"
    elapsed=$((SECONDS - started))
    if (( UI_INTERACTIVE )); then
      if (( total > 0 )); then render_download_progress "${label}" "${current}" "${total}" "${elapsed}"
      else render_activity_progress "${label}" "${elapsed}" "${tick}"
      fi
    fi
    tick=$((tick + 1)); sleep 0.12
  done
  if wait "${pid}"; then status=0; else status=$?; fi
  current="$(stat -c '%s' "${destination}" 2>/dev/null || printf '0')"
  elapsed=$((SECONDS - started))
  if (( UI_INTERACTIVE )); then
    if (( status == 0 )); then
      (( total > 0 )) || total="${current}"
      render_download_progress "${label}" "${total}" "${total}" "${elapsed}"
    fi
    printf '\r\033[2K\033[?25h'
  fi
  if (( status != 0 )); then
    printf '  %b[FAIL]%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "${label}" >&2
    tail -n 40 "${log_file}" >&2 || true
    return "${status}"
  fi
  rm -f -- "${log_file}"
  success "${label} ($(format_transfer_bytes "${current}") transferred)."
}

fail() {
  printf '\n%bERROR%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  (( UI_INTERACTIVE )) && printf '\033[?25h'
  remove_hermes_bootstrap_policy
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
  [[ "${EUID}" -eq 0 ]] || fail "run the installer as root (for example: sudo ./install-agentic-node.sh enrollment.json)"
}

require_ubuntu_host() {
  [[ -r /etc/os-release ]] || fail "VM2 must run Ubuntu with a readable /etc/os-release"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "VM2 must run Ubuntu; detected '${PRETTY_NAME:-unknown operating system}'"
  [[ -n "${VERSION_ID:-}" ]] || fail "the Ubuntu release version could not be identified"
  [[ -d /run/systemd/system ]] || fail "VM2 must be an Ubuntu systemd VM, not a minimal container userland"
  case "$(uname -m)" in
    x86_64|aarch64) ;;
    *) fail "VM2 architecture '$(uname -m)' is unsupported; use x86_64 or aarch64 Ubuntu" ;;
  esac
}

install_hermes_directory() {
  local mode="$1" destination="$2"
  install -d -m "${mode}" "${destination}"
  chown "${HERMES_UID}:${HERMES_GID}" "${destination}"
}

write_file_from_stdin() {
  local mode="$1" owner="$2" group="$3" destination="$4" parent temporary
  parent="${destination%/*}"
  [[ -d "${parent}" ]] || fail "managed-file parent directory '${parent}' does not exist"
  temporary="$(mktemp "${parent}/.orcasynapse-write.XXXXXX")" \
    || fail "could not create a protected temporary file in '${parent}'"
  TEMPORARY_FILES+=("${temporary}")
  cat > "${temporary}" || fail "could not write managed file '${destination}'"
  chmod "${mode}" "${temporary}"
  chown "${owner}:${group}" "${temporary}"
  mv -f -- "${temporary}" "${destination}" \
    || fail "could not atomically replace managed file '${destination}'"
}

install_hermes_file_from_stdin() {
  local mode="$1" destination="$2"
  write_file_from_stdin "${mode}" "${HERMES_UID}" "${HERMES_GID}" "${destination}"
}

remove_hermes_bootstrap_policy() {
  rm -f -- "${HERMES_BOOTSTRAP_MANAGED_DIR}/config.yaml"
  rmdir -- "${HERMES_BOOTSTRAP_MANAGED_DIR}" 2>/dev/null || true
}

write_hermes_managed_policy() {
  local model_alias_json="$1" model_base_url_json="$2"
  install -d -m 0755 "${STATE_ROOT}/managed"
  chown root:root "${STATE_ROOT}/managed"
  write_file_from_stdin 0644 root root "${STATE_ROOT}/managed/config.yaml" <<EOF
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
}

install_hermes_memory_provider() {
  # Hermes' immutable Docker image deliberately redirects allowlisted optional
  # dependencies into /opt/data/lazy-packages. Use a process-local managed
  # scope for that one installation; the live /etc/hermes policy remains
  # fail-closed even if this installer is interrupted.
  remove_hermes_bootstrap_policy
  install -d -m 0755 -o root -g root "${HERMES_BOOTSTRAP_MANAGED_DIR}"
  write_file_from_stdin 0644 root root "${HERMES_BOOTSTRAP_MANAGED_DIR}/config.yaml" <<'EOF'
security:
  allow_lazy_installs: true
EOF

  local install_status=0
  run_with_progress "Install the governed Hermes memory provider" \
    docker exec \
      --env HERMES_MANAGED_DIR=/opt/data/.orcasynapse-bootstrap-managed \
      --user "${HERMES_UID}:${HERMES_GID}" \
      "${CONTAINER_NAME}" python -c \
      'from tools.lazy_deps import ensure; ensure("memory.supermemory", prompt=False)' \
    || install_status=$?
  remove_hermes_bootstrap_policy
  (( install_status == 0 )) || return "${install_status}"

  run_with_progress "Verify the locked Hermes memory provider" \
    docker exec --user "${HERMES_UID}:${HERMES_GID}" "${CONTAINER_NAME}" python -c \
      'from tools.lazy_deps import activate_durable_lazy_target, feature_missing; activate_durable_lazy_target(); missing = feature_missing("memory.supermemory"); assert not missing, f"missing dependencies: {missing}"; import supermemory' \
    || return $?
}

install_host_dependencies() {
  require_ubuntu_host
  if ! command -v docker >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1 \
    || ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    run_with_progress "Refresh operating-system packages" apt-get update \
      || fail "could not refresh Ubuntu package metadata"
    run_with_progress "Install runtime security dependencies" env DEBIAN_FRONTEND=noninteractive \
      apt-get install -y ca-certificates curl jq openssl docker.io \
      || fail "could not install Docker and runtime security dependencies"
  fi
  run_with_progress "Enable the Docker service" systemctl enable --now docker \
    || fail "could not enable the Docker service"
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable after startup"

  local required_command
  for required_command in install chown useradd journalctl sha256sum awk sed grep date hostname mktemp cat chmod mv; do
    command -v "${required_command}" >/dev/null 2>&1 \
      || fail "the Ubuntu host is missing required command '${required_command}'"
  done
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
    ((.identityFingerprint == null) or (.identityFingerprint | test("^[a-f0-9]{64}$"))) and
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

assert_supermemory_release_usable() {
  local installed_version="${1#v}"
  case "${installed_version}" in
    0.0.6)
      fail "Supermemory Local v0.0.6 is blocked because its published binary cannot load RivetKit; document ingestion and search are non-functional (upstream issues #1315 and #1324). Issue a new enrollment pinned to 0.0.7-rc.2 or a newer release explicitly validated by your organization"
      ;;
  esac
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
  local body_digest message_file signature sign_status=0
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  message_file="$(mktemp /tmp/orcasynapse-node-signature.XXXXXX)"
  printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}" > "${message_file}"
  signature="$(
    openssl pkeyutl -sign -rawin \
      -inkey "${STATE_ROOT}/identity/node.key" \
      -in "${message_file}" \
      | openssl base64 -A \
      | tr '+/' '-_' \
      | tr -d '='
  )" || sign_status=$?
  rm -f -- "${message_file}"
  (( sign_status == 0 )) || return "${sign_status}"
  printf '%s' "${signature}"
}

public_identity_fingerprint() {
  openssl pkey -pubin -in "${STATE_ROOT}/identity/node.pub" -outform DER 2>/dev/null \
    | sha256sum \
    | awk '{print $1}'
}

private_identity_fingerprint() {
  openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -outform DER 2>/dev/null \
    | sha256sum \
    | awk '{print $1}'
}

verify_enrolled_identity() {
  local node_id="$1" control_plane_url="$2" hermes_image="$3" node_fingerprint="$4"
  local observed_at node_status payload nonce signature response_file http_status response_error
  node_status="DEGRADED"
  if curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null; then
    node_status="ONLINE"
  fi
  observed_at="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  payload="$(jq -cS -n \
    --arg observedAt "${observed_at}" \
    --arg status "${node_status}" \
    --arg version "${hermes_image}" \
    '{observedAt:$observedAt,status:$status,hermesVersion:$version,capabilities:["gateway-api","signed-heartbeat"]}')"
  nonce="$(cat /proc/sys/kernel/random/uuid)"
  signature="$(sign_node_payload "${payload}" "${observed_at}" "${nonce}")"
  response_file="$(mktemp)"
  TEMPORARY_FILES+=("${response_file}")
  http_status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' \
    -H "X-OrcaSynapse-Node-Timestamp: ${observed_at}" \
    -H "X-OrcaSynapse-Node-Nonce: ${nonce}" \
    -H "X-OrcaSynapse-Node-Signature: ${signature}" \
    --data-binary "${payload}" \
    "${control_plane_url}/api/v1/runtime-nodes/${node_id}/heartbeat")"
  if [[ "${http_status}" == "200" ]]; then
    return 0
  fi
  response_error="$(jq -r '.message // .error // empty' "${response_file}" 2>/dev/null \
    | LC_ALL=C tr -cd '[:print:]' || true)"
  response_error="${response_error:0:400}"
  [[ -n "${response_error}" ]] || response_error="The control plane returned no diagnostic message."
  if [[ "${http_status}" == "401" ]]; then
    fail "VM1 rejected the enrolled VM2 identity ${node_fingerprint} for node ${node_id}. The retained VM2 state and dashboard record no longer share the same trust binding. Revoke and decommission the stale Agentic System node in the dashboard, run 'curl --fail --show-error --location --progress-bar ${control_plane_url}/install/remove-agentic-node.sh | sudo bash' on VM2, then issue a fresh installer claim. Server response: ${response_error}"
  fi
  fail "VM1 could not verify the enrolled VM2 trust binding (HTTP ${http_status}): ${response_error}"
}

install_supermemory_binary() {
  local requested_version="$1" install_dir="$2" bin_dir="$3"
  local release platform asset release_base binary_file checksum_file expected_checksum actual_checksum next_binary version_file
  release="$(normalize_supermemory_release "${requested_version}")"
  [[ "${release}" != "latest" ]] || fail "the secured VM2 installer requires an exact Supermemory release instead of mutable 'latest'"
  case "$(uname -m)" in
    x86_64) platform="linux-x64" ;;
    aarch64) platform="linux-arm64" ;;
    *) fail "Supermemory does not publish a verified binary for architecture '$(uname -m)'" ;;
  esac
  asset="supermemory-server-${platform}"
  release_base="https://github.com/supermemoryai/supermemory/releases/download/server-v${release}"
  binary_file="$(mktemp /tmp/orcasynapse-supermemory-binary.XXXXXX)"
  checksum_file="$(mktemp /tmp/orcasynapse-supermemory-sha256.XXXXXX)"
  TEMPORARY_FILES+=("${binary_file}" "${checksum_file}")
  download_with_progress "Download Supermemory ${release}" "${release_base}/${asset}" "${binary_file}"
  download_with_progress "Download Supermemory checksum" "${release_base}/${asset}.sha256" "${checksum_file}"
  expected_checksum="$(awk 'NR == 1 && $1 ~ /^[a-f0-9]{64}$/ { print $1 }' "${checksum_file}")"
  [[ -n "${expected_checksum}" ]] || fail "the Supermemory release checksum is malformed"
  actual_checksum="$(sha256sum "${binary_file}" | awk '{print $1}')"
  [[ "${actual_checksum}" == "${expected_checksum}" ]] || fail "the Supermemory release checksum did not match"
  install -d -m 0750 "${install_dir}/bin" "${bin_dir}"
  next_binary="${install_dir}/bin/.supermemory-server.${release}.new"
  install -m 0755 "${binary_file}" "${next_binary}"
  mv -f -- "${next_binary}" "${install_dir}/bin/supermemory-server"
  version_file="${install_dir}/bin/.supermemory-server.version.new"
  printf '%s\n' "${release}" > "${version_file}"
  chmod 0644 "${version_file}"
  mv -f -- "${version_file}" "${install_dir}/bin/supermemory-server.version"
  ln -sfn "${install_dir}/bin/supermemory-server" "${bin_dir}/supermemory-server"
  success "Verified and installed Supermemory Local ${release}."
}

supermemory_ready() {
  local base_url="${1%/}"
  curl --fail --silent --max-time 5 "${base_url}${SUPERMEMORY_READY_PATH}" >/dev/null 2>&1
}

supermemory_journal() {
  local invocation_id="${1:-}"
  if [[ -n "${invocation_id}" ]]; then
    journalctl "_SYSTEMD_INVOCATION_ID=${invocation_id}" --no-pager -o cat 2>/dev/null
  else
    journalctl -u "${SUPERMEMORY_SERVICE}.service" --no-pager -o cat 2>/dev/null
  fi
}

parse_supermemory_download_progress() {
  sed -nE 's/^[[:space:]]*\[[=[:space:]]+\][[:space:]]+([0-9]{1,3})%[[:space:]]+[^[:alnum:]]+[[:space:]]+(.*)$/\1|\2/p' \
    | tail -1
}

parse_supermemory_embedding_model() {
  sed -nE 's/^[[:space:]]*[*+>][[:space:]]+local embeddings[[:space:]]+([^[:space:]]+)[[:space:]]+.*/\1/p' \
    | grep -vE '^[0-9]+$' \
    | head -1
}

render_supermemory_progress() {
  local percent="$1" detail="$2" elapsed="$3" width=24 filled empty progress remainder
  filled=$((percent * width / 100))
  empty=$((width - filled))
  printf -v progress '%*s' "${filled}" ''
  printf -v remainder '%*s' "${empty}" ''
  progress="${progress// /=}"
  remainder="${remainder// / }"
  printf '\r\033[2K  %b[DL]%b [%s%s] %3d%%  %-20.20s %4ss' \
    "${UI_CYAN}${UI_BOLD}" "${UI_RESET}" "${progress}" "${remainder}" "${percent}" "${detail}" "${elapsed}"
}

print_safe_supermemory_diagnostics() {
  local invocation_id="${1:-}"
  supermemory_journal "${invocation_id}" \
    | sed -E 's/sm_[A-Za-z0-9_-]{20,}/sm_[REDACTED]/g' \
    | grep -Ei 'startup|download|embedding|fetching|worker|ready|failed|error|panic|fatal|dimension|provider|database' \
    | tail -n 80 >&2 || true
}

wait_for_supermemory() {
  local base_url="$1" invocation_id="$2"
  local deadline=$((SECONDS + SUPERMEMORY_START_TIMEOUT_SECONDS))
  local started="${SECONDS}" last_percent="" progress_record="" percent="" detail=""
  local frame_index=0

  if (( UI_INTERACTIVE )); then
    printf '\033[?25l'
  else
    info "Waiting for Supermemory model initialization and API readiness."
  fi

  until supermemory_ready "${base_url}"; do
    if ! systemctl is-active --quiet "${SUPERMEMORY_SERVICE}.service"; then
      (( UI_INTERACTIVE )) && printf '\r\033[2K\033[?25h'
      print_safe_supermemory_diagnostics "${invocation_id}"
      fail "Supermemory Local stopped before its API became ready"
    fi

    progress_record="$(supermemory_journal "${invocation_id}" | parse_supermemory_download_progress || true)"
    if [[ -n "${progress_record}" ]]; then
      percent="${progress_record%%|*}"
      detail="${progress_record#*|}"
      if (( UI_INTERACTIVE )); then
        render_supermemory_progress "${percent}" "${detail}" "$((SECONDS - started))"
      elif [[ "${percent}" != "${last_percent}" ]]; then
        printf '  [DL] [%-24s] %3d%%  %s\n' "$(printf '%*s' $((percent * 24 / 100)) '' | tr ' ' '=')" "${percent}" "${detail}"
      fi
      last_percent="${percent}"
    elif (( UI_INTERACTIVE )); then
      render_activity_progress "Initialize Supermemory embeddings" "$((SECONDS - started))" "${frame_index}"
      frame_index=$((frame_index + 1))
    fi

    if (( SECONDS >= deadline )); then
      (( UI_INTERACTIVE )) && printf '\r\033[2K\033[?25h'
      print_safe_supermemory_diagnostics "${invocation_id}"
      fail "Supermemory Local did not become ready within ten minutes"
    fi
    sleep 1
  done

  if (( UI_INTERACTIVE )); then
    if [[ -n "${last_percent}" ]]; then
      render_supermemory_progress 100 "model ready" "$((SECONDS - started))"
      printf '\n\033[?25h'
    else
      printf '\r\033[2K\033[?25h'
    fi
  fi
}

verify_supermemory_document_pipeline() {
  local base_url="${1%/}" api_key="$2"
  local source_file response_file state_file document_id custom_id http_status status deadline
  local started="${SECONDS}" frame_index=0 last_status=""
  source_file="$(mktemp /tmp/orcasynapse-supermemory-check.XXXXXX.txt)"
  response_file="$(mktemp /tmp/orcasynapse-supermemory-response.XXXXXX.json)"
  state_file="$(mktemp /tmp/orcasynapse-supermemory-state.XXXXXX.json)"
  TEMPORARY_FILES+=("${source_file}" "${response_file}" "${state_file}")
  custom_id="orcasynapse_install_check_$(openssl rand -hex 12)"
  printf '%s\n' 'OrcaSynapse verifies local document extraction, embedding, and indexing during enrollment.' > "${source_file}"

  http_status="$(curl --silent --show-error --max-time 30 \
    --output "${response_file}" --write-out '%{http_code}' \
    --request POST \
    --header "Authorization: Bearer ${api_key}" \
    --form "file=@${source_file};type=text/plain;filename=orcasynapse-memory-check.txt" \
    --form 'containerTags=orcasynapse-install-check' \
    --form "customId=${custom_id}" \
    "${base_url}/v3/documents/file")" \
    || fail "Supermemory could not accept its end-to-end document verification source"
  [[ "${http_status}" =~ ^2[0-9][0-9]$ ]] \
    || fail "Supermemory rejected its end-to-end document verification source (HTTP ${http_status})"
  document_id="$(jq -r '.id // .documentId // empty' "${response_file}" 2>/dev/null || true)"
  [[ -n "${document_id}" ]] || fail "Supermemory accepted its verification source without returning a document ID"

  deadline=$((SECONDS + 300))
  if (( UI_INTERACTIVE )); then
    printf '\033[?25l'
  else
    info "Verify local document extraction, BGE-M3 embedding, and indexing."
  fi
  while (( SECONDS < deadline )); do
    http_status="$(curl --silent --show-error --max-time 15 \
      --output "${state_file}" --write-out '%{http_code}' \
      --header "Authorization: Bearer ${api_key}" \
      "${base_url}/v3/documents/${document_id}")" || http_status="000"
    if [[ "${http_status}" =~ ^2[0-9][0-9]$ ]]; then
      status="$(jq -r '.status // "unknown"' "${state_file}" 2>/dev/null || printf 'unknown')"
      if (( UI_INTERACTIVE )); then
        render_activity_progress "Document pipeline: ${status}" "$((SECONDS - started))" "${frame_index}"
        frame_index=$((frame_index + 1))
      elif [[ "${status}" != "${last_status}" ]]; then
        info "Supermemory verification status: ${status}."
      fi
      last_status="${status}"
      case "${status}" in
        done)
          (( UI_INTERACTIVE )) && printf '\r\033[2K\033[?25h'
          curl --fail --silent --max-time 15 --request DELETE \
            --header "Authorization: Bearer ${api_key}" \
            "${base_url}/v3/documents/${document_id}" >/dev/null 2>&1 || true
          success "Supermemory document extraction, BGE-M3 embedding, and indexing passed."
          return 0
          ;;
        failed)
          (( UI_INTERACTIVE )) && printf '\r\033[2K\033[?25h'
          curl --fail --silent --max-time 15 --request DELETE \
            --header "Authorization: Bearer ${api_key}" \
            "${base_url}/v3/documents/${document_id}" >/dev/null 2>&1 || true
          print_safe_supermemory_diagnostics
          fail "Supermemory's local document pipeline failed before enrollment completed. BGE-M3 only embeds extracted text; verify that the approved OpenAI-compatible chat model supports structured extraction, then rerun this installer"
          ;;
      esac
    fi
    sleep 2
  done

  (( UI_INTERACTIVE )) && printf '\r\033[2K\033[?25h'
  curl --fail --silent --max-time 15 --request DELETE \
    --header "Authorization: Bearer ${api_key}" \
    "${base_url}/v3/documents/${document_id}" >/dev/null 2>&1 || true
  print_safe_supermemory_diagnostics
  fail "Supermemory's end-to-end document pipeline did not finish within five minutes"
}

install_supermemory() {
  local inference_base_url="$1" model_alias="$2" gateway_key="$3" requested_version="$4"
  local install_dir="${SUPERMEMORY_ROOT}/install"
  local bin_dir="${SUPERMEMORY_ROOT}/bin"
  local installed_version=""

  if ! id -u "${SUPERMEMORY_USER}" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home \
      --home-dir "${SUPERMEMORY_ROOT}" --shell /usr/sbin/nologin "${SUPERMEMORY_USER}"
  fi
  [[ "$(id -gn "${SUPERMEMORY_USER}")" == "${SUPERMEMORY_USER}" ]] \
    || fail "the retained Supermemory service account does not have its expected private primary group"
  install -d -m 0750 -o "${SUPERMEMORY_USER}" -g "${SUPERMEMORY_USER}" \
    "${SUPERMEMORY_ROOT}" "${SUPERMEMORY_ROOT}/data" "${install_dir}" "${bin_dir}"

  if [[ -x "${install_dir}/bin/supermemory-server" && -s "${install_dir}/bin/supermemory-server.version" ]]; then
    installed_version="$(<"${install_dir}/bin/supermemory-server.version")"
    if ! supermemory_release_matches "${requested_version}" "${installed_version}"; then
      warning "Upgrading retained Supermemory Local ${installed_version} to the dashboard-pinned ${requested_version} release. The encrypted data and embedding plan are preserved."
      install_supermemory_binary "${requested_version}" "${install_dir}" "${bin_dir}" \
        || fail "Supermemory Local upgrade failed"
      installed_version="$(<"${install_dir}/bin/supermemory-server.version")"
    else
      info "Reusing the protected Supermemory Local installation already present on this node."
    fi
  else
    install_supermemory_binary "${requested_version}" "${install_dir}" "${bin_dir}" \
      || fail "Supermemory Local installation failed"
    installed_version="$(<"${install_dir}/bin/supermemory-server.version")"
  fi
  assert_supermemory_release_usable "${installed_version}"
  chown -R "${SUPERMEMORY_USER}:${SUPERMEMORY_USER}" "${SUPERMEMORY_ROOT}"

  write_file_from_stdin 0600 "${SUPERMEMORY_USER}" "${SUPERMEMORY_USER}" "${SUPERMEMORY_ROOT}/runtime.env" <<EOF
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

  write_file_from_stdin 0644 root root "/etc/systemd/system/${SUPERMEMORY_SERVICE}.service" <<EOF
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
# always, not on-failure: a long-running memory plane that exits cleanly still
# leaves Hermes without recall, and nothing else on VM2 would restart it.
Restart=always
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${SUPERMEMORY_ROOT}

[Install]
WantedBy=multi-user.target
EOF
  info "Supermemory will initialize local embeddings; first boot downloads and prewarms model weights."
  systemctl daemon-reload
  systemctl enable "${SUPERMEMORY_SERVICE}.service" >/dev/null
  systemctl restart "${SUPERMEMORY_SERVICE}.service"

  local invocation_id
  invocation_id="$(systemctl show "${SUPERMEMORY_SERVICE}.service" --property=InvocationID --value 2>/dev/null || true)"
  wait_for_supermemory "http://127.0.0.1:6767" "${invocation_id}"

  local memory_api_key="" native_api_key_file="${SUPERMEMORY_ROOT}/data/api-key"
  if [[ -s "${SUPERMEMORY_ROOT}/api-key" ]]; then
    memory_api_key="$(<"${SUPERMEMORY_ROOT}/api-key")"
  elif [[ -s "${native_api_key_file}" ]]; then
    memory_api_key="$(<"${native_api_key_file}")"
  else
    local key_deadline=$((SECONDS + 120))
    while [[ -z "${memory_api_key}" && ${SECONDS} -lt ${key_deadline} ]]; do
      memory_api_key="$(journalctl -u "${SUPERMEMORY_SERVICE}.service" --no-pager -o cat 2>/dev/null \
        | grep -Eo 'sm_[A-Za-z0-9_-]{20,}' | tail -1 || true)"
      [[ -n "${memory_api_key}" ]] || sleep 1
    done
  fi
  [[ "${memory_api_key}" =~ ^sm_[A-Za-z0-9_-]{20,}$ ]] \
    || fail "Supermemory Local started but its first-boot API key could not be captured safely"
  printf '%s' "${memory_api_key}" > "${SUPERMEMORY_ROOT}/api-key"
  chown root:root "${SUPERMEMORY_ROOT}/api-key"
  chmod 0600 "${SUPERMEMORY_ROOT}/api-key"
  verify_supermemory_document_pipeline "http://127.0.0.1:6767" "${memory_api_key}"
  local actual_embedding_model
  actual_embedding_model="$(supermemory_journal "${invocation_id}" | parse_supermemory_embedding_model || true)"
  if [[ -n "${actual_embedding_model}" && "${actual_embedding_model}" != "${SUPERMEMORY_EMBEDDING_MODEL}" ]]; then
    success "Supermemory Local API is ready with ${actual_embedding_model}."
    warning "Supermemory started with ${actual_embedding_model}; its current release ignored the requested ${SUPERMEMORY_EMBEDDING_MODEL} setting (upstream issue #1336)."
    warning "Non-English semantic recall is reduced until Supermemory ships configurable local embeddings."
  elif [[ -n "${actual_embedding_model}" ]]; then
    success "Supermemory Local is ready with ${actual_embedding_model} (${SUPERMEMORY_EMBEDDING_DIMENSIONS} dimensions)."
  else
    success "Supermemory Local API is ready; the embedding model was already cached and not reported during this start."
  fi
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

resolved_image_reference() {
  local image="$1" digest=""
  if [[ "${image}" == *@sha256:* ]]; then
    printf '%s' "${image}"
    return 0
  fi
  digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "${image}" 2>/dev/null || true)"
  [[ "${digest}" == *@sha256:* ]] || return 1
  printf '%s' "${digest}"
}

write_heartbeat_client() {
  install -d -m 0755 /usr/local/lib/orcasynapse
  write_file_from_stdin 0755 root root /usr/local/lib/orcasynapse/hermes-heartbeat.sh <<'HEARTBEAT'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTROL_PLANE_URL="$(<"${STATE_ROOT}/control-plane-url")"
NODE_ID="$(<"${STATE_ROOT}/node-id")"
PRIVATE_KEY="${STATE_ROOT}/identity/node.key"
IMAGE_REFERENCE="$(<"${STATE_ROOT}/image-reference")"

sign_request() {
  local timestamp="$1" nonce="$2" body="$3"
  local body_digest message_file signature sign_status=0
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  message_file="$(mktemp /tmp/orcasynapse-heartbeat-signature.XXXXXX)"
  printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}" > "${message_file}"
  signature="$(
    openssl pkeyutl -sign -rawin \
      -inkey "${PRIVATE_KEY}" \
      -in "${message_file}" \
      | openssl base64 -A \
      | tr '+/' '-_' \
      | tr -d '='
  )" || sign_status=$?
  rm -f -- "${message_file}"
  (( sign_status == 0 )) || return "${sign_status}"
  printf '%s' "${signature}"
}

# Hermes answers /health the moment its API server binds, which is long before
# Supermemory has loaded its embedding model - and Docker restarts the Hermes
# container independently of the Supermemory unit. Reporting ONLINE on the
# Hermes port alone is how a node presents a healthy runtime whose memory plane
# is unusable. Both planes must answer before this node claims to be online.
hermes_status="DEGRADED"
if curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null \
  && curl --fail --silent --max-time 5 http://127.0.0.1:6767/v4/openapi >/dev/null; then
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

  write_file_from_stdin 0644 root root "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" <<EOF
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

  write_file_from_stdin 0644 root root "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" <<EOF
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
  success "Ubuntu, systemd, Docker, OpenSSL, curl, and jq are ready."

  step 2 7 "Resolve or resume the protected enrollment"
  local bundle="" resuming=0
  local node_id token control_plane_url hermes_base_url hermes_image supermemory_release hostname_value public_key api_key
  local node_fingerprint private_fingerprint retained_fingerprint enrolled_fingerprint
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
      fail "usage: install-agentic-node.sh <enrollment-bundle.json> | install-agentic-node.sh --connect <OrcaSynapse-origin>"
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
  install_hermes_directory 0750 "${STATE_ROOT}/data"
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
  node_fingerprint="$(public_identity_fingerprint)" \
    || fail "the VM2 public identity is unreadable"
  private_fingerprint="$(private_identity_fingerprint)" \
    || fail "the VM2 private identity is unreadable"
  [[ "${node_fingerprint}" == "${private_fingerprint}" ]] \
    || fail "the retained VM2 private and public identity files do not belong to the same Ed25519 keypair"
  if (( resuming )); then
    retained_fingerprint="$(jq -r '.identityFingerprint // empty' "${ENROLLMENT_STATE}")"
    if [[ -n "${retained_fingerprint}" && "${retained_fingerprint}" != "${node_fingerprint}" ]]; then
      fail "the protected enrollment receipt belongs to identity ${retained_fingerprint}, but this VM2 now holds ${node_fingerprint}; do not continue with mixed trust state"
    fi
  fi
  public_key="$(<"${STATE_ROOT}/identity/node.pub")"
  success "Node identity and protected runtime state verified (${node_fingerprint:0:16}...)."

  install_hermes_file_from_stdin 0600 "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
EOF

  step 4 7 "Start the hardened Hermes runtime"
  if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    (( resuming )) || fail "a container named '${CONTAINER_NAME}' already exists"
    docker start "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    run_with_progress "Verify retained Hermes runtime" wait_for_hermes 0 \
      || fail "the retained Hermes runtime is not healthy"
    hermes_image="$(resolved_image_reference "$(docker inspect --format '{{.Image}}' "${CONTAINER_NAME}")")" \
      || fail "the retained Hermes runtime image has no immutable registry digest"
  else
    run_with_progress "Pull approved Hermes image" docker pull "${hermes_image}" \
      || fail "could not pull the approved Hermes image '${hermes_image}'"
    hermes_image="$(resolved_image_reference "${hermes_image}")" \
      || fail "the approved Hermes image has no immutable registry digest"
    success "Resolved the Hermes runtime to immutable artifact ${hermes_image}."
    run_with_progress "Launch hardened Hermes container" docker run -d \
    --name "${CONTAINER_NAME}" \
    --label io.orcasynapse.managed=true \
    --label io.orcasynapse.component=agentic-runtime \
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
    -e "HERMES_UID=${HERMES_UID}" \
    -e "HERMES_GID=${HERMES_GID}" \
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

    run_with_progress "Verify Hermes runtime health" wait_for_hermes 1 \
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
    enrolled_fingerprint="$(jq -r '.node.identityFingerprint // empty' "${response_file}")"
    [[ "${enrolled_fingerprint}" == "${node_fingerprint}" ]] \
      || fail "OrcaSynapse enrolled identity '${enrolled_fingerprint:-missing}' instead of the VM2 identity '${node_fingerprint}'"
    jq -n \
      --arg nodeId "${node_id}" --arg controlPlaneUrl "${control_plane_url}" \
      --arg hermesBaseUrl "${hermes_base_url}" --arg hermesImage "${hermes_image}" \
      --arg supermemoryVersion "${supermemory_release}" \
      --arg hostname "${hostname_value}" --arg apiKey "${api_key}" \
      --arg identityFingerprint "${node_fingerprint}" \
      --argjson modelBootstrap "$(jq -c '.modelBootstrap' "${response_file}")" \
      '{format:"orcasynapse-hermes-resume/v1",nodeId:$nodeId,controlPlaneUrl:$controlPlaneUrl,hermesBaseUrl:$hermesBaseUrl,hermesImage:$hermesImage,supermemoryVersion:$supermemoryVersion,hostname:$hostname,apiKey:$apiKey,identityFingerprint:$identityFingerprint,modelBootstrap:$modelBootstrap}' \
      > "${resume_file}"
    install -m 0600 -o root -g root "${resume_file}" "${ENROLLMENT_STATE}"
    success "Node enrolled; protected recovery state was saved before continuing."
  fi

  verify_enrolled_identity "${node_id}" "${control_plane_url}" "${hermes_image}" "${node_fingerprint}"
  success "VM1 accepted the signed VM2 trust handshake."

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
  supermemory_ready "${supermemory_base_url}" \
    || fail "Supermemory is ready on loopback but is not reachable through the invited runtime host on TCP 6767"

  install_hermes_directory 0750 "${STATE_ROOT}/data"
  write_hermes_managed_policy "${model_alias_json}" "${model_base_url_json}"
  install_hermes_memory_provider \
    || fail "Hermes could not install and verify its governed Supermemory provider"
  install_hermes_file_from_stdin 0640 "${STATE_ROOT}/data/supermemory.json" <<EOF
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
  install_hermes_file_from_stdin 0600 "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
OPENAI_BASE_URL=${model_base_url_json}
OPENAI_API_KEY=${model_api_key_json}
SUPERMEMORY_API_KEY=${supermemory_api_key}
EOF
  run_with_progress "Apply the managed runtime policy" docker restart "${CONTAINER_NAME}" \
    || fail "Hermes could not restart with its managed policy"
  run_with_progress "Verify governed runtime recovery" wait_for_hermes 0 \
    || fail "Hermes did not recover after applying the OrcaSynapse-managed inference route"

  step 7 7 "Register memory and enable monitoring"
  local memory_payload memory_timestamp memory_nonce memory_signature memory_status
  local memory_response_file memory_error node_fingerprint
  memory_payload="$(jq -cS -n \
    --arg baseUrl "${supermemory_base_url}" \
    --arg apiKey "${supermemory_api_key}" \
    --arg observedVersion "${supermemory_version}" \
    '{baseUrl:$baseUrl,apiKey:$apiKey,observedVersion:$observedVersion}')"
  memory_timestamp="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  memory_nonce="$(cat /proc/sys/kernel/random/uuid)"
  memory_signature="$(sign_node_payload "${memory_payload}" "${memory_timestamp}" "${memory_nonce}")"
  memory_response_file="$(mktemp)"
  TEMPORARY_FILES+=("${memory_response_file}")
  memory_status="$(curl --silent --show-error --output "${memory_response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' \
    -H "X-OrcaSynapse-Node-Timestamp: ${memory_timestamp}" \
    -H "X-OrcaSynapse-Node-Nonce: ${memory_nonce}" \
    -H "X-OrcaSynapse-Node-Signature: ${memory_signature}" \
    --data-binary "${memory_payload}" \
    "${control_plane_url}/api/v1/runtime-nodes/${node_id}/memory")"
  if [[ "${memory_status}" != "200" ]]; then
    memory_error="$(jq -r '.message // .error // empty' "${memory_response_file}" 2>/dev/null \
      | LC_ALL=C tr -cd '[:print:]' || true)"
    memory_error="${memory_error:0:400}"
    [[ -n "${memory_error}" ]] || memory_error="The control plane returned no diagnostic message."
    fail "OrcaSynapse rejected Supermemory registration (HTTP ${memory_status}): ${memory_error} Local identity fingerprint: ${node_fingerprint}"
  fi

  printf '%s' "${node_id}" > "${STATE_ROOT}/node-id"
  printf '%s' "${control_plane_url}" > "${STATE_ROOT}/control-plane-url"
  printf '%s' "${hermes_base_url}" > "${STATE_ROOT}/hermes-base-url"
  printf '%s' "${hermes_image}" > "${STATE_ROOT}/image-reference"
  chmod 0600 "${STATE_ROOT}/node-id" "${STATE_ROOT}/control-plane-url" "${STATE_ROOT}/hermes-base-url" "${STATE_ROOT}/image-reference"

  write_heartbeat_client
  systemctl daemon-reload
  systemctl enable --now "${HEARTBEAT_SERVICE}.timer"
  systemctl start "${HEARTBEAT_SERVICE}.service"

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

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
