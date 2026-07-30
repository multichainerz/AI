#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

AIHUB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
AIHUB_HTTP_PORT="${AIHUB_HTTP_PORT:-8080}"
AIHUB_CLAIM_TTL_MINUTES="${AIHUB_CLAIM_TTL_MINUTES:-30}"
AIHUB_SECRET_DIR="${AIHUB_ROOT}/.local/secrets"
export AIHUB_HTTP_PORT

fail() {
  printf 'AIHub recovery error: %s\n' "$1" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run this break-glass command as root"
[[ "${1:-}" == "--confirm-revoke-bootstrap-sessions" ]] \
  || fail "explicit confirmation is required: sudo ./scripts/issue-installation-claim.sh --confirm-revoke-bootstrap-sessions"
[[ "${AIHUB_CLAIM_TTL_MINUTES}" =~ ^[0-9]+$ ]] && (( AIHUB_CLAIM_TTL_MINUTES >= 10 && AIHUB_CLAIM_TTL_MINUTES <= 1440 )) \
  || fail "AIHUB_CLAIM_TTL_MINUTES must be between 10 and 1440"
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

for secret in postgres_password aihub_database_url aihub_master_key aihub_bootstrap_token aihub_installation_claim_expires_at; do
  [[ -s "${AIHUB_SECRET_DIR}/${secret}" ]] || fail "the protected AIHub secret set is incomplete"
done

cd "${AIHUB_ROOT}"
docker compose up -d postgres
postgres_deadline=$((SECONDS + 120))
until docker compose exec -T postgres pg_isready --username aihub --dbname aihub >/dev/null 2>&1; do
  (( SECONDS < postgres_deadline )) || fail "PostgreSQL did not become ready"
  sleep 2
done

new_claim="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
new_expiry="$(date --utc --date="+${AIHUB_CLAIM_TTL_MINUTES} minutes" '+%Y-%m-%dT%H:%M:%SZ')"
claim_tmp="$(mktemp "${AIHUB_SECRET_DIR}/.installation-claim.XXXXXX")"
expiry_tmp="$(mktemp "${AIHUB_SECRET_DIR}/.installation-expiry.XXXXXX")"
trap 'rm -f -- "${claim_tmp:-}" "${expiry_tmp:-}"' EXIT
printf '%s' "${new_claim}" > "${claim_tmp}"
printf '%s' "${new_expiry}" > "${expiry_tmp}"
chmod 0600 "${claim_tmp}" "${expiry_tmp}"

docker compose stop api
docker compose exec -T postgres psql --username aihub --dbname aihub --set ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM "InstallationClaim" WHERE "id" = 'initial';
UPDATE "AdministratorSession"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "subject" = 'bootstrap-administrator' AND "revokedAt" IS NULL;
INSERT INTO "AuditEvent" (
  "id", "actorType", "action", "resourceType", "resourceId", "outcome", "metadata"
) VALUES (
  gen_random_uuid(), 'SYSTEM', 'installation.recovery_claim_issued',
  'InstallationClaim', 'initial', 'SUCCESS', '{"authority":"local-root-break-glass"}'::jsonb
);
COMMIT;
SQL

mv -f -- "${claim_tmp}" "${AIHUB_SECRET_DIR}/aihub_bootstrap_token"
mv -f -- "${expiry_tmp}" "${AIHUB_SECRET_DIR}/aihub_installation_claim_expires_at"
trap - EXIT
docker compose up -d --no-build --force-recreate api web

deadline=$((SECONDS + 180))
until curl --fail --silent "http://127.0.0.1:${AIHUB_HTTP_PORT}/readyz" >/dev/null 2>&1; do
  (( SECONDS < deadline )) || fail "AIHub did not become ready after claim recovery; inspect docker compose logs"
  sleep 2
done

printf '\nA replacement single-use installation claim was issued. Existing bootstrap-administrator sessions were revoked.\n'
printf 'Claim (expires %s):\n\n%s\n\n' "${new_expiry}" "${new_claim}"
printf 'Use it immediately, then retain the root-authority audit evidence. Federated OIDC administrator sessions were not revoked.\n'
