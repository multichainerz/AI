#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

INSTALLER_VERSION="ai-v1.57.0"
# Honor the same state-root overrides the installer accepts, so a non-default
# layout installed with ORCASYNAPSE_*_STATE_ROOT can be removed the same way.
STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTAINER_NAME="orcasynapse-hermes"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
HEARTBEAT_CLIENT="/usr/local/lib/orcasynapse/hermes-heartbeat.sh"
DESIRED_STATE_SERVICE="orcasynapse-hermes-desired-state"
DESIRED_STATE_CLIENT="/usr/local/lib/orcasynapse/hermes-desired-state.sh"

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

UI_ACCENT="${UI_RED}"
UI_BANNER_TAGLINE="AGENTIC SYSTEM  /  VM2 SECURE DECOMMISSION"
UI_BANNER_META="Remover ${INSTALLER_VERSION}"

validate_state_root() {
  local label="$1" path="$2"
  [[ "${path}" == /*/* && "${path}" != *..* ]] \
    || fail "unsafe ${label} state path '${path}'; an absolute path at least two levels deep is required"
  [[ ! -L "${path}" ]] || fail "refusing to traverse a symbolic-link ${label} state root"
}

require_safe_host() {
  [[ "${EUID}" -eq 0 ]] || fail "run the decommissioner as root"
  [[ -r /etc/os-release ]] || fail "this host does not expose operating-system identity"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "the managed Agentic System remover supports Ubuntu VM2 hosts only"
  [[ -d /run/systemd/system ]] || fail "systemd is not active on this host"
  validate_state_root "Hermes" "${STATE_ROOT}"
  if [[ "${STATE_ROOT}" != "/var/lib/orcasynapse-hermes" ]]; then
    warning "Removing a non-default state layout: ${STATE_ROOT}"
  fi
}

managed_install_exists() {
  [[ -e "${STATE_ROOT}" \
    || -e "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" \
    || -e "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" \
    || -e "/etc/systemd/system/${DESIRED_STATE_SERVICE}.service" \
    || -e "/etc/systemd/system/${DESIRED_STATE_SERVICE}.timer" \
    || -e "${HEARTBEAT_CLIENT}" \
    || -e "${DESIRED_STATE_CLIENT}" ]] && return 0
  command -v docker >/dev/null 2>&1 && docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1
}

validate_container_ownership() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 \
    || fail "the Docker daemon is unavailable; start it so the managed Hermes container can be verified and removed"
  docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1 || return 0
  local managed_label mounts
  managed_label="$(docker inspect --format '{{index .Config.Labels "io.orcasynapse.managed"}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  mounts="$(docker inspect --format '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  if [[ "${managed_label}" == "true" ]] || grep -Fq "${STATE_ROOT} | /opt/data" <<<"${mounts}"; then
    return 0
  fi
  fail "a container named '${CONTAINER_NAME}' exists but is not identifiable as OrcaSynapse-managed; refusing to remove it"
}

confirm_destruction() {
  cat <<EOF

  ${UI_RED}${UI_BOLD}PERMANENT HOST-SIDE DESTRUCTION${UI_RESET}
  This removes only OrcaSynapse-managed Agentic System resources:

    - Hermes container and its locally cached image when unused elsewhere
    - Node identity, enrollment state, managed policy, and runtime data
    - Signed-heartbeat service and timer
    - Toolset desired-state reconciler service and timer

  Docker itself, Ubuntu packages, unrelated containers, and external backups
  are preserved. Storage snapshots must be retired under your own policy.
EOF
  [[ -r /dev/tty ]] || fail "an interactive terminal is required for destructive confirmation"
  local confirmation
  printf '\n  Type %bDESTROY%b to continue: ' "${UI_RED}${UI_BOLD}" "${UI_RESET}" > /dev/tty
  IFS= read -r confirmation < /dev/tty
  [[ "${confirmation}" == "DESTROY" ]] || fail "decommission cancelled; no resources were changed"
}

stop_managed_services() {
  systemctl disable --now "${HEARTBEAT_SERVICE}.timer" >/dev/null 2>&1 || true
  systemctl stop "${HEARTBEAT_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl disable --now "${DESIRED_STATE_SERVICE}.timer" >/dev/null 2>&1 || true
  systemctl stop "${DESIRED_STATE_SERVICE}.service" >/dev/null 2>&1 || true
  success "Managed heartbeat services stopped."
}

remove_hermes_runtime() {
  local image_reference=""
  # Read the recorded reference first: the image layers should be removed even
  # when the container was already deleted by hand.
  if [[ -s "${STATE_ROOT}/image-reference" ]]; then
    image_reference="$(<"${STATE_ROOT}/image-reference")"
  fi
  if command -v docker >/dev/null 2>&1 && docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    if [[ -z "${image_reference}" ]]; then
      image_reference="$(docker inspect --format '{{.Image}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
    fi
    docker rm -f "${CONTAINER_NAME}" >/dev/null
    success "Hermes container removed."
  else
    success "No managed Hermes container remains."
  fi

  if [[ -n "${image_reference}" ]] && command -v docker >/dev/null 2>&1; then
    if docker image rm "${image_reference}" >/dev/null 2>&1; then
      success "Unused Hermes image layers removed."
    else
      warning "The Hermes image is still used by another container and was preserved."
    fi
  fi
}

remove_managed_state() {
  rm -f -- \
    "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" \
    "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" \
    "/etc/systemd/system/${DESIRED_STATE_SERVICE}.service" \
    "/etc/systemd/system/${DESIRED_STATE_SERVICE}.timer" \
    "${HEARTBEAT_CLIENT}" \
    "${DESIRED_STATE_CLIENT}"
  systemctl daemon-reload
  systemctl reset-failed "${HEARTBEAT_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl reset-failed "${DESIRED_STATE_SERVICE}.service" >/dev/null 2>&1 || true

  rm -rf --one-file-system -- "${STATE_ROOT}"
  [[ ! -e "${STATE_ROOT}" ]] \
    || fail "the managed state root could not be removed; check for a mounted filesystem and rerun"
  rmdir /usr/local/lib/orcasynapse >/dev/null 2>&1 || true
  success "Identity keys, runtime state, managed policy, and units removed."
}

main() {
  [[ "$#" -eq 0 ]] || fail "this command accepts no arguments"
  banner

  step 1 4 "Inventory the managed installation"
  require_safe_host
  validate_container_ownership
  if ! managed_install_exists; then
    success "No OrcaSynapse-managed Agentic System installation was found."
    printf '\n%b  NOTHING TO REMOVE%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
    exit 0
  fi
  success "Managed VM2 resources found; unrelated host resources are outside scope."

  step 2 4 "Authorize irreversible destruction"
  confirm_destruction
  success "Destruction explicitly authorized."

  step 3 4 "Stop and remove Agentic System services"
  stop_managed_services
  remove_hermes_runtime

  step 4 4 "Purge node identity and durable memory"
  remove_managed_state

  ui_panel_begin "${UI_GREEN}" "AGENTIC SYSTEM REMOVED FROM THIS VM"
  ui_panel_kv 'Remover' "${INSTALLER_VERSION}"
  ui_panel_end "${UI_GREEN}"
  warning "This host can no longer authenticate to OrcaSynapse. Remove the revoked node from the dashboard to finish control-plane cleanup."
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
