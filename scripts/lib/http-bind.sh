# shellcheck shell=bash
# The host address the bundled proxy publishes on, and the single place that
# decides it.
#
# Why this needed the same treatment as the public scheme. compose.yaml already
# reads ORCASYNAPSE_HTTP_BIND and its own comment tells an operator to set it to
# 127.0.0.1, because a host firewall rule on the published port does not apply:
# Docker's NAT path bypasses it, so this variable is the only effective access
# control the deployment offers. But the variable was read in exactly one place
# and recorded in none -- no script, no systemd unit, no state file -- and every
# path that recreates the web container therefore re-derived the fallback.
#
# The unattended path is the one that matters. The orcasynapse-update unit
# carries three Environment= lines and this is not among them, the update agent
# hands install.sh an explicit env list that omits it, and install.sh carries
# only .local into the staging tree before swapping -- destroying a project .env
# or compose.override.yaml an operator had put there. So a dashboard-approved
# update silently re-published a control plane that had been bound to loopback
# onto 0.0.0.0, printed nothing, and was health-gated as successful.
#
# Everything below mirrors public-scheme.sh deliberately, including recording
# only an explicit declaration: writing the default into the state file would
# turn "nobody has decided" into "somebody chose to publish this publicly", and
# would silence the one line telling an operator that is what happened.
#
# The recorded value is an operator declaration, not a secret -- it is a bind
# address, safe in an install log, and it must never be written into
# .local/secrets where the installer's guards treat every file as protected
# material.
#
# Requires ORCASYNAPSE_ROOT and the installer UI library (fail/warning/info/
# success/ui_log) to be in scope already.

ORCASYNAPSE_HTTP_BIND_STATE="${ORCASYNAPSE_ROOT}/.local/state/http-bind"
ORCASYNAPSE_HTTP_BIND_DEFAULT="0.0.0.0"

# Only a variable that was already set counts as a declaration; the scripts
# default it themselves and that default must not be mistaken for one.
if [[ -n "${ORCASYNAPSE_HTTP_BIND:-}" ]]; then
  ORCASYNAPSE_HTTP_BIND_DECLARED="environment"
else
  ORCASYNAPSE_HTTP_BIND_DECLARED=""
fi
ORCASYNAPSE_HTTP_BIND_RECORDED=""

# An IPv4 literal, or an IPv6 literal in the brackets compose requires when a
# port follows. Deliberately not a hostname: compose resolves the published
# address once at container creation, so a name that later resolves elsewhere
# would leave the deployment bound to an address nobody chose.
orcasynapse_validate_http_bind() {
  local value="${1:-}"
  [[ -n "${value}" ]] || return 1
  [[ "${value}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && return 0
  [[ "${value}" =~ ^\[[0-9A-Fa-f:]+\]$ ]] && return 0
  return 1
}

# Takes --http-bind out of an argument list and leaves everything else in
# ORCASYNAPSE_REMAINING_ARGS for the caller's own parser. An unrecognised value
# is refused rather than accepted and silently meaning something else, for the
# reason public-scheme.sh states: silently ignoring a misspelled flag is the
# failure this file exists to remove.
orcasynapse_take_http_bind_flag() {
  local value
  ORCASYNAPSE_REMAINING_ARGS=()
  while (( $# > 0 )); do
    case "$1" in
      --http-bind)
        (( $# >= 2 )) || fail "--http-bind needs a value: --http-bind 127.0.0.1"
        value="$2"
        shift 2
        ;;
      --http-bind=*)
        value="${1#*=}"
        shift
        ;;
      *)
        ORCASYNAPSE_REMAINING_ARGS+=("$1")
        shift
        continue
        ;;
    esac
    orcasynapse_validate_http_bind "${value}" \
      || fail "--http-bind must be an IPv4 address or a bracketed IPv6 address, not '${value}'"
    ORCASYNAPSE_HTTP_BIND="${value}"
    ORCASYNAPSE_HTTP_BIND_DECLARED="flag"
    export ORCASYNAPSE_HTTP_BIND
  done
}

# Settles the bind in force: the flag, then an environment declaration, then
# whatever a previous run recorded, then the public default. The default last
# and never overriding a recording is the whole point.
orcasynapse_resolve_http_bind() {
  local damaged=0
  if [[ -f "${ORCASYNAPSE_HTTP_BIND_STATE}" ]]; then
    ORCASYNAPSE_HTTP_BIND_RECORDED="$(<"${ORCASYNAPSE_HTTP_BIND_STATE}")"
    ORCASYNAPSE_HTTP_BIND_RECORDED="${ORCASYNAPSE_HTTP_BIND_RECORDED//[$'\r\n\t ']/}"
    if ! orcasynapse_validate_http_bind "${ORCASYNAPSE_HTTP_BIND_RECORDED}"; then
      damaged=1
      ORCASYNAPSE_HTTP_BIND_RECORDED=""
    fi
  fi

  case "${ORCASYNAPSE_HTTP_BIND_DECLARED}" in
    flag|environment)
      orcasynapse_validate_http_bind "${ORCASYNAPSE_HTTP_BIND:-}" \
        || fail "ORCASYNAPSE_HTTP_BIND must be an IPv4 address or a bracketed IPv6 address, not '${ORCASYNAPSE_HTTP_BIND:-}'"
      (( damaged == 0 )) \
        || warning "The recorded bind address in ${ORCASYNAPSE_HTTP_BIND_STATE} was unreadable; the declaration on this command replaces it."
      ;;
    *)
      # Nothing declared and the recording is gone. Unlike the public scheme
      # this does not refuse the run: the safe reading of an unreadable bind is
      # the restrictive one, so it falls back to loopback and says so. Refusing
      # would brick the break-glass rotation over a truncated file, and
      # continuing on 0.0.0.0 would be the silent re-publication this whole file
      # exists to prevent.
      if (( damaged == 1 )); then
        warning "The recorded bind address in ${ORCASYNAPSE_HTTP_BIND_STATE} is unreadable; binding to 127.0.0.1 for this run."
        info "Re-declare it with --http-bind 0.0.0.0 to publish on every interface, or --http-bind 127.0.0.1 to keep it local."
        ORCASYNAPSE_HTTP_BIND="127.0.0.1"
        ORCASYNAPSE_HTTP_BIND_DECLARED="recovered"
      elif [[ -n "${ORCASYNAPSE_HTTP_BIND_RECORDED}" ]]; then
        ORCASYNAPSE_HTTP_BIND="${ORCASYNAPSE_HTTP_BIND_RECORDED}"
        ORCASYNAPSE_HTTP_BIND_DECLARED="recorded"
      else
        ORCASYNAPSE_HTTP_BIND="${ORCASYNAPSE_HTTP_BIND_DEFAULT}"
      fi
      ;;
  esac
  export ORCASYNAPSE_HTTP_BIND
  ui_log "http-bind=${ORCASYNAPSE_HTTP_BIND} source=${ORCASYNAPSE_HTTP_BIND_DECLARED:-default}"
}

# Records an explicit declaration so later runs -- a re-install, an unattended
# update, and above all the break-glass rotation -- read it back instead of
# re-deriving the default.
orcasynapse_persist_http_bind() {
  case "${ORCASYNAPSE_HTTP_BIND_DECLARED}" in
    flag|environment) ;;
    *) return 0 ;;
  esac
  if [[ -n "${ORCASYNAPSE_HTTP_BIND_RECORDED}" \
     && "${ORCASYNAPSE_HTTP_BIND_RECORDED}" != "${ORCASYNAPSE_HTTP_BIND}" ]]; then
    warning "The declared bind address changes from ${ORCASYNAPSE_HTTP_BIND_RECORDED} to ${ORCASYNAPSE_HTTP_BIND} for this installation."
  fi
  install -d -m 0700 "$(dirname -- "${ORCASYNAPSE_HTTP_BIND_STATE}")"
  printf '%s\n' "${ORCASYNAPSE_HTTP_BIND}" > "${ORCASYNAPSE_HTTP_BIND_STATE}"
  chmod 0600 "${ORCASYNAPSE_HTTP_BIND_STATE}"
  ORCASYNAPSE_HTTP_BIND_RECORDED="${ORCASYNAPSE_HTTP_BIND}"
}

# The published port, recorded alongside the bind for the same reason.
#
# The installer bakes the port into the update unit's Environment= list, so the
# unattended path keeps it -- but the break-glass rotation had no such channel
# and re-defaulted to 8080 at the top of the file. On a deployment installed on
# another port that silently *moved the dashboard*, because the force-recreate
# re-publishes with whatever the variable then held, and the run still reported
# healthy: `wait_for_readiness` probes ORCASYNAPSE_HTTP_PORT, which is the same
# wrong value, so the check confirmed the relocation rather than catching it.
#
# Unlike the bind there is no safe restrictive fallback, so a damaged recording
# leaves the caller's value alone and says so.
ORCASYNAPSE_HTTP_PORT_STATE="${ORCASYNAPSE_ROOT}/.local/state/http-port"

orcasynapse_validate_http_port() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 ))
}

# Only consulted when the caller did not name a port itself: an explicit
# ORCASYNAPSE_HTTP_PORT on the command line still wins, which is how an operator
# moves a deployment.
orcasynapse_resolve_http_port() {
  local recorded
  [[ -f "${ORCASYNAPSE_HTTP_PORT_STATE}" ]] || return 0
  [[ -z "${ORCASYNAPSE_HTTP_PORT_DECLARED:-}" ]] || return 0
  recorded="$(<"${ORCASYNAPSE_HTTP_PORT_STATE}")"
  recorded="${recorded//[$'\r\n\t ']/}"
  if ! orcasynapse_validate_http_port "${recorded}"; then
    warning "The recorded port in ${ORCASYNAPSE_HTTP_PORT_STATE} is unreadable; continuing on ${ORCASYNAPSE_HTTP_PORT}."
    return 0
  fi
  if [[ "${recorded}" != "${ORCASYNAPSE_HTTP_PORT}" ]]; then
    info "This installation was published on port ${recorded}; using it rather than the default."
  fi
  ORCASYNAPSE_HTTP_PORT="${recorded}"
  export ORCASYNAPSE_HTTP_PORT
  ui_log "http-port=${ORCASYNAPSE_HTTP_PORT} source=recorded"
}

orcasynapse_persist_http_port() {
  orcasynapse_validate_http_port "${ORCASYNAPSE_HTTP_PORT:-}" || return 0
  install -d -m 0700 "$(dirname -- "${ORCASYNAPSE_HTTP_PORT_STATE}")"
  printf '%s\n' "${ORCASYNAPSE_HTTP_PORT}" > "${ORCASYNAPSE_HTTP_PORT_STATE}"
  chmod 0600 "${ORCASYNAPSE_HTTP_PORT_STATE}"
}

# Says out loud what the deployment is reachable on. Silence is what made the
# original defect invisible: an update completed with a green summary while the
# dashboard moved from loopback to every interface.
orcasynapse_report_http_bind() {
  if [[ "${ORCASYNAPSE_HTTP_BIND}" != "0.0.0.0" ]]; then
    success "Bound to ${ORCASYNAPSE_HTTP_BIND}: the dashboard is not published on other interfaces."
    return 0
  fi
  warning "Bound to 0.0.0.0: the dashboard is published on every interface of this host."
  info "A host firewall rule on the published port does not apply, because Docker publishes through NAT. Re-run with --http-bind 127.0.0.1 to keep it local."
}
