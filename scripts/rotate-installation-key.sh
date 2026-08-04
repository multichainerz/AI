#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HTTP_PORT:-8080}"
ORCASYNAPSE_SECRET_DIR="${ORCASYNAPSE_ROOT}/.local/secrets"
ORCASYNAPSE_APPLICATION_SECRET_GID=1000
export ORCASYNAPSE_HTTP_PORT

# shellcheck source=lib/installer-ui.sh
. "${ORCASYNAPSE_ROOT}/scripts/lib/installer-ui.sh"

UI_ACCENT="${UI_AMBER}"
UI_BANNER_TAGLINE="PRIVATE AI CONTROL PLANE  /  INSTALLATION-KEY ROTATION"
UI_BANNER_META="Release $(installer_release_version)"

trap 'ui_show_cursor' EXIT

banner

[[ "${EUID}" -eq 0 ]] || fail "run this break-glass command as root"
[[ "${1:-}" == "--confirm-revoke-recovery-sessions" || "${1:-}" == "--confirm-revoke-local-sessions" ]] \
  || fail "explicit confirmation is required: sudo ./scripts/rotate-installation-key.sh --confirm-revoke-recovery-sessions"
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

for secret in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
  [[ -s "${ORCASYNAPSE_SECRET_DIR}/${secret}" ]] || fail "the protected OrcaSynapse secret set is incomplete"
done

cd "${ORCASYNAPSE_ROOT}"
new_key="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
key_tmp="$(mktemp "${ORCASYNAPSE_SECRET_DIR}/.installation-key.XXXXXX")"
trap 'rm -f -- "${key_tmp:-}"; ui_show_cursor' EXIT
printf '%s' "${new_key}" > "${key_tmp}"
chown "root:${ORCASYNAPSE_APPLICATION_SECRET_GID}" "${key_tmp}"
chmod 0640 "${key_tmp}"

run_with_progress "Stop the control-plane API" docker compose stop api \
  || fail "could not stop the control-plane API"
mv -f -- "${key_tmp}" "${ORCASYNAPSE_SECRET_DIR}/orcasynapse_installation_key"
trap 'ui_show_cursor' EXIT
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U orcasynapse -d orcasynapse \
  -c "UPDATE \"AdministratorSession\" SET \"revokedAt\" = CURRENT_TIMESTAMP WHERE \"authenticationMethod\" = 'INSTALLATION_KEY_RECOVERY' AND \"revokedAt\" IS NULL" \
  >/dev/null
success "Existing Installation-Key recovery sessions were revoked."
run_with_progress "Restart the control plane with the rotated key" \
  docker compose up -d --no-build --force-recreate api web \
  || fail "could not restart the control plane"

wait_for_readiness() {
  local deadline=$((SECONDS + 180))
  until curl --fail --silent "http://127.0.0.1:${ORCASYNAPSE_HTTP_PORT}/readyz" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}
run_with_progress "Wait for control-plane readiness" wait_for_readiness \
  || fail "OrcaSynapse did not become ready after key rotation; inspect docker compose logs"

ui_panel_begin "${UI_AMBER}" "INSTALLATION KEY ROTATED"
ui_panel_line 'New offline recovery Installation Key'
ui_panel_line "${new_key}"
ui_panel_end "${UI_AMBER}"
warning "Store the new key in your organization password vault now; the previous key no longer works."
info "Local-password and federated OIDC administrator sessions were not revoked."
