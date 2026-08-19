#!/usr/bin/env bash
# orcasynapse — the operator CLI for the control-plane host (VM1).
# format: orcasynapse-cli/v1
#
# This program owns no logic. The update path belongs to the in-dashboard
# update agent — approval happens in Settings > System, application happens in
# orcasynapse-update.service — and this CLI only reads state and starts that
# unit. It can therefore never apply a release nobody approved, and deleting
# this file loses nothing operational.
#
# Installed to /usr/local/bin/orcasynapse by install-orcasynapse.sh, so it is
# replaced on every release the same way the update agent is.
#
# Bare invocation on a TTY opens the menu; a subcommand runs non-interactively.
set -Eeuo pipefail

CLI_VERSION="v9.5.1"

ORCASYNAPSE_UPDATE_UNIT="${ORCASYNAPSE_UPDATE_UNIT:-orcasynapse-update}"
ORCASYNAPSE_UPDATE_STATE_DIR="${ORCASYNAPSE_UPDATE_STATE_DIR:-/var/lib/orcasynapse-update}"
UPDATE_UNIT_FILE="/etc/systemd/system/${ORCASYNAPSE_UPDATE_UNIT}.service"

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != "dumb" ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[38;5;78m'; AMBER=$'\033[38;5;214m'
  RED=$'\033[38;5;203m'; CYAN=$'\033[38;5;80m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; AMBER=""; RED=""; CYAN=""; RESET=""
fi

ok()   { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$1"; }
warn() { printf '  %s!%s %s\n' "${AMBER}" "${RESET}" "$1"; }
bad()  { printf '  %s✗%s %s\n' "${RED}" "${RESET}" "$1"; }
say()  { printf '%s\n' "$1"; }
fail() { printf '%s✗ %s%s\n' "${RED}" "$1" "${RESET}" >&2; exit 1; }

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "orcasynapse reads protected deployment state; run it with sudo"
}

# The update agent's unit is the one durable record of where this deployment
# lives and how it is addressed; reading it keeps the CLI and the agent
# agreeing without a second configuration file.
unit_environment() {
  [[ -r "${UPDATE_UNIT_FILE}" ]] \
    || fail "no ${ORCASYNAPSE_UPDATE_UNIT} unit at ${UPDATE_UNIT_FILE}; this host is not a managed OrcaSynapse installation"
  local name="$1"
  sed -n "s/^Environment=${name}=//p" "${UPDATE_UNIT_FILE}" | head -1
}

INSTALL_DIR=""
HTTP_PORT=""
load_environment() {
  INSTALL_DIR="$(unit_environment ORCASYNAPSE_INSTALL_DIR)"
  HTTP_PORT="$(unit_environment ORCASYNAPSE_HTTP_PORT)"
  [[ -n "${INSTALL_DIR}" && -n "${HTTP_PORT}" ]] \
    || fail "the ${ORCASYNAPSE_UPDATE_UNIT} unit does not record the install directory and port this CLI needs"
}

compose() {
  docker compose --project-directory "${INSTALL_DIR}" "$@"
}

# Sibling of the update agent's own database_identity()/psql_value(): the same
# secret, the same parse, the same in-container psql. Duplicated here because
# the agent script executes top-to-bottom and cannot be sourced.
database_identity() {
  local secret="${INSTALL_DIR}/.local/secrets/orcasynapse_database_url"
  local url remainder authority user database
  [[ -s "${secret}" ]] || return 1
  url="$(<"${secret}")"
  url="${url//[[:space:]]/}"
  [[ "${url}" == *"://"* ]] || return 1
  remainder="${url#*://}"
  authority="${remainder##*@}"
  user="${remainder%%@*}"
  user="${user%%:*}"
  [[ "${authority}" == */* ]] || return 1
  database="${authority#*/}"
  database="${database%%\?*}"
  [[ "${user}" =~ ^[A-Za-z0-9_-]+$ && "${database}" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  printf '%s %s' "${user}" "${database}"
}

psql_value() {
  local identity user database out
  identity="$(database_identity)" || return 1
  user="${identity%% *}"
  database="${identity##* }"
  out="$(compose exec -T postgres \
    sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --username="$1" --dbname="$2" --no-password -tAc "$3"' \
    orcasynapse-cli "${user}" "${database}" "$1" \
    </dev/null 2>/dev/null)" || return 1
  printf '%s' "${out//[$'\r\n']/}"
}

installed_version() {
  local marker="${INSTALL_DIR}/.orcasynapse-source-commit"
  local version=""
  version="$(compose ps --format '{{.Image}}' api 2>/dev/null | head -1)" || version=""
  if [[ -s "${INSTALL_DIR}/package.json" ]]; then
    version="v$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "${INSTALL_DIR}/package.json" | head -1)"
  fi
  local commit=""
  [[ -r "${marker}" ]] && commit="$(tr -d '[:space:]' < "${marker}")"
  printf '%s %s' "${version:-unknown}" "${commit:0:12}"
}

release_target() {
  psql_value 'select coalesce("desiredVersion", '"''"') || '"'|'"' || coalesce("desiredCommit", '"''"') from "PlatformReleaseTarget" where "id" = '"'"'global'"'"''
}

command_status() {
  require_root
  load_environment

  say "${BOLD}OrcaSynapse control plane${RESET} ${DIM}${INSTALL_DIR} · CLI ${CLI_VERSION}${RESET}"
  say ""
  say "${BOLD}Services${RESET}"
  if curl --fail --silent --max-time 5 "http://127.0.0.1:${HTTP_PORT}/readyz" >/dev/null 2>&1; then
    ok "API answers on 127.0.0.1:${HTTP_PORT}/readyz"
  else
    bad "API does not answer on 127.0.0.1:${HTTP_PORT}/readyz"
  fi
  local line
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    if [[ "${line}" == *" running"* || "${line}" == *" Up"* ]]; then
      ok "${line}"
    else
      warn "${line}"
    fi
  done < <(compose ps --format '{{.Service}} {{.State}}' 2>/dev/null)

  say ""
  say "${BOLD}Release${RESET}"
  local installed
  installed="$(installed_version)"
  say "  Installed: ${installed}"
  local raw
  if raw="$(release_target)"; then
    local target_version="${raw%%|*}" target_commit="${raw#*|}"
    if [[ -z "${target_version}" ]]; then
      say "  Approved target: none — approve a release in Settings > System"
    else
      say "  Approved target: ${target_version} ${DIM}${target_commit:0:12}${RESET}"
    fi
  else
    warn "Could not read the approved release target from PostgreSQL"
  fi
  if [[ -s "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target" ]]; then
    bad "An update attempt failed and its target is blocked: $(tr -d '\n' < "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target")"
    say "  ${DIM}Re-approving the release in Settings > System is the deliberate retry.${RESET}"
  fi
  if [[ -s "${ORCASYNAPSE_UPDATE_STATE_DIR}/last-run.json" ]]; then
    say "  Last agent run: $(sed -n 's/.*"phase":"\([^"]*\)".*"detail":"\([^"]*\)".*/\1 — \2/p' "${ORCASYNAPSE_UPDATE_STATE_DIR}/last-run.json" | head -1)"
  fi
}

command_update() {
  require_root
  load_environment
  local raw target_version
  raw="$(release_target)" || fail "could not read the approved release target from PostgreSQL"
  target_version="${raw%%|*}"
  [[ -n "${target_version}" ]] \
    || fail "no release target is approved; approve one in Settings > System first — this CLI cannot choose a version"
  if [[ -s "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target" ]]; then
    fail "the approved target previously failed and is blocked; re-approve it in Settings > System to retry deliberately"
  fi

  local command="systemctl start ${ORCASYNAPSE_UPDATE_UNIT}.service"
  say "Approved target: ${target_version}. The update agent applies it with rollback protection."
  say ""
  say "  ${CYAN}${command}${RESET}"
  say ""
  if [[ -t 0 ]]; then
    read -r -p "Start it now? [y/N] " answer
    [[ "${answer}" == "y" || "${answer}" == "Y" ]] || { say "Left unchanged."; return 0; }
  fi
  systemctl start "${ORCASYNAPSE_UPDATE_UNIT}.service" &
  say "Started. Following the agent's journal (Ctrl-C detaches; the update continues):"
  exec journalctl -u "${ORCASYNAPSE_UPDATE_UNIT}" -f
}

command_logs() {
  require_root
  load_environment
  local service="${1:-api}"
  if [[ "${service}" == "agent" ]]; then
    exec journalctl -u "${ORCASYNAPSE_UPDATE_UNIT}" -n 100 --no-pager
  fi
  exec docker compose --project-directory "${INSTALL_DIR}" logs --tail 100 "${service}"
}

command_restart() {
  require_root
  load_environment
  local service="${1:-}"
  [[ -n "${service}" ]] || fail "name the service to restart: api, web, worker or postgres"
  local command="docker compose --project-directory ${INSTALL_DIR} restart ${service}"
  say "  ${CYAN}${command}${RESET}"
  if [[ -t 0 ]]; then
    read -r -p "Restart ${service}? [y/N] " answer
    [[ "${answer}" == "y" || "${answer}" == "Y" ]] || { say "Left unchanged."; return 0; }
  fi
  compose restart "${service}"
}

command_doctor() {
  require_root
  load_environment
  local failures=0

  say "${BOLD}Doctor${RESET}"
  if docker info >/dev/null 2>&1; then
    ok "Docker daemon answers"
  else
    bad "Docker daemon does not answer"
    failures=$((failures + 1))
  fi
  if curl --fail --silent --max-time 5 "http://127.0.0.1:${HTTP_PORT}/readyz" >/dev/null 2>&1; then
    ok "API is ready on port ${HTTP_PORT}"
  else
    bad "API is not ready on port ${HTTP_PORT} — orcasynapse logs api"
    failures=$((failures + 1))
  fi
  if psql_value 'select 1' >/dev/null 2>&1; then
    ok "PostgreSQL answers through the compose stack"
  else
    bad "PostgreSQL does not answer — orcasynapse logs postgres"
    failures=$((failures + 1))
  fi
  if [[ "$(systemctl is-enabled "${ORCASYNAPSE_UPDATE_UNIT}.timer" 2>/dev/null)" == "enabled" ]]; then
    ok "Update timer is enabled (checks every ten minutes)"
  else
    warn "Update timer is not enabled; in-dashboard updates will not apply on this host"
  fi
  if [[ -s "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target" ]]; then
    bad "A blocked update target exists: $(tr -d '\n' < "${ORCASYNAPSE_UPDATE_STATE_DIR}/failed-target")"
    failures=$((failures + 1))
  else
    ok "No blocked update target"
  fi
  local free_kb
  free_kb="$(df --output=avail -k "${INSTALL_DIR}" 2>/dev/null | tail -1 | tr -d ' ')" || free_kb=""
  if [[ -n "${free_kb}" ]] && (( free_kb > 5 * 1024 * 1024 )); then
    ok "$(( free_kb / 1024 / 1024 )) GiB free under ${INSTALL_DIR}"
  else
    warn "Less than 5 GiB free under ${INSTALL_DIR}; an update builds images and dumps the database"
  fi

  say ""
  if (( failures == 0 )); then
    say "${GREEN}Every check passed.${RESET}"
  else
    fail "${failures} check(s) failed"
  fi
}

usage() {
  cat <<USAGE
orcasynapse ${CLI_VERSION} — operate this OrcaSynapse control plane

  status             services, installed release, approved target, agent state
  update             apply the approved release target via the update agent
  logs [service]     compose logs for api|web|worker|postgres, or 'agent'
  restart <service>  restart one compose service (confirmed)
  doctor             docker, readiness, database, update timer, disk
  version            print this CLI's release

Approving a release stays in the dashboard (Settings > System); this CLI can
only apply what was approved there. Run with no arguments for the menu.
USAGE
}

menu() {
  say "${BOLD}orcasynapse${RESET} ${DIM}${CLI_VERSION}${RESET}"
  say ""
  say "  1) Status"
  say "  2) Update (apply the approved release)"
  say "  3) Doctor"
  say "  4) Logs (api)"
  say "  5) Logs (update agent)"
  say "  q) Quit"
  say ""
  read -r -p "> " choice
  case "${choice}" in
    1) command_status ;;
    2) command_update ;;
    3) command_doctor ;;
    4) command_logs api ;;
    5) command_logs agent ;;
    q|Q|"") exit 0 ;;
    *) fail "unknown choice: ${choice}" ;;
  esac
}

main() {
  local command="${1:-}"
  case "${command}" in
    status)  command_status ;;
    update)  command_update ;;
    logs)    shift; command_logs "${1:-api}" ;;
    restart) shift; command_restart "${1:-}" ;;
    doctor)  command_doctor ;;
    version) say "${CLI_VERSION}" ;;
    help|--help|-h) usage ;;
    "")
      if [[ -t 0 && -t 1 ]]; then menu; else usage; exit 64; fi
      ;;
    *) usage; exit 64 ;;
  esac
}

main "$@"
