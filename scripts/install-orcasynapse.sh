#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HTTP_PORT:-8080}"
ORCASYNAPSE_SECRET_DIR="${ORCASYNAPSE_ROOT}/.local/secrets"
export ORCASYNAPSE_HTTP_PORT

fail() {
  printf 'OrcaSynapse installer error: %s\n' "$1" >&2
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
    printf 'Migrated the prior protected bootstrap credential to the permanent Installation Key.\n'
  fi
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
    printf '\nInitial local administrator:\n\nUsername: admin\nTemporary password: %s\n\n' "${temporary_password}"
    printf 'Store this temporary password until first login. OrcaSynapse requires it to be changed immediately and does not retain a plaintext copy.\n'
  else
    printf '\nThe existing local administrator account was preserved.\n'
  fi
}

main() {
  require_root
  install_host_dependencies
  validate_inputs
  cd "${ORCASYNAPSE_ROOT}"
  migrate_legacy_installation_secret

  printf 'Building the pinned OrcaSynapse release...\n'
  docker compose build

  if all_secrets_exist; then
    printf 'OrcaSynapse bootstrap material already exists; preserving it.\n'
  else
    generate_secrets
  fi

  docker compose up -d --no-build
  wait_for_orcasynapse
  provision_local_administrator

  local host_ip installation_key
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-127.0.0.1}"
  installation_key="$(<"$(secret_file orcasynapse_installation_key)")"

  printf '\nOrcaSynapse is ready at http://%s:%s/\n' "${host_ip}" "${ORCASYNAPSE_HTTP_PORT}"
  printf 'Offline recovery Installation Key:\n\n%s\n\n' "${installation_key}"
  printf 'Store this key in your organization password vault before closing this terminal. It is only for local-account recovery and does not expire; it is not the routine dashboard login.\n'
  printf 'The separate root-owned master key encrypts connector secrets in PostgreSQL and is never accepted by the dashboard. Export and verify the encrypted recovery kit before production activation.\n'
}

main "$@"
