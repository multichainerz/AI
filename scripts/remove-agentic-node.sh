#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

STATE_ROOT="/var/lib/orcasynapse-hermes"
SUPERMEMORY_ROOT="/var/lib/orcasynapse-supermemory"
CONTAINER_NAME="orcasynapse-hermes"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
SUPERMEMORY_SERVICE="orcasynapse-supermemory"
SUPERMEMORY_USER="orcasynapse-supermemory"
HEARTBEAT_CLIENT="/usr/local/lib/orcasynapse/hermes-heartbeat.sh"

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

banner() {
  printf '%b' "${UI_RED}${UI_BOLD}"
  cat <<'EOF'

     ____                _____
    / __ \___________ _ / ___/__  ______  ____ _____  ________
   / / / / ___/ ___/  '/\__ \/ / / / __ \/ __ `/ __ \/ ___/ _ \
  / /_/ / /  / /__/ /| |__/ / /_/ / / / / /_/ / /_/ (__  )  __/
  \____/_/   \___/_/ |_/____/\__, /_/ /_/\__,_/ .___/____/\___/
                             /____/            /_/

EOF
  printf '%b\n' "${UI_RESET}${UI_DIM}  AGENTIC SYSTEM  /  VM2 SECURE DECOMMISSION${UI_RESET}"
  printf '%b\n' "${UI_DIM}  ----------------------------------------------------------------------${UI_RESET}"
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

success() { printf '  %b[ OK ]%b %s\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}" "$1"; }
warning() { printf '  %b[WARN]%b %s\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" "$1" >&2; }
fail() { printf '\n%bERROR%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "$1" >&2; exit 1; }

require_safe_host() {
  [[ "${EUID}" -eq 0 ]] || fail "run the decommissioner as root"
  [[ -r /etc/os-release ]] || fail "this host does not expose operating-system identity"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "the managed Agentic System remover supports Ubuntu VM2 hosts only"
  [[ -d /run/systemd/system ]] || fail "systemd is not active on this host"
  [[ "${STATE_ROOT}" == "/var/lib/orcasynapse-hermes" ]] || fail "unsafe Hermes state path"
  [[ "${SUPERMEMORY_ROOT}" == "/var/lib/orcasynapse-supermemory" ]] || fail "unsafe Supermemory state path"
  [[ ! -L "${STATE_ROOT}" && ! -L "${SUPERMEMORY_ROOT}" ]] || fail "refusing to traverse a symbolic-link state root"
}

managed_install_exists() {
  [[ -e "${STATE_ROOT}" || -e "${SUPERMEMORY_ROOT}" \
    || -e "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" \
    || -e "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" \
    || -e "/etc/systemd/system/${SUPERMEMORY_SERVICE}.service" \
    || -e "${HEARTBEAT_CLIENT}" ]] && return 0
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
    - Supermemory service, model cache, API key, and durable memory data
    - Node identity, enrollment state, managed policy, and runtime data
    - Signed-heartbeat services and the dedicated Supermemory service account

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
  systemctl disable --now "${SUPERMEMORY_SERVICE}.service" >/dev/null 2>&1 || true
  success "Managed heartbeat and memory services stopped."
}

remove_hermes_runtime() {
  local image_reference=""
  if command -v docker >/dev/null 2>&1 && docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    if [[ -s "${STATE_ROOT}/image-reference" ]]; then
      image_reference="$(<"${STATE_ROOT}/image-reference")"
    else
      image_reference="$(docker inspect --format '{{.Image}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
    fi
    docker rm -f "${CONTAINER_NAME}" >/dev/null
    success "Hermes container removed."
  else
    success "No managed Hermes container remains."
  fi

  if [[ -n "${image_reference}" ]]; then
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
    "/etc/systemd/system/${SUPERMEMORY_SERVICE}.service" \
    "${HEARTBEAT_CLIENT}"
  systemctl daemon-reload
  systemctl reset-failed "${HEARTBEAT_SERVICE}.service" "${SUPERMEMORY_SERVICE}.service" >/dev/null 2>&1 || true

  rm -rf --one-file-system -- "${STATE_ROOT}" "${SUPERMEMORY_ROOT}"
  [[ ! -e "${STATE_ROOT}" && ! -e "${SUPERMEMORY_ROOT}" ]] \
    || fail "a managed state root could not be removed; check for a mounted filesystem and rerun"
  rmdir /usr/local/lib/orcasynapse >/dev/null 2>&1 || true
  if getent passwd "${SUPERMEMORY_USER}" >/dev/null 2>&1; then
    userdel "${SUPERMEMORY_USER}" >/dev/null
  fi
  success "Identity keys, runtime state, memory data, units, and service account removed."
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

  printf '\n%b+======================================================================+%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  printf '%b|  %-68s|%b\n' "${UI_GREEN}${UI_BOLD}" "AGENTIC SYSTEM REMOVED FROM THIS VM" "${UI_RESET}"
  printf '%b+======================================================================+%b\n\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  warning "This host can no longer authenticate to OrcaSynapse. Remove the revoked node from the dashboard to finish control-plane cleanup."
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
