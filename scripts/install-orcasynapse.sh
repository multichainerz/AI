#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HTTP_PORT:-8080}"
ORCASYNAPSE_SECRET_DIR="${ORCASYNAPSE_ROOT}/.local/secrets"
export ORCASYNAPSE_HTTP_PORT

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != "dumb" ]]; then
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
  printf '%b' "${UI_BLUE}${UI_BOLD}"
  cat <<'EOF'

       __
  ____/ /_________ ____
 / __  / ___/ ___/ __ \       ORCASYNAPSE
/ /_/ / /  / /__/ /_/ /       Private AI. Governed locally.
\__,_/_/   \___/\____/

EOF
  printf '%b\n' "${UI_RESET}${UI_DIM}  Secure control-plane installer  |  PostgreSQL  |  Docker Compose${UI_RESET}"
}

step() {
  printf '\n%b[%s/%s]%b %b%s%b\n' \
    "${UI_CYAN}${UI_BOLD}" "$1" "$2" "${UI_RESET}" "${UI_BOLD}" "$3" "${UI_RESET}"
}

info() {
  printf '      %b>%b %s\n' "${UI_BLUE}" "${UI_RESET}" "$1"
}

success() {
  printf '      %bOK%b %s\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}" "$1"
}

warning() {
  printf '      %b!%b %s\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" "$1" >&2
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

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl docker.io
  if ! apt-get install -y docker-compose-v2; then
    apt-get install -y docker-compose-plugin
  fi
  systemctl enable --now docker
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
    [[ -s "$(secret_file "${name}")" ]] || return 1
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
  if docker compose up -d --no-build; then
    success "Application services started."
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
    printf '\n%bORCASYNAPSE HOST PROVISIONING%b\n' "${UI_BLUE}${UI_BOLD}" "${UI_RESET}"
  fi

  step 1 5 "Validate the host"
  require_root
  install_host_dependencies
  validate_inputs
  success "Docker Compose and host dependencies are ready."
  cd "${ORCASYNAPSE_ROOT}"
  migrate_legacy_installation_secret

  step 2 5 "Build the pinned release"
  info "Building application images locally."
  docker compose build
  success "Application images built."

  step 3 5 "Protect installation secrets"
  if all_secrets_exist; then
    success "Existing bootstrap material found and preserved."
  else
    generate_secrets
    success "Database and recovery secrets generated with root-only permissions."
  fi

  step 4 5 "Migrate PostgreSQL and start services"
  start_stack
  wait_for_orcasynapse
  success "Readiness checks passed."

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
}

main "$@"
