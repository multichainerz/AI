#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

AIHUB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
AIHUB_HTTP_PORT="${AIHUB_HTTP_PORT:-8080}"
AIHUB_CLAIM_TTL_MINUTES="${AIHUB_CLAIM_TTL_MINUTES:-30}"
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
  [[ "${AIHUB_CLAIM_TTL_MINUTES}" =~ ^[0-9]+$ ]] && (( AIHUB_CLAIM_TTL_MINUTES >= 10 && AIHUB_CLAIM_TTL_MINUTES <= 1440 )) \
    || fail "AIHUB_CLAIM_TTL_MINUTES must be between 10 and 1440"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
}

secret_file() {
  printf '%s/%s' "${AIHUB_SECRET_DIR}" "$1"
}

all_secrets_exist() {
  local name
  for name in postgres_password aihub_database_url aihub_master_key aihub_bootstrap_token aihub_installation_claim_expires_at; do
    [[ -s "$(secret_file "${name}")" ]] || return 1
  done
}

any_secret_exists() {
  local name
  for name in postgres_password aihub_database_url aihub_master_key aihub_bootstrap_token aihub_installation_claim_expires_at; do
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

  local postgres_password master_key installation_claim claim_expiry
  postgres_password="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
  master_key="$(openssl rand -base64 32 | tr -d '\n')"
  installation_claim="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
  claim_expiry="$(date --utc --date="+${AIHUB_CLAIM_TTL_MINUTES} minutes" '+%Y-%m-%dT%H:%M:%SZ')"

  write_secret postgres_password "${postgres_password}"
  write_secret aihub_database_url "postgresql://aihub:${postgres_password}@postgres:5432/aihub"
  write_secret aihub_master_key "${master_key}"
  write_secret aihub_bootstrap_token "${installation_claim}"
  write_secret aihub_installation_claim_expires_at "${claim_expiry}"
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

installation_claim_state() {
  local claim_expiry="$1"
  local database_state expiry_epoch now_epoch
  database_state="$(docker compose exec -T postgres psql --username aihub --dbname aihub --tuples-only --no-align --command \
    'SELECT CASE WHEN "redeemedAt" IS NOT NULL THEN '\''CONSUMED'\'' WHEN "expiresAt" IS NOT NULL AND "expiresAt" <= CURRENT_TIMESTAMP THEN '\''EXPIRED'\'' ELSE '\''VALID'\'' END FROM "InstallationClaim" WHERE "id" = '\''initial'\'';' \
    | tr -d '[:space:]')"
  if [[ "${database_state}" == "CONSUMED" || "${database_state}" == "EXPIRED" ]]; then
    printf '%s' "${database_state}"
    return
  fi
  expiry_epoch="$(date --date="${claim_expiry}" '+%s')" || fail "the stored installation claim expiry is invalid"
  now_epoch="$(date '+%s')"
  if (( expiry_epoch <= now_epoch )); then
    printf 'EXPIRED'
  else
    printf 'VALID'
  fi
}

main() {
  require_root
  install_host_dependencies
  validate_inputs
  cd "${AIHUB_ROOT}"

  if all_secrets_exist; then
    printf 'AIHub bootstrap material already exists; preserving it.\n'
  else
    printf 'Building the pinned AIHub release before creating the short-lived installation claim...\n'
    docker compose build
    generate_secrets
  fi

  docker compose up -d --no-build
  wait_for_aihub

  local host_ip claim_expiry claim_state
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-127.0.0.1}"
  claim_expiry="$(<"$(secret_file aihub_installation_claim_expires_at)")"
  claim_state="$(installation_claim_state "${claim_expiry}")"

  printf '\nAIHub is ready at http://%s:%s/\n' "${host_ip}" "${AIHUB_HTTP_PORT}"
  if [[ "${claim_state}" == "VALID" ]]; then
    local claim
    claim="$(<"$(secret_file aihub_bootstrap_token)")"
    printf 'Single-use installation claim (expires %s):\n\n%s\n\n' "${claim_expiry}" "${claim}"
    printf 'Open the dashboard now, claim the installation, and export/verify the encrypted recovery kit before production activation.\n'
    printf 'This host retains bootstrap files with root-only permissions; the claim cannot be redeemed twice.\n'
  elif [[ "${claim_state}" == "CONSUMED" ]]; then
    printf 'The installation is already claimed. No bootstrap credential was displayed. Sign in through the configured administrator identity.\n'
  else
    printf 'The stored installation claim has expired and was not displayed. Issue a replacement with the audited root break-glass command.\n'
  fi
}

main "$@"
