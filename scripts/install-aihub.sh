#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

AIHUB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
AIHUB_HTTP_PORT="${AIHUB_HTTP_PORT:-8080}"
AIHUB_SECRET_DIR="${AIHUB_ROOT}/.local/secrets"
export AIHUB_HTTP_PORT

fail() {
  printf 'AIHub installer error: %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run this release-bundle installer as root (for example: sudo ./scripts/install-aihub.sh)"
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
  [[ -f "${AIHUB_ROOT}/compose.yaml" ]] || fail "compose.yaml is missing; run this script from an intact AIHub release bundle"
  [[ "${AIHUB_HTTP_PORT}" =~ ^[0-9]+$ ]] && (( AIHUB_HTTP_PORT >= 1 && AIHUB_HTTP_PORT <= 65535 )) \
    || fail "AIHUB_HTTP_PORT must be an integer from 1 through 65535"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
}

secret_file() {
  printf '%s/%s' "${AIHUB_SECRET_DIR}" "$1"
}

all_secrets_exist() {
  local name
  for name in postgres_password aihub_database_url aihub_master_key aihub_installation_key; do
    [[ -s "$(secret_file "${name}")" ]] || return 1
  done
}

any_secret_exists() {
  local name
  for name in postgres_password aihub_database_url aihub_master_key aihub_installation_key; do
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
  install -d -m 0700 "${AIHUB_SECRET_DIR}"

  local postgres_password master_key installation_key
  postgres_password="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
  master_key="$(openssl rand -base64 32 | tr -d '\n')"
  installation_key="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"

  write_secret postgres_password "${postgres_password}"
  write_secret aihub_database_url "postgresql://aihub:${postgres_password}@postgres:5432/aihub"
  write_secret aihub_master_key "${master_key}"
  write_secret aihub_installation_key "${installation_key}"
}

migrate_legacy_installation_secret() {
  local legacy_key legacy_expiry
  legacy_key="$(secret_file aihub_bootstrap_token)"
  legacy_expiry="$(secret_file aihub_installation_claim_expires_at)"
  if [[ ! -s "$(secret_file aihub_installation_key)" && -s "${legacy_key}" ]]; then
    mv -- "${legacy_key}" "$(secret_file aihub_installation_key)"
    chmod 0600 "$(secret_file aihub_installation_key)"
    rm -f -- "${legacy_expiry}"
    printf 'Migrated the prior protected bootstrap credential to the permanent Installation Key.\n'
  fi
}

wait_for_aihub() {
  local deadline=$((SECONDS + 300))
  until curl --fail --silent --show-error "http://127.0.0.1:${AIHUB_HTTP_PORT}/readyz" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      docker compose --project-directory "${AIHUB_ROOT}" ps >&2 || true
      fail "AIHub did not become ready within five minutes; inspect 'docker compose logs'"
    fi
    sleep 2
  done
}

main() {
  require_root
  install_host_dependencies
  validate_inputs
  cd "${AIHUB_ROOT}"
  migrate_legacy_installation_secret

  if all_secrets_exist; then
    printf 'AIHub bootstrap material already exists; preserving it.\n'
  else
    printf 'Building the pinned AIHub release before creating protected installation material...\n'
    docker compose build
    generate_secrets
  fi

  docker compose up -d --no-build
  wait_for_aihub

  local host_ip installation_key
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-127.0.0.1}"
  installation_key="$(<"$(secret_file aihub_installation_key)")"

  printf '\nAIHub is ready at http://%s:%s/\n' "${host_ip}" "${AIHUB_HTTP_PORT}"
  printf 'Permanent Installation Key:\n\n%s\n\n' "${installation_key}"
  printf 'Store this key in your organization password vault before closing this terminal. It permanently unlocks local AIHub administration and does not expire.\n'
  printf 'The separate root-owned master key encrypts connector secrets in PostgreSQL and is never accepted by the dashboard. Export and verify the encrypted recovery kit before production activation.\n'
}

main "$@"
