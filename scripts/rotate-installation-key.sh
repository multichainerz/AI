#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

AIHUB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
AIHUB_HTTP_PORT="${AIHUB_HTTP_PORT:-8080}"
AIHUB_SECRET_DIR="${AIHUB_ROOT}/.local/secrets"
export AIHUB_HTTP_PORT

fail() {
  printf 'AIHub key rotation error: %s\n' "$1" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run this break-glass command as root"
[[ "${1:-}" == "--confirm-revoke-recovery-sessions" || "${1:-}" == "--confirm-revoke-local-sessions" ]] \
  || fail "explicit confirmation is required: sudo ./scripts/rotate-installation-key.sh --confirm-revoke-recovery-sessions"
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

for secret in postgres_password aihub_database_url aihub_master_key aihub_installation_key; do
  [[ -s "${AIHUB_SECRET_DIR}/${secret}" ]] || fail "the protected AIHub secret set is incomplete"
done

cd "${AIHUB_ROOT}"
new_key="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
key_tmp="$(mktemp "${AIHUB_SECRET_DIR}/.installation-key.XXXXXX")"
trap 'rm -f -- "${key_tmp:-}"' EXIT
printf '%s' "${new_key}" > "${key_tmp}"
chmod 0600 "${key_tmp}"

docker compose stop api
mv -f -- "${key_tmp}" "${AIHUB_SECRET_DIR}/aihub_installation_key"
trap - EXIT
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U aihub -d aihub \
  -c "UPDATE \"AdministratorSession\" SET \"revokedAt\" = CURRENT_TIMESTAMP WHERE \"authenticationMethod\" = 'INSTALLATION_KEY_RECOVERY' AND \"revokedAt\" IS NULL" \
  >/dev/null
docker compose up -d --no-build --force-recreate api web

deadline=$((SECONDS + 180))
until curl --fail --silent "http://127.0.0.1:${AIHUB_HTTP_PORT}/readyz" >/dev/null 2>&1; do
  (( SECONDS < deadline )) || fail "AIHub did not become ready after key rotation; inspect docker compose logs"
  sleep 2
done

printf '\nThe offline Installation Key was rotated and existing recovery sessions were revoked.\n'
printf 'New offline recovery Installation Key:\n\n%s\n\n' "${new_key}"
printf 'Store it in your organization password vault now. Local-password and federated OIDC administrator sessions were not revoked.\n'
