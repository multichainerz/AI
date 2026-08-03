#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HTTP_PORT:-8080}"
ORCASYNAPSE_SECRET_DIR="${ORCASYNAPSE_ROOT}/.local/secrets"
ORCASYNAPSE_APPLICATION_SECRET_GID=1000
export ORCASYNAPSE_HTTP_PORT

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
  printf '%b\n' "${UI_RESET}${UI_DIM}  PRIVATE AI CONTROL PLANE  /  VM1 PROVISIONING${UI_RESET}"
  printf '%b\n' "${UI_DIM}  ----------------------------------------------------------------------${UI_RESET}"
  if (( UI_INTERACTIVE )); then
    local dots
    printf '  Establishing secure installation context'
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

fail() {
  printf '\n%bERROR%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "$1" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run this release-bundle installer as root (for example: sudo ./scripts/install-orcasynapse.sh)"
  fi
}

install_host_dependencies() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
    && command -v openssl >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    return
  fi

  [[ -r /etc/os-release ]] || fail "automatic dependency installation supports Debian and Ubuntu; install Docker Compose v2, OpenSSL, and curl first"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) fail "automatic dependency installation supports Debian and Ubuntu; install Docker Compose v2, OpenSSL, and curl first" ;;
  esac

  run_with_progress "Refresh operating-system packages" apt-get update \
    || fail "could not refresh operating-system packages"
  run_with_progress "Install Docker and security dependencies" env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y ca-certificates curl openssl docker.io \
    || fail "could not install Docker and security dependencies"
  if ! run_with_progress "Install Docker Compose v2" apt-get install -y docker-compose-v2; then
    run_with_progress "Install Docker Compose plugin" apt-get install -y docker-compose-plugin \
      || fail "could not install Docker Compose v2"
  fi
  run_with_progress "Enable the Docker service" systemctl enable --now docker \
    || fail "could not enable the Docker service"
}

validate_inputs() {
  [[ -f "${ORCASYNAPSE_ROOT}/compose.yaml" ]] || fail "compose.yaml is missing; run this script from an intact OrcaSynapse release bundle"
  [[ "${ORCASYNAPSE_HTTP_PORT}" =~ ^[0-9]+$ ]] && (( ORCASYNAPSE_HTTP_PORT >= 1 && ORCASYNAPSE_HTTP_PORT <= 65535 )) \
    || fail "ORCASYNAPSE_HTTP_PORT must be an integer from 1 through 65535"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
}

secret_file() {
  printf '%s/%s' "${ORCASYNAPSE_SECRET_DIR}" "$1"
}

all_secrets_exist() {
  local name
  for name in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
    [[ -f "$(secret_file "${name}")" && ! -L "$(secret_file "${name}")" && -s "$(secret_file "${name}")" ]] || return 1
  done
}

any_secret_exists() {
  local name
  for name in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
    [[ -e "$(secret_file "${name}")" ]] && return 0
  done
  return 1
}

write_secret() {
  local name="$1"
  local value="$2"
  ( set -o noclobber; printf '%s' "${value}" > "$(secret_file "${name}")" ) \
    || fail "refusing to replace existing secret '${name}'"
  chmod 0600 "$(secret_file "${name}")"
}

protect_secret_files() {
  local name path
  install -d -o root -g root -m 0700 "${ORCASYNAPSE_SECRET_DIR}"

  path="$(secret_file postgres_password)"
  [[ -f "${path}" && ! -L "${path}" ]] || fail "the PostgreSQL secret is not a protected regular file"
  chown root:root "${path}"
  chmod 0600 "${path}"

  for name in orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
    path="$(secret_file "${name}")"
    [[ -f "${path}" && ! -L "${path}" ]] || fail "application secret '${name}' is not a protected regular file"
    # node:24-bookworm-slim defines the unprivileged node group as GID 1000.
    # The root-only parent directory keeps these files inaccessible to host
    # users, while this group assignment makes the individual Docker secret
    # mounts readable by the non-root API, worker, and migration processes.
    chown "root:${ORCASYNAPSE_APPLICATION_SECRET_GID}" "${path}"
    chmod 0640 "${path}"
  done
}

generate_secrets() {
  any_secret_exists && fail "bootstrap material is incomplete or already exists; restore the complete protected secret set instead of regenerating over it"
  install -d -m 0700 "${ORCASYNAPSE_SECRET_DIR}"

  local postgres_password master_key installation_key
  postgres_password="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
  master_key="$(openssl rand -base64 32 | tr -d '\n')"
  installation_key="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"

  write_secret postgres_password "${postgres_password}"
  write_secret orcasynapse_database_url "postgresql://orcasynapse:${postgres_password}@postgres:5432/orcasynapse"
  write_secret orcasynapse_master_key "${master_key}"
  write_secret orcasynapse_installation_key "${installation_key}"
}

migrate_legacy_installation_secret() {
  local legacy_key legacy_expiry
  legacy_key="$(secret_file orcasynapse_bootstrap_token)"
  legacy_expiry="$(secret_file orcasynapse_installation_claim_expires_at)"
  if [[ ! -s "$(secret_file orcasynapse_installation_key)" && -s "${legacy_key}" ]]; then
    mv -- "${legacy_key}" "$(secret_file orcasynapse_installation_key)"
    chmod 0600 "$(secret_file orcasynapse_installation_key)"
    rm -f -- "${legacy_expiry}"
    success "Migrated the prior bootstrap credential to the permanent Installation Key."
  fi
}

start_stack() {
  if run_with_progress "Start PostgreSQL and application services" docker compose up -d --no-build; then
    return
  fi

  warning "The application stack did not reach its expected start state."
  printf '\n%b--- Service status ---%b\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  docker compose ps -a >&2 || true
  printf '\n%b--- Database migration diagnostics ---%b\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  docker compose logs --no-color --tail 160 migrate >&2 || true
  printf '%b--- End diagnostics ---%b\n\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  fail "startup stopped safely; no data was deleted. After correcting the reported issue, rerun this installer or reproduce the migration with: cd '${ORCASYNAPSE_ROOT}' && docker compose run --rm migrate"
}

wait_for_orcasynapse() {
  local deadline=$((SECONDS + 300))
  until curl --fail --silent --show-error "http://127.0.0.1:${ORCASYNAPSE_HTTP_PORT}/readyz" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      docker compose --project-directory "${ORCASYNAPSE_ROOT}" ps >&2 || true
      fail "OrcaSynapse did not become ready within five minutes; inspect 'docker compose logs'"
    fi
    sleep 2
  done
}

provision_local_administrator() {
  local temporary_password result
  temporary_password="$(openssl rand -base64 24 | tr -d '\n=' | tr '+/' '-_')"
  result="$(printf '%s' "${temporary_password}" \
    | docker compose --project-directory "${ORCASYNAPSE_ROOT}" exec -T api \
      node apps/api/dist/auth/provision-local-admin.js --username admin --display-name 'Local Administrator')" \
    || fail "local administrator provisioning failed"
  if [[ "${result}" == *'"created":true'* ]]; then
    printf '\n%b+----------------------------------------------------------------------+%b\n' "${UI_BLUE}${UI_BOLD}" "${UI_RESET}"
    printf '%b|  %-68s|%b\n' "${UI_BLUE}${UI_BOLD}" "INITIAL LOCAL ADMINISTRATOR" "${UI_RESET}"
    printf '%b+----------------------------------------------------------------------+%b\n' "${UI_BLUE}${UI_BOLD}" "${UI_RESET}"
    printf '|  %-20s %-47s|\n' 'Username' 'admin'
    printf '|  %-20s %-47s|\n' 'Temporary password' "${temporary_password}"
    printf '%b+----------------------------------------------------------------------+%b\n\n' "${UI_BLUE}${UI_BOLD}" "${UI_RESET}"
    warning "Store this password until first login; it must be changed immediately."
  else
    success "The existing local administrator account was preserved."
  fi
}

main() {
  if [[ "${ORCASYNAPSE_BOOTSTRAP_BRANDED:-0}" != "1" ]]; then
    banner
  else
    printf '\n%b  CONTROL PLANE PROVISIONING%b\n' "${UI_BLUE}${UI_BOLD}" "${UI_RESET}"
    printf '%b\n' "${UI_DIM}  ----------------------------------------------------------------------${UI_RESET}"
  fi

  step 1 5 "Validate the host"
  require_root
  install_host_dependencies
  validate_inputs
  success "Docker Compose and host dependencies are ready."
  cd "${ORCASYNAPSE_ROOT}"
  migrate_legacy_installation_secret

  step 2 5 "Build the pinned release"
  run_with_progress "Build verified application images" docker compose build \
    || fail "application image build failed"

  step 3 5 "Protect installation secrets"
  if all_secrets_exist; then
    success "Existing bootstrap material found and preserved."
  else
    generate_secrets
    success "Database and recovery secrets generated."
  fi
  protect_secret_files
  success "Secrets are host-protected and readable only by their intended container identities."

  step 4 5 "Migrate PostgreSQL and start services"
  start_stack
  run_with_progress "Wait for control-plane readiness" wait_for_orcasynapse \
    || fail "control-plane readiness checks failed"

  step 5 5 "Provision administrator access"
  provision_local_administrator

  local host_ip installation_key
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-127.0.0.1}"
  installation_key="$(<"$(secret_file orcasynapse_installation_key)")"

  printf '\n%b+======================================================================+%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  printf '%b|  %-68s|%b\n' "${UI_GREEN}${UI_BOLD}" "ORCASYNAPSE IS READY" "${UI_RESET}"
  printf '%b+======================================================================+%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  printf '|  %-20s %-47s|\n' 'Dashboard' "http://${host_ip}:${ORCASYNAPSE_HTTP_PORT}/"
  printf '|  %-68s|\n' 'Offline recovery Installation Key'
  printf '|  %-68s|\n' "${installation_key}"
  printf '%b+======================================================================+%b\n\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  warning "Store the Installation Key in your organization password vault before closing this terminal."
  info "It is for offline local-account recovery, does not expire, and is not the routine dashboard login."
  info "Export and verify the encrypted recovery kit before production activation."
  printf '\n%b  NEXT%b  Open the dashboard, change the temporary password, then connect AI Inference.\n' \
    "${UI_CYAN}${UI_BOLD}" "${UI_RESET}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
