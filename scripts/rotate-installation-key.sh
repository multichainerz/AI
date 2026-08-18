#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Captured before the default is applied: only a port the caller actually named
# counts as a declaration, and this script's own fallback must not be mistaken
# for one when the recorded value is read back below.
ORCASYNAPSE_HTTP_PORT_DECLARED="${ORCASYNAPSE_HTTP_PORT:+environment}"
ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HTTP_PORT:-8080}"
ORCASYNAPSE_SECRET_DIR="${ORCASYNAPSE_ROOT}/.local/secrets"
ORCASYNAPSE_APPLICATION_SECRET_GID=1000
export ORCASYNAPSE_HTTP_PORT

# shellcheck source=lib/installer-ui.sh
. "${ORCASYNAPSE_ROOT}/scripts/lib/installer-ui.sh"
# This script force-recreates the web container, so it decides the public scheme
# the proxy comes back with. It reads the declaration the install recorded
# instead of re-deriving a default, because the documented invocation is a sudo
# command and an exported variable does not survive one: re-deriving meant a
# correct TLS installation silently lost Secure on every administrator and
# enterprise session cookie the moment somebody rotated the key.
# shellcheck source=lib/public-scheme.sh
. "${ORCASYNAPSE_ROOT}/scripts/lib/public-scheme.sh"
# And the bind address, for the same reason and with the same consequence: this
# recreation re-publishes the web container, so an installation that had been
# bound to loopback came back on every interface if the declaration was not read
# back. The port is read back here too -- it used to re-default to 8080, which
# meant a deployment moved to another port was silently moved back, and then
# reported healthy because wait_for_readiness probed the port it had just
# relocated to.
# shellcheck source=lib/http-bind.sh
. "${ORCASYNAPSE_ROOT}/scripts/lib/http-bind.sh"

UI_ACCENT="${UI_AMBER}"
UI_ACCENT_SOFT="${UI_AMBER_SOFT}"
UI_BANNER_TAGLINE="PRIVATE AI CONTROL PLANE  /  INSTALLATION-KEY ROTATION"
TOTAL_STEPS=3

validate_protected_installation() {
  [[ "${EUID}" -eq 0 ]] || fail "run this break-glass command as root"
  # Exactly the confirmation, and nothing this script does not understand. The
  # public-scheme flag has already been taken out of the list by the time this
  # runs, so a leftover argument here is a typo, and a typo that is silently
  # ignored is how an operator ends up believing they declared something they
  # did not.
  # One spelling, and the one that is true.
  #
  # `--confirm-revoke-local-sessions` was accepted here and branched on nowhere,
  # so it did exactly what the other flag does -- while the closing message of
  # this same script tells the operator that local-password sessions were *not*
  # revoked. A confirmation flag whose name contradicts the behaviour it confirms
  # is worse than no flag: it is the one thing a break-glass tool must not get
  # wrong, because the operator reads it under pressure.
  (( $# == 1 )) && [[ "$1" == "--confirm-revoke-recovery-sessions" ]] \
    || fail "explicit confirmation is required: sudo ./scripts/rotate-installation-key.sh --confirm-revoke-recovery-sessions"
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
  command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required"
  command -v curl >/dev/null 2>&1 || fail "curl is required"

  local secret
  for secret in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
    [[ -s "${ORCASYNAPSE_SECRET_DIR}/${secret}" ]] || fail "the protected OrcaSynapse secret set is incomplete"
  done
  success "Protected installation verified; rotation is safe to proceed."
}

wait_for_readiness() {
  local deadline=$((SECONDS + 180))
  until curl --fail --silent "http://127.0.0.1:${ORCASYNAPSE_HTTP_PORT}/readyz" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}

main() {
  orcasynapse_take_public_scheme_flag "$@"
  orcasynapse_take_http_bind_flag "${ORCASYNAPSE_REMAINING_ARGS[@]+"${ORCASYNAPSE_REMAINING_ARGS[@]}"}"
  set -- ${ORCASYNAPSE_REMAINING_ARGS[@]+"${ORCASYNAPSE_REMAINING_ARGS[@]}"}

  UI_BANNER_META="Release $(installer_release_version)"
  banner

  step 1 "${TOTAL_STEPS}" "Validate the protected installation"
  validate_protected_installation "$@"
  cd "${ORCASYNAPSE_ROOT}"
  # Read back from the installation's own state, then recorded again if this
  # invocation declared something new, so the next rotation reads that instead.
  orcasynapse_resolve_public_scheme
  orcasynapse_persist_public_scheme
  orcasynapse_resolve_http_bind
  orcasynapse_persist_http_bind
  orcasynapse_resolve_http_port

  step 2 "${TOTAL_STEPS}" "Rotate the Installation Key and revoke recovery sessions"
  local new_key key_tmp
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

  step 3 "${TOTAL_STEPS}" "Restart and verify the control plane"
  # Beside the recreation it describes rather than in a closing panel, because
  # what an operator needs to read here is which scheme the proxy is coming back
  # on -- and on an installation that never recorded one, that it is http.
  orcasynapse_report_public_scheme
  orcasynapse_report_http_bind
  run_with_progress "Restart the control plane with the rotated key" \
    docker compose up -d --no-build --force-recreate api web \
    || fail "could not restart the control plane"
  run_with_progress "Wait for control-plane readiness" wait_for_readiness \
    || fail "OrcaSynapse did not become ready after key rotation; inspect docker compose logs"

  # After the restart, and guarded.
  #
  # This ran in step 2, between overwriting the key file and printing its
  # replacement, and it was the one external command in this script without a
  # `|| fail`. Under `set -Eeuo pipefail` that meant an abort inside the damage
  # window: raw psql stderr instead of the FAILED banner every other path
  # produces, and no new key on screen. `validate_protected_installation` never
  # checks that the stack is running and `docker compose stop api` exits 0
  # against a project that is already down, so nothing upstream caught it.
  #
  # Moving it here removes the window entirely, because the restart above is
  # what starts postgres -- `api` waits on `migrate`, which waits on `postgres`
  # being healthy. It is also no longer the only thing standing between an old
  # recovery session and refusal: the API revokes those on rotation detection
  # alone, comparing the mounted key against the stored digest, which is pinned
  # by `admin-session.test.ts`. This is defence in depth and audit hygiene, so
  # it belongs where a failure costs nothing but a message.
  run_with_progress "Revoke outstanding Installation-Key recovery sessions" \
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U orcasynapse -d orcasynapse \
      -c "UPDATE \"AdministratorSession\" SET \"revokedAt\" = CURRENT_TIMESTAMP WHERE \"authenticationMethod\" = 'INSTALLATION_KEY_RECOVERY' AND \"revokedAt\" IS NULL" \
    || fail "the rotated key is in place and the control plane is running, but outstanding recovery sessions could not be revoked; they are already refused by the rotation itself, and you can clear the rows by hand"
  success "Existing Installation-Key recovery sessions were revoked."

  ui_panel_begin "${UI_AMBER}" "INSTALLATION KEY ROTATED"
  ui_panel_line 'New offline recovery Installation Key'
  ui_panel_line "${new_key}"
  ui_panel_end "${UI_AMBER}"
  warning "Store the new key in your organization password vault now; the previous key no longer works."
  info "Local-password administrator sessions were not revoked; only Installation-Key recovery sessions were."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
