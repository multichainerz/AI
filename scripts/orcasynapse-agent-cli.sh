#!/usr/bin/env bash
# orcasynapse-agent — the operator CLI for an enrolled Agentic System node (VM2).
# format: orcasynapse-agent-cli/v1
#
# This program owns no logic. Every action executes an artifact that already
# exists and is tested on its own: the served installer's --repair arm, the
# decommissioner, and `systemctl start` on the oneshots the timers already run.
# If this file is deleted, nothing operational is lost — which is the property
# that keeps a convenience menu from becoming a second implementation of the
# product.
#
# Served by OrcaSynapse at /install/orcasynapse-agent and installed to
# /usr/local/bin/orcasynapse-agent by install-agentic-node.sh, on enrollment
# and on every --repair, so the CLI a node carries is the CLI its control
# plane distributes.
#
# Bare invocation on a TTY opens the menu; a subcommand runs non-interactively,
# so `orcasynapse-agent status` works in a script or a cron line unchanged.
set -Eeuo pipefail

CLI_VERSION="v9.5.9"

STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
HERMES_USER="${ORCASYNAPSE_HERMES_USER:-orcasynapse-hermes}"
RUNTIME_SERVICE="orcasynapse-hermes"
NODE_TARGET="orcasynapse-hermes-node"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
DESIRED_STATE_SERVICE="orcasynapse-hermes-desired-state"
CORPUS_SERVICE="orcasynapse-hermes-corpus"
ARTIFACT_SERVICE="orcasynapse-hermes-artifacts"

# The signed channel refuses requests outside this window; doctor checks the
# same number the control plane enforces (SIGNATURE_CLOCK_SKEW_MS).
CLOCK_SKEW_BUDGET_SECONDS=300

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
  [[ "${EUID}" -eq 0 ]] || fail "orcasynapse-agent reads protected node state; run it with sudo"
}

require_enrolled() {
  [[ -s "${STATE_ROOT}/node-id" ]] \
    || fail "no completed OrcaSynapse enrollment exists under ${STATE_ROOT}; enroll this host from the dashboard first"
}

control_plane_url() {
  [[ -s "${STATE_ROOT}/control-plane-url" ]] \
    || fail "the enrollment left no control-plane address at ${STATE_ROOT}/control-plane-url"
  local url
  url="$(<"${STATE_ROOT}/control-plane-url")"
  printf '%s' "${url%/}"
}

installed_version() {
  # Required, not optional: every enrollment and repair writes this breadcrumb,
  # so a missing file is a broken install rather than an old one.
  [[ -s "${STATE_ROOT}/installer-version" ]] || { printf 'missing'; return 0; }
  tr -d '[:space:]' < "${STATE_ROOT}/installer-version"
}

control_plane_version() {
  local origin="$1"
  curl --fail --silent --max-time 10 "${origin}/api/v1/platform" 2>/dev/null \
    | jq -r '.version // empty' 2>/dev/null || printf ''
}

unit_state() {
  local active
  active="$(systemctl is-active "$1" 2>/dev/null)" || true
  printf '%s' "${active:-unknown}"
}

# One line per moving part, in the vocabulary the dashboard uses.
command_status() {
  require_root
  require_enrolled
  local origin node_id
  origin="$(control_plane_url)"
  node_id="$(tr -d '[:space:]' < "${STATE_ROOT}/node-id")"

  say "${BOLD}Agentic System node${RESET} ${DIM}${node_id:0:8} · CLI ${CLI_VERSION}${RESET}"
  say ""
  say "${BOLD}Services${RESET}"
  local unit
  for unit in "${RUNTIME_SERVICE}.service" "${HEARTBEAT_SERVICE}.timer" "${DESIRED_STATE_SERVICE}.timer" "${CORPUS_SERVICE}.timer" "${ARTIFACT_SERVICE}.timer"; do
    local state
    state="$(unit_state "${unit}")"
    if [[ "${state}" == "active" ]]; then
      ok "${unit} ${DIM}active${RESET}"
    else
      bad "${unit} ${state}"
    fi
  done

  say ""
  say "${BOLD}Runtime${RESET}"
  if curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null 2>&1; then
    ok "Hermes answers on 127.0.0.1:8642"
  else
    bad "Hermes does not answer on 127.0.0.1:8642 — journalctl -u ${RUNTIME_SERVICE} -n 50"
  fi
  local beat
  beat="$(systemctl show "${HEARTBEAT_SERVICE}.service" --property=ExecMainExitTimestamp --value 2>/dev/null)" || beat=""
  if [[ -n "${beat}" && "${beat}" != "n/a" ]]; then
    ok "Last heartbeat run: ${beat}"
  else
    warn "The heartbeat has not run yet on this boot"
  fi

  say ""
  say "${BOLD}Release${RESET}"
  local local_version remote_version
  local_version="$(installed_version)"
  remote_version="$(control_plane_version "${origin}")"
  if [[ "${local_version}" == "missing" ]]; then
    bad "No installer breadcrumb at ${STATE_ROOT}/installer-version — the enrollment is incomplete; run: orcasynapse-agent update"
  elif [[ -z "${remote_version}" ]]; then
    warn "Node installed with ${local_version}; OrcaSynapse at ${origin} is not answering, so drift is unknown"
  elif [[ "${local_version}" == "v${remote_version}" ]]; then
    ok "Node ${local_version} matches OrcaSynapse ${remote_version}"
  else
    warn "Node installed with ${local_version}, OrcaSynapse serves v${remote_version} — run: orcasynapse-agent update"
  fi
}

command_update() {
  require_root
  require_enrolled
  local origin local_version remote_version
  origin="$(control_plane_url)"
  local_version="$(installed_version)"
  remote_version="$(control_plane_version "${origin}")"
  [[ -n "${remote_version}" ]] \
    || fail "OrcaSynapse at ${origin} is not answering; the node downloads its update from there, so fix that first"
  if [[ "${local_version}" == "v${remote_version}" ]]; then
    say "Already current: node and OrcaSynapse are both at ${local_version}."
    return 0
  fi

  # --repair, not --connect: on a completed enrollment the installer refuses
  # --connect outright. Repair revalidates the enrollment, rewrites the managed
  # service boundary from the release OrcaSynapse serves, and restarts Hermes
  # in place; identity, keys and policy are untouched.
  local command="curl -fsSL ${origin}/install/agentic-node.sh | sudo bash -s -- --repair"
  say "Node is at ${local_version}; OrcaSynapse serves v${remote_version}."
  say ""
  say "  ${CYAN}${command}${RESET}"
  say ""
  if [[ -t 0 ]]; then
    read -r -p "Run it now? [y/N] " answer
    [[ "${answer}" == "y" || "${answer}" == "Y" ]] || { say "Left unchanged."; return 0; }
  fi
  curl -fsSL "${origin}/install/agentic-node.sh" | bash -s -- --repair
}

command_sync() {
  require_root
  require_enrolled
  local unit
  for unit in "${DESIRED_STATE_SERVICE}" "${CORPUS_SERVICE}" "${ARTIFACT_SERVICE}"; do
    if systemctl start "${unit}.service" 2>/dev/null; then
      ok "${unit} ran"
    else
      bad "${unit} failed — journalctl -u ${unit} -n 30"
    fi
  done
}

command_doctor() {
  require_root
  require_enrolled
  local origin failures=0
  origin="$(control_plane_url)"

  say "${BOLD}Doctor${RESET} ${DIM}every check names the fault it exists to catch${RESET}"

  # The signed channel rejects requests outside a five-minute window, and a
  # drifted VM clock produces authentication errors that read as key problems.
  if [[ "$(timedatectl show --property=NTPSynchronized --value 2>/dev/null)" == "yes" ]]; then
    ok "Clock is NTP-synchronized"
  else
    bad "Clock is not NTP-synchronized; signed requests fail outside a ±${CLOCK_SKEW_BUDGET_SECONDS}s window"
    failures=$((failures + 1))
  fi

  local remote_date skew
  remote_date="$(curl --fail --silent --head --max-time 10 "${origin}/api/v1/platform" 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: //p')" || remote_date=""
  if [[ -n "${remote_date}" ]]; then
    skew=$(( $(date +%s) - $(date -d "${remote_date}" +%s) ))
    if (( skew < 0 )); then skew=$(( -skew )); fi
    if (( skew <= CLOCK_SKEW_BUDGET_SECONDS )); then
      ok "Clock agrees with OrcaSynapse within ${skew}s"
    else
      bad "Clock disagrees with OrcaSynapse by ${skew}s (budget ${CLOCK_SKEW_BUDGET_SECONDS}s)"
      failures=$((failures + 1))
    fi
  else
    bad "OrcaSynapse at ${origin} is unreachable from this node"
    failures=$((failures + 1))
  fi

  local unit
  for unit in "${RUNTIME_SERVICE}.service" "${HEARTBEAT_SERVICE}.timer" "${DESIRED_STATE_SERVICE}.timer" "${CORPUS_SERVICE}.timer" "${ARTIFACT_SERVICE}.timer"; do
    if [[ "$(unit_state "${unit}")" == "active" ]]; then
      ok "${unit} active"
    else
      bad "${unit} $(unit_state "${unit}")"
      failures=$((failures + 1))
    fi
  done

  # Both halves of the deliverable path: the systemd sandbox names the
  # artifacts subtree, and the service account can create a session directory
  # in it. The first shipped broken once; this check is why it cannot again.
  if systemctl cat "${RUNTIME_SERVICE}.service" 2>/dev/null | grep -q "ReadWritePaths=.*${STATE_ROOT}/artifacts"; then
    ok "Runtime sandbox grants ${STATE_ROOT}/artifacts"
  else
    bad "Runtime sandbox does not name ${STATE_ROOT}/artifacts in ReadWritePaths; deliverable writes fail with EROFS — run: orcasynapse-agent update"
    failures=$((failures + 1))
  fi
  local probe="${STATE_ROOT}/artifacts/.doctor-probe-$$"
  if runuser -u "${HERMES_USER}" -- mkdir "${probe}" 2>/dev/null; then
    rmdir "${probe}" 2>/dev/null || true
    ok "Service account can create a session directory under artifacts/"
  else
    bad "Service account ${HERMES_USER} cannot write ${STATE_ROOT}/artifacts"
    failures=$((failures + 1))
  fi

  local free_kb
  free_kb="$(df --output=avail -k "${STATE_ROOT}" 2>/dev/null | tail -1 | tr -d ' ')" || free_kb=""
  if [[ -n "${free_kb}" ]] && (( free_kb > 1024 * 1024 )); then
    ok "$(( free_kb / 1024 / 1024 )) GiB free under ${STATE_ROOT}"
  else
    warn "Less than 1 GiB free under ${STATE_ROOT}"
  fi

  say ""
  if (( failures == 0 )); then
    say "${GREEN}Every check passed.${RESET}"
  else
    fail "${failures} check(s) failed"
  fi
}

command_logs() {
  require_root
  local unit="${1:-${RUNTIME_SERVICE}}"
  case "${unit}" in
    runtime)   unit="${RUNTIME_SERVICE}" ;;
    heartbeat) unit="${HEARTBEAT_SERVICE}" ;;
    state)     unit="${DESIRED_STATE_SERVICE}" ;;
    corpus)    unit="${CORPUS_SERVICE}" ;;
    artifacts) unit="${ARTIFACT_SERVICE}" ;;
  esac
  exec journalctl -u "${unit}" -n 100 --no-pager
}

command_decommission() {
  require_root
  require_enrolled
  local origin node_id
  origin="$(control_plane_url)"
  node_id="$(tr -d '[:space:]' < "${STATE_ROOT}/node-id")"
  local command="curl -fsSL ${origin}/install/remove-agentic-node.sh | sudo bash"
  say "This permanently removes the Hermes runtime, its units and its identity from this host."
  say "Revoke the node in the OrcaSynapse dashboard as well; decommissioning does not tell it."
  say ""
  say "  ${CYAN}${command}${RESET}"
  say ""
  read -r -p "Type the first 8 characters of the node id (${node_id:0:8}) to continue: " answer
  [[ "${answer}" == "${node_id:0:8}" ]] || fail "confirmation did not match; nothing was removed"
  curl -fsSL "${origin}/install/remove-agentic-node.sh" | bash
}

usage() {
  cat <<USAGE
orcasynapse-agent ${CLI_VERSION} — operate this Agentic System node

  status        services, runtime health, heartbeat, release drift
  update        repair the node in place from the release OrcaSynapse serves
  sync          run the desired-state, corpus and artifact publishers now
  doctor        clock, connectivity, units, deliverable path, disk
  logs [unit]   journal for runtime|heartbeat|state|corpus|artifacts
  decommission  remove the runtime from this host (confirmed, destructive)

Run with no arguments on a terminal for the menu.
USAGE
}

menu() {
  say "${BOLD}orcasynapse-agent${RESET} ${DIM}${CLI_VERSION}${RESET}"
  say ""
  say "  1) Status"
  say "  2) Update (repair in place)"
  say "  3) Sync now"
  say "  4) Doctor"
  say "  5) Logs (runtime)"
  say "  6) Decommission"
  say "  q) Quit"
  say ""
  read -r -p "> " choice
  case "${choice}" in
    1) command_status ;;
    2) command_update ;;
    3) command_sync ;;
    4) command_doctor ;;
    5) command_logs runtime ;;
    6) command_decommission ;;
    q|Q|"") exit 0 ;;
    *) fail "unknown choice: ${choice}" ;;
  esac
}

main() {
  local command="${1:-}"
  case "${command}" in
    status)       command_status ;;
    update)       command_update ;;
    sync)         command_sync ;;
    doctor)       command_doctor ;;
    logs)         shift; command_logs "${1:-runtime}" ;;
    decommission) command_decommission ;;
    version)      say "${CLI_VERSION}" ;;
    help|--help|-h) usage ;;
    "")
      if [[ -t 0 && -t 1 ]]; then menu; else usage; exit 64; fi
      ;;
    *) usage; exit 64 ;;
  esac
}

main "$@"
