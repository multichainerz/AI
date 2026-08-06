#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

INSTALLER_VERSION="v0.9.0"
STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTAINER_NAME="orcasynapse-hermes"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
DESIRED_STATE_SERVICE="orcasynapse-hermes-desired-state"
HERMES_UID="10000"
HERMES_GID="10000"
ENROLLMENT_STATE="${STATE_ROOT}/enrollment-state.json"
TEMPORARY_FILES=()
RESOLVED_BUNDLE=""
INSTALLATION_COMPLETED=0
HERMES_BOOTSTRAP_MANAGED_DIR="${STATE_ROOT}/data/.orcasynapse-bootstrap-managed"

# >>> ORCASYNAPSE-INSTALLER-UI v1 - generated from scripts/lib/installer-ui.sh; edit the library, then run: bash scripts/sync-installer-ui.sh >>>
# shellcheck shell=bash
# OrcaSynapse installer UI library — the single source of truth for the
# terminal experience shared by every installer-family script.
#
# Tree-resident scripts source this file directly. Self-contained scripts
# (install.sh, install-agentic-node.sh, remove-agentic-node.sh are fetched or
# served standalone) embed it verbatim between ORCASYNAPSE-INSTALLER-UI
# markers; edit here, then run: bash scripts/sync-installer-ui.sh
#
# Per-script variation happens only through these hooks, never by editing the
# embedded region:
#   UI_ACCENT            role accent color (defaults to blue)
#   UI_BANNER_TAGLINE    the line under the wordmark
#   UI_BANNER_META       optional dim version/source line under the divider
#   UI_BANNER_ACTIVITY   optional animated readiness label (empty = no dots)
#   UI_DOWNLOAD_MAX_TIME curl --max-time for download_with_progress
#   UI_LOG_FILE          when set, ui_* helpers append plain lines to this log
#   ui_register_temp_file  redefine to track helper temp files for cleanup
#
# Logging contract: secret values (passwords, keys, tokens, claims) must never
# pass through ui_* helpers. Panels that show secrets are printed with raw
# printf by their scripts and are never written to UI_LOG_FILE.

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

: "${UI_ACCENT:=${UI_BLUE}}"
: "${UI_BANNER_TAGLINE:=ORCASYNAPSE}"
: "${UI_BANNER_META:=}"
: "${UI_BANNER_ACTIVITY:=}"
: "${UI_LOG_FILE:=}"

ui_log() {
  [[ -n "${UI_LOG_FILE}" ]] || return 0
  printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >> "${UI_LOG_FILE}" 2>/dev/null || true
}

ui_pause() {
  (( UI_INTERACTIVE )) && sleep "${1:-0.08}"
  return 0
}

ui_show_cursor() {
  (( UI_INTERACTIVE )) && printf '\033[?25h'
  return 0
}

# Hook: helper temp files are announced here so scripts with an EXIT cleanup
# can track them. The default keeps untracked scripts working unchanged.
ui_register_temp_file() {
  :
}

banner() {
  printf '%b' "${UI_ACCENT}${UI_BOLD}"
  cat <<'EOF'

     ____                _____
    / __ \___________ _ / ___/__  ______  ____ _____  ________
   / / / / ___/ ___/  '/\__ \/ / / / __ \/ __ `/ __ \/ ___/ _ \
  / /_/ / /  / /__/ /| |__/ / /_/ / / / / /_/ / /_/ (__  )  __/
  \____/_/   \___/_/ |_/____/\__, /_/ /_/\__,_/ .___/____/\___/
                             /____/            /_/

EOF
  printf '%b\n' "${UI_RESET}${UI_DIM}  ${UI_BANNER_TAGLINE}${UI_RESET}"
  printf '%b\n' "${UI_DIM}  ----------------------------------------------------------------------${UI_RESET}"
  if [[ -n "${UI_BANNER_META}" ]]; then
    printf '%b\n' "${UI_DIM}  ${UI_BANNER_META}${UI_RESET}"
  fi
  if (( UI_INTERACTIVE )) && [[ -n "${UI_BANNER_ACTIVITY}" ]]; then
    printf '  %s' "${UI_BANNER_ACTIVITY}"
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
  printf '  %b[%s%s]%b %3d%%\n' "${UI_ACCENT}" "${progress}" "${remainder}" "${UI_RESET}" "$((current * 100 / total))"
  ui_log "STEP ${current}/${total} ${label}"
}

info() {
  printf '      %b>%b %s\n' "${UI_ACCENT}" "${UI_RESET}" "$1"
  ui_log "info ${1}"
}

success() {
  printf '  %b[ OK ]%b %s\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}" "$1"
  ui_log "ok   ${1}"
}

warning() {
  printf '  %b[WARN]%b %s\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" "$1" >&2
  ui_log "warn ${1}"
}

fail() {
  printf '\n%bERROR%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "$1" >&2
  ui_log "ERROR ${1}"
  exit 1
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
    # Capture the status explicitly: call sites guard with `|| fail`, which
    # suppresses errexit inside this function, so a bare "$@" would fall
    # through to success on failure.
    local direct_status=0
    "$@" || direct_status=$?
    if (( direct_status == 0 )); then
      success "${label}"
    else
      printf '  %b[FAIL]%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "${label}" >&2
      ui_log "FAIL ${label}"
    fi
    return "${direct_status}"
  fi

  local log_file pid status=0 frame_index=0 started elapsed
  log_file="$(mktemp /tmp/orcasynapse-command.XXXXXX)"
  ui_register_temp_file "${log_file}"
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
  if [[ -n "${UI_LOG_FILE}" ]]; then
    {
      printf -- 'FAIL %s — output tail:\n' "${label}"
      tail -n 120 "${log_file}"
    } >> "${UI_LOG_FILE}" 2>/dev/null || true
  fi
  rm -f -- "${log_file}"
  return "${status}"
}

format_transfer_bytes() {
  local bytes="${1:-0}" unit=1 suffix="B" tenths
  if (( bytes >= 1073741824 )); then unit=1073741824; suffix="GB"
  elif (( bytes >= 1048576 )); then unit=1048576; suffix="MB"
  elif (( bytes >= 1024 )); then unit=1024; suffix="KB"
  fi
  if (( unit == 1 )); then
    printf '%d B' "${bytes}"
    return
  fi
  tenths=$((bytes * 10 / unit))
  printf '%d.%d %s' "$((tenths / 10))" "$((tenths % 10))" "${suffix}"
}

render_download_progress() {
  local label="$1" current="$2" total="$3" elapsed="$4" width=24 percent=0 filled empty progress remainder speed
  (( total > 0 )) && percent=$((current * 100 / total))
  if (( current < total && percent > 99 )); then percent=99; fi
  (( percent > 100 )) && percent=100
  filled=$((percent * width / 100))
  empty=$((width - filled))
  printf -v progress '%*s' "${filled}" ''
  printf -v remainder '%*s' "${empty}" ''
  progress="${progress// /=}"
  remainder="${remainder// / }"
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
  ui_register_temp_file "${log_file}"
  started="${SECONDS}"
  curl --fail --silent --show-error --location --retry 3 --max-time "${UI_DOWNLOAD_MAX_TIME:-1800}" \
    "${url}" --output "${destination}" 2>"${log_file}" &
  pid=$!
  if (( UI_INTERACTIVE )); then printf '\033[?25l'; else info "${label}"; fi
  while kill -0 "${pid}" 2>/dev/null; do
    current="$(stat -c '%s' "${destination}" 2>/dev/null || printf '0')"
    elapsed=$((SECONDS - started))
    if (( UI_INTERACTIVE )); then
      if (( total > 0 )); then
        render_download_progress "${label}" "${current}" "${total}" "${elapsed}"
      else
        render_activity_progress "${label}" "${elapsed}" "${tick}"
      fi
    fi
    tick=$((tick + 1))
    sleep 0.12
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
    ui_log "FAIL ${label}"
    rm -f -- "${log_file}"
    return "${status}"
  fi
  rm -f -- "${log_file}"
  success "${label} ($(format_transfer_bytes "${current}") transferred)."
}

ui_panel_rule() {
  local color="$1" edge="${2:-=}" line
  printf -v line '%*s' 70 ''
  printf '%b+%s+%b\n' "${color}${UI_BOLD}" "${line// /${edge}}" "${UI_RESET}"
}

ui_panel_begin() {
  local color="$1" title="$2" edge="${3:-=}"
  printf '\n'
  ui_panel_rule "${color}" "${edge}"
  printf '%b|  %-68s|%b\n' "${color}${UI_BOLD}" "${title}" "${UI_RESET}"
  ui_panel_rule "${color}" "${edge}"
}

ui_panel_kv() {
  printf '|  %-20s %-47s|\n' "$1" "$2"
}

ui_panel_line() {
  printf '|  %-68s|\n' "$1"
}

ui_panel_end() {
  local color="$1" edge="${2:-=}"
  ui_panel_rule "${color}" "${edge}"
  printf '\n'
}

# Resolves the release version from the extracted tree when available. Scripts
# that run standalone (outside a release tree) fall back to "unknown" and
# should prefer their own INSTALLER_VERSION constant.
installer_release_version() {
  local version_file="${ORCASYNAPSE_ROOT:-}/packages/contracts/src/version.ts" version=""
  if [[ -n "${ORCASYNAPSE_ROOT:-}" && -r "${version_file}" ]]; then
    version="$(sed -nE 's/.*ORCASYNAPSE_VERSION = "([^"]+)".*/\1/p' "${version_file}" | head -n 1)"
  fi
  printf '%s' "${version:-unknown}"
}
# <<< ORCASYNAPSE-INSTALLER-UI <<<

UI_ACCENT="${UI_CYAN}"
UI_BANNER_TAGLINE="AGENTIC SYSTEM  /  VM2 SECURE ENROLLMENT"
UI_BANNER_ACTIVITY="Establishing node enrollment context"
UI_BANNER_META="Installer ${INSTALLER_VERSION}"

# Track helper temp files in this script's EXIT cleanup.
ui_register_temp_file() {
  TEMPORARY_FILES+=("$1")
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
    (.hostname | type == "string" and length > 0) and
    (.apiKey | type == "string" and length >= 32) and
    ((.identityFingerprint == null) or (.identityFingerprint | test("^[a-f0-9]{64}$"))) and
    (.modelBootstrap.baseUrl | test("^https?://")) and
    (.modelBootstrap.modelAlias | type == "string" and length > 0) and
    (.modelBootstrap.apiKey | type == "string" and length > 0)
  ' "${state_file}" >/dev/null
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
    fail "VM1 rejected the enrolled VM2 identity ${node_fingerprint} for node ${node_id}. The retained VM2 state and dashboard record no longer share the same trust binding. Revoke and decommission the stale Agentic System node in the dashboard, run 'curl -fsSL ${control_plane_url}/install/remove-agentic-node.sh | sudo bash' on VM2, then issue a fresh installer claim. Server response: ${response_error}"
  fi
  fail "VM1 could not verify the enrolled VM2 trust binding (HTTP ${http_status}): ${response_error}"
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

write_desired_state_client() {
  install -d -m 0755 /usr/local/lib/orcasynapse
  write_file_from_stdin 0755 root root /usr/local/lib/orcasynapse/hermes-desired-state.sh <<'DESIREDSTATE'
#!/usr/bin/env bash
set -Eeuo pipefail

# Applies the toolset allowlist OrcaSynapse has admitted for this installation.
#
# The document is carried base64-encoded and signed over those exact bytes, so
# this never has to reproduce a canonical JSON serialization to check the
# signature: decode, verify, and only then parse.

STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTROL_PLANE_KEY="${STATE_ROOT}/control-plane-key.pem"
MANAGED_CONFIG="${STATE_ROOT}/managed/config.yaml"
CONTAINER_NAME="${ORCASYNAPSE_HERMES_CONTAINER:-orcasynapse-hermes}"

# A node enrolled before the control plane could sign has nothing to verify
# against. Applying an unverified document would be worse than applying none.
[[ -s "${CONTROL_PLANE_KEY}" ]] || exit 0
[[ -s "${MANAGED_CONFIG}" ]] || exit 0

CONTROL_PLANE_URL="$(<"${STATE_ROOT}/control-plane-url")"
NODE_ID="$(<"${STATE_ROOT}/node-id")"
PRIVATE_KEY="${STATE_ROOT}/identity/node.key"

WORK="$(mktemp -d /tmp/orcasynapse-desired-state.XXXXXX)"
trap 'rm -rf -- "${WORK}"' EXIT

sign_request() {
  local timestamp="$1" nonce="$2" body="$3" body_digest
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}" > "${WORK}/message"
  openssl pkeyutl -sign -rawin -inkey "${PRIVATE_KEY}" -in "${WORK}/message" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '='
}

timestamp="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
nonce="$(cat /proc/sys/kernel/random/uuid)"
# A GET carries no body; the control plane checksums the literal JSON null.
signature="$(sign_request "${timestamp}" "${nonce}" 'null')"

http_status="$(curl --silent --show-error --max-time 20 \
  --output "${WORK}/response.json" --write-out '%{http_code}' \
  -H "X-OrcaSynapse-Node-Timestamp: ${timestamp}" \
  -H "X-OrcaSynapse-Node-Nonce: ${nonce}" \
  -H "X-OrcaSynapse-Node-Signature: ${signature}" \
  "${CONTROL_PLANE_URL}/api/v1/runtime-nodes/${NODE_ID}/desired-state")" || exit 0

# A control plane that does not serve desired state yet is not an error.
[[ "${http_status}" == "200" ]] || exit 0

jq -r '.documentBase64' "${WORK}/response.json" | base64 -d > "${WORK}/document.json"
jq -r '.signature' "${WORK}/response.json" | base64 -d > "${WORK}/document.sig"

openssl pkeyutl -verify -pubin -inkey "${CONTROL_PLANE_KEY}" -rawin \
  -in "${WORK}/document.json" -sigfile "${WORK}/document.sig" >/dev/null 2>&1 \
  || { echo "orcasynapse: desired-state signature did not verify; nothing applied" >&2; exit 1; }

# The signature proves the control plane wrote it; this proves it wrote it for
# this node, so a document meant for another runtime cannot be replayed here.
document_node="$(jq -r '.nodeId // empty' "${WORK}/document.json")"
[[ "${document_node}" == "${NODE_ID}" ]] \
  || { echo "orcasynapse: desired state addressed to another node; nothing applied" >&2; exit 1; }

[[ "$(jq -r '.format // empty' "${WORK}/document.json")" == "orcasynapse-runtime-desired-state/v1" ]] \
  || { echo "orcasynapse: unrecognized desired-state format; nothing applied" >&2; exit 1; }

# Admitted names drive two settings, because one is not enough.
#
# `platform_toolsets` allowlists this platform, and `no_mcp` suppresses MCP
# servers — but a toolset enabled globally still runs regardless of both.
# Verified on the pilot: admitting `clarify` alone left `bfl` enabled too, which
# the control plane then correctly refused as drift. `agent.disabled_toolsets`
# is subtracted after every other rule, so naming everything unadmitted there is
# what actually produces the admitted set and nothing else.
KEY="$(sed -n 's/^API_SERVER_KEY=//p' "${STATE_ROOT}/data/.env" 2>/dev/null || true)"
curl -s -m 10 -H "Authorization: Bearer ${KEY}" http://127.0.0.1:8642/v1/toolsets \
  > "${WORK}/catalogue.json" 2>/dev/null || : > "${WORK}/catalogue.json"

python3 - "${MANAGED_CONFIG}" "${WORK}/document.json" "${WORK}/catalogue.json" "${WORK}/config.yaml" <<'RECONCILE'
import json, re, sys

config_path, document_path, catalogue_path, output_path = sys.argv[1:5]
admitted = json.load(open(document_path)).get("admittedToolsets") or []

# The runtime's own catalogue is the only complete list of names. If it is
# unavailable the admitted set still applies; nothing extra can be suppressed
# this pass, and the control plane keeps refusing runs until one succeeds.
try:
    raw = json.load(open(catalogue_path))
    items = raw if isinstance(raw, list) else raw.get("data") or raw.get("toolsets") or []
    every = [t["name"] for t in items if isinstance(t, dict) and t.get("name")]
except Exception:
    every = []

text = open(config_path).read()
# Drop any block a previous pass wrote, so this stays idempotent.
text = re.sub(r"\nagent:\n  disabled_toolsets:\n(?:    - .*\n)*", "\n", text)

allowlist = ["no_mcp"] + admitted
text = re.sub(
    r"(platform_toolsets:\n  api_server:\n)(?:    - .*\n)+",
    lambda m: m.group(1) + "".join(f"    - {name}\n" for name in allowlist),
    text,
    count=1,
)

disabled = [name for name in every if name not in admitted]
if disabled:
    block = "agent:\n  disabled_toolsets:\n" + "".join(f"    - {name}\n" for name in disabled)
    text = text.rstrip("\n") + "\n" + block

open(output_path, "w").write(text)
RECONCILE

if cmp -s "${WORK}/config.yaml" "${MANAGED_CONFIG}"; then
  exit 0
fi

install -m 0644 -o root -g root "${WORK}/config.yaml" "${MANAGED_CONFIG}"
echo "orcasynapse: applied toolset allowlist ($(jq -r '.admittedToolsets | length' "${WORK}/document.json") admitted); restarting Hermes" >&2
docker restart "${CONTAINER_NAME}" >/dev/null
DESIREDSTATE

  write_file_from_stdin 0644 root root "/etc/systemd/system/${DESIRED_STATE_SERVICE}.service" <<EOF
[Unit]
Description=Apply the OrcaSynapse toolset allowlist to the Hermes runtime
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/lib/orcasynapse/hermes-desired-state.sh
EOF

  write_file_from_stdin 0644 root root "/etc/systemd/system/${DESIRED_STATE_SERVICE}.timer" <<EOF
[Unit]
Description=Reconcile the OrcaSynapse toolset allowlist every five minutes

[Timer]
OnBootSec=90s
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${DESIRED_STATE_SERVICE}.timer" >/dev/null
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

# Agent memory is served by OrcaSynapse from its own pgvector plane, so this
# node runs exactly one plane: the Hermes runtime. Its API port answering is
# the whole of what this host can attest to.
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
  local node_id token control_plane_url hermes_base_url hermes_image hostname_value public_key api_key
  local node_fingerprint private_fingerprint retained_fingerprint enrolled_fingerprint
  if [[ -s "${ENROLLMENT_STATE}" ]]; then
    validate_resume_state "${ENROLLMENT_STATE}" || fail "the protected enrollment recovery state is invalid"
    resuming=1
    node_id="$(jq -r '.nodeId' "${ENROLLMENT_STATE}")"
    control_plane_url="$(jq -r '.controlPlaneUrl' "${ENROLLMENT_STATE}" | sed 's:/*$::')"
    hermes_base_url="$(jq -r '.hermesBaseUrl' "${ENROLLMENT_STATE}" | sed 's:/*$::')"
    hermes_image="$(jq -r '.hermesImage' "${ENROLLMENT_STATE}")"
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
    # Absent on a control plane that predates the pinned-signing-key field. A
    # node with no pinned key applies no desired state rather than trusting an
    # unsigned document.
    control_plane_key="$(jq -r '.controlPlanePublicKeyPem // empty' "${response_file}")"
    desired_state_path="$(jq -r '.desiredStatePath // empty' "${response_file}")"
    enrolled_fingerprint="$(jq -r '.node.identityFingerprint // empty' "${response_file}")"
    [[ "${enrolled_fingerprint}" == "${node_fingerprint}" ]] \
      || fail "OrcaSynapse enrolled identity '${enrolled_fingerprint:-missing}' instead of the VM2 identity '${node_fingerprint}'"
    jq -n \
      --arg nodeId "${node_id}" --arg controlPlaneUrl "${control_plane_url}" \
      --arg hermesBaseUrl "${hermes_base_url}" --arg hermesImage "${hermes_image}" \
      --arg hostname "${hostname_value}" --arg apiKey "${api_key}" \
      --arg identityFingerprint "${node_fingerprint}" \
      --arg controlPlanePublicKeyPem "${control_plane_key}" \
      --arg desiredStatePath "${desired_state_path}" \
      --argjson modelBootstrap "$(jq -c '.modelBootstrap' "${response_file}")" \
      '{format:"orcasynapse-hermes-resume/v1",nodeId:$nodeId,controlPlaneUrl:$controlPlaneUrl,hermesBaseUrl:$hermesBaseUrl,hermesImage:$hermesImage,hostname:$hostname,apiKey:$apiKey,identityFingerprint:$identityFingerprint,controlPlanePublicKeyPem:$controlPlanePublicKeyPem,desiredStatePath:$desiredStatePath,modelBootstrap:$modelBootstrap}' \
      > "${resume_file}"
    install -m 0600 -o root -g root "${resume_file}" "${ENROLLMENT_STATE}"
    success "Node enrolled; protected recovery state was saved before continuing."
  fi

  verify_enrolled_identity "${node_id}" "${control_plane_url}" "${hermes_image}" "${node_fingerprint}"
  success "VM1 accepted the signed VM2 trust handshake."

  step 6 7 "Apply the managed runtime policy"
  install_hermes_directory 0750 "${STATE_ROOT}/data"
  write_hermes_managed_policy "${model_alias_json}" "${model_base_url_json}"
  install_hermes_file_from_stdin 0600 "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
OPENAI_BASE_URL=${model_base_url}
OPENAI_API_KEY=${model_api_key}
EOF
  run_with_progress "Apply the managed runtime policy" docker restart "${CONTAINER_NAME}" \
    || fail "Hermes could not restart with its managed policy"
  run_with_progress "Verify governed runtime recovery" wait_for_hermes 0 \
    || fail "Hermes did not recover after applying the OrcaSynapse-managed inference route"

  step 7 7 "Enable monitoring"
  printf '%s' "${node_id}" > "${STATE_ROOT}/node-id"
  printf '%s' "${control_plane_url}" > "${STATE_ROOT}/control-plane-url"
  printf '%s' "${hermes_base_url}" > "${STATE_ROOT}/hermes-base-url"
  printf '%s' "${hermes_image}" > "${STATE_ROOT}/image-reference"
  if [[ -n "${control_plane_key}" ]]; then
    printf '%s' "${control_plane_key}" > "${STATE_ROOT}/control-plane-key.pem"
    chmod 0644 "${STATE_ROOT}/control-plane-key.pem"
  fi
  chmod 0600 "${STATE_ROOT}/node-id" "${STATE_ROOT}/control-plane-url" "${STATE_ROOT}/hermes-base-url" "${STATE_ROOT}/image-reference"

  write_heartbeat_client
  write_desired_state_client
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
