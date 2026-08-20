#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

INSTALLER_VERSION="v9.5.6"
# Honor the same state-root overrides the installer accepts, so a non-default
# layout installed with ORCASYNAPSE_*_STATE_ROOT can be removed the same way.
STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
RUNTIME_SERVICE="orcasynapse-hermes"
HERMES_INSTALL_DIR="/usr/local/lib/hermes-agent"
HERMES_BINARY="/usr/local/bin/hermes"
HERMES_USER="orcasynapse-hermes"
HERMES_MANAGED_DIR="/etc/hermes"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
HEARTBEAT_CLIENT="/usr/local/lib/orcasynapse/hermes-heartbeat.sh"
DESIRED_STATE_SERVICE="orcasynapse-hermes-desired-state"
DESIRED_STATE_CLIENT="/usr/local/lib/orcasynapse/hermes-desired-state.sh"
CORPUS_SERVICE="orcasynapse-hermes-corpus"
ARTIFACT_SERVICE="orcasynapse-hermes-artifacts"
# Removed by name. Every other unit here is deleted by the
# orcasynapse-hermes-* glob elsewhere in this script, and that glob matches
# .service and .timer only -- a .target left behind would keep pulling four
# units that no longer exist on every boot.
NODE_TARGET="orcasynapse-hermes-node"
CORPUS_CLIENT="/usr/local/lib/orcasynapse/hermes-corpus-reconciler.py"
ARTIFACT_CLIENT="/usr/local/lib/orcasynapse/hermes-artifact-publisher.py"

# >>> ORCASYNAPSE-INSTALLER-UI v1 - generated from scripts/lib/installer-ui.sh; edit the library, then run: bash scripts/sync-installer-ui.sh >>>
# shellcheck shell=bash
# OrcaSynapse installer UI library — the single source of truth for the
# terminal experience shared by every installer-family script.
#
# Tree-resident scripts source this file directly. Self-contained scripts
# (install.sh, install-agentic-node.sh, remove-agentic-node.sh are fetched or
# served standalone) embed it verbatim between ORCASYNAPSE-INSTALLER-UI
# markers; edit here, then run: bash scripts/sync-installer-ui.sh
#
# Per-script variation happens only through these hooks, never by editing the
# embedded region:
#   UI_ACCENT            role accent color (defaults to blue)
#   UI_ACCENT_SOFT       dimmer shade of the same hue, for rules and gradients
#   UI_BANNER_TAGLINE    the line under the wordmark
#   UI_BANNER_META       optional dim version/source line under the divider
#   UI_BANNER_ACTIVITY   optional animated readiness label (empty = no dots)
#   UI_DOWNLOAD_MAX_TIME curl --max-time for download_with_progress
#   UI_LOG_FILE          when set, ui_* helpers append plain lines to this log
#   ui_register_temp_file  redefine to track helper temp files for cleanup
#
# Logging contract: secret values (passwords, keys, tokens, claims) must never
# pass through ui_* helpers. Panels that show secrets are printed with raw
# printf by their scripts and are never written to UI_LOG_FILE.
#
# Rendering degrades in three independent steps, because an installer runs over
# serial consoles, in CI logs, and inside cloud-init as often as in a modern
# terminal: colour is dropped without a TTY or under NO_COLOR, box-drawing is
# replaced by ASCII when the locale is not UTF-8, and every animation collapses
# to one static line when there is nothing to animate on.

if [[ -t 1 && "${TERM:-dumb}" != "dumb" ]]; then
  UI_INTERACTIVE=1
else
  UI_INTERACTIVE=0
fi

# Box drawing is a separate question from colour. A UTF-8 terminal with colour
# disabled still renders rules correctly; a latin-1 console shows mojibake for
# every one of them, which looks far worse than the ASCII it replaced.
if [[ "${LC_ALL:-}${LC_CTYPE:-}${LANG:-}" == *[Uu][Tt][Ff]* ]]; then
  UI_UNICODE=1
else
  UI_UNICODE=0
fi

if (( UI_INTERACTIVE )) && [[ -z "${NO_COLOR:-}" ]]; then
  UI_BOLD=$'\033[1m'
  UI_DIM=$'\033[2m'
  UI_BLUE=$'\033[38;5;75m'
  UI_CYAN=$'\033[38;5;80m'
  UI_GREEN=$'\033[38;5;78m'
  UI_AMBER=$'\033[38;5;214m'
  UI_RED=$'\033[38;5;203m'
  UI_MUTED=$'\033[38;5;244m'
  UI_FAINT=$'\033[38;5;240m'
  UI_BLUE_SOFT=$'\033[38;5;68m'
  UI_CYAN_SOFT=$'\033[38;5;72m'
  UI_GREEN_SOFT=$'\033[38;5;71m'
  UI_AMBER_SOFT=$'\033[38;5;172m'
  UI_RED_SOFT=$'\033[38;5;167m'
  UI_RESET=$'\033[0m'
else
  UI_BOLD=""
  UI_DIM=""
  UI_BLUE=""
  UI_CYAN=""
  UI_GREEN=""
  UI_AMBER=""
  UI_RED=""
  UI_MUTED=""
  UI_FAINT=""
  UI_BLUE_SOFT=""
  UI_CYAN_SOFT=""
  UI_GREEN_SOFT=""
  UI_AMBER_SOFT=""
  UI_RED_SOFT=""
  UI_RESET=""
fi

: "${UI_ACCENT:=${UI_BLUE}}"
: "${UI_ACCENT_SOFT:=${UI_BLUE_SOFT}}"
: "${UI_BANNER_TAGLINE:=ORCASYNAPSE}"
: "${UI_BANNER_META:=}"
: "${UI_BANNER_ACTIVITY:=}"
: "${UI_LOG_FILE:=}"

# Glyphs, chosen once so no call site decides for itself. The ASCII column is
# not a lesser experience -- it is the same layout with different ink.
if (( UI_UNICODE )); then
  UI_G_RULE="─"; UI_G_RULE_HEAVY="━"
  UI_G_TL="╭"; UI_G_TR="╮"; UI_G_BL="╰"; UI_G_BR="╯"; UI_G_V="│"
  UI_G_OK="✓"; UI_G_FAIL="✗"; UI_G_WARN="▲"; UI_G_INFO="›"
  UI_G_BAR_ON="━"; UI_G_BAR_OFF="─"
  UI_G_DOT_ON="●"; UI_G_DOT_OFF="○"
  UI_G_MARK="◆"
  UI_SPINNER_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
else
  UI_G_RULE="-"; UI_G_RULE_HEAVY="="
  UI_G_TL="+"; UI_G_TR="+"; UI_G_BL="+"; UI_G_BR="+"; UI_G_V="|"
  UI_G_OK="OK"; UI_G_FAIL="XX"; UI_G_WARN="!!"; UI_G_INFO="->"
  UI_G_BAR_ON="#"; UI_G_BAR_OFF="."
  UI_G_DOT_ON="*"; UI_G_DOT_OFF="."
  UI_G_MARK="*"
  UI_SPINNER_FRAMES=("|" "/" "-" "\\")
fi

# Panels track the terminal, clamped: below 64 the two-column rows collide, and
# above 96 a full-width rule reads as a horizon rather than a container.
ui_width() {
  local columns="${COLUMNS:-0}"
  if (( columns <= 0 )) && command -v tput >/dev/null 2>&1; then
    columns="$(tput cols 2>/dev/null || printf '0')"
  fi
  (( columns > 0 )) || columns=80
  (( columns > 96 )) && columns=96
  (( columns < 64 )) && columns=64
  printf '%d' "$((columns - 4))"
}

ui_repeat() {
  local glyph="$1" count="$2" out=""
  (( count > 0 )) || { printf ''; return 0; }
  # Built one character at a time: printf padding counts bytes, and a
  # multi-byte glyph would be truncated mid-sequence.
  while (( count-- > 0 )); do out+="${glyph}"; done
  printf '%s' "${out}"
}

ui_log() {
  [[ -n "${UI_LOG_FILE}" ]] || return 0
  printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >> "${UI_LOG_FILE}" 2>/dev/null || true
}

ui_pause() {
  (( UI_INTERACTIVE )) && sleep "${1:-0.08}"
  return 0
}

ui_show_cursor() {
  (( UI_INTERACTIVE )) && printf '\033[?25h'
  return 0
}

# Hook: helper temp files are announced here so scripts with an EXIT cleanup
# can track them. The default keeps untracked scripts working unchanged.
ui_register_temp_file() {
  :
}

ui_rule() {
  local color="${1:-${UI_FAINT}}" width
  width="$(ui_width)"
  printf '  %b%s%b\n' "${color}" "$(ui_repeat "${UI_G_RULE}" "${width}")" "${UI_RESET}"
}

banner() {
  local width shade
  width="$(ui_width)"
  printf '\n'
  # The wordmark is drawn in four shades of the role accent rather than one
  # flat colour. It is the same figlet the product has always used; the ramp is
  # what stops it reading as a 1990s shell script.
  local -a wordmark=(
'     ____                _____'
'    / __ \___________ _ / ___/__  ______  ____ _____  ________'
'   / / / / ___/ ___/  '"'"'/\__ \/ / / / __ \/ __ `/ __ \/ ___/ _ \'
'  / /_/ / /  / /__/ /| |__/ / /_/ / / / / /_/ / /_/ (__  )  __/'
'  \____/_/   \___/_/ |_/____/\__, /_/ /_/\__,_/ .___/____/\___/'
'                             /____/            /_/'
  )
  local index=0
  for line in "${wordmark[@]}"; do
    case "${index}" in
      0|1) shade="${UI_ACCENT}${UI_BOLD}" ;;
      2|3) shade="${UI_ACCENT}" ;;
      *)   shade="${UI_ACCENT_SOFT}" ;;
    esac
    printf '%b%s%b\n' "${shade}" "${line}" "${UI_RESET}"
    index=$((index + 1))
  done
  printf '\n'
  printf '  %b%s%b  %b%s%b\n' \
    "${UI_ACCENT}" "${UI_G_MARK}" "${UI_RESET}" \
    "${UI_BOLD}" "${UI_BANNER_TAGLINE}" "${UI_RESET}"
  ui_rule "${UI_FAINT}"
  if [[ -n "${UI_BANNER_META}" ]]; then
    printf '  %b%s%b\n' "${UI_MUTED}" "${UI_BANNER_META}" "${UI_RESET}"
  fi
  if (( UI_INTERACTIVE )) && [[ -n "${UI_BANNER_ACTIVITY}" ]]; then
    printf '  %b%s%b' "${UI_MUTED}" "${UI_BANNER_ACTIVITY}" "${UI_RESET}"
    for _ in 1 2 3; do
      printf '%b.%b' "${UI_ACCENT}" "${UI_RESET}"
      ui_pause 0.12
    done
    printf '  %b%s READY%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_G_OK}" "${UI_RESET}"
  fi
  printf '\n'
}

# A slim meter rather than a bracketed bar: the filled span is the accent, the
# remainder a faint rule of the same length, so the row reads as one line with
# a lit portion instead of a box that happens to contain hashes.
ui_meter() {
  local current="$1" total="$2" width="${3:-32}" filled
  (( total > 0 )) || total=1
  filled=$((current * width / total))
  (( filled > width )) && filled="${width}"
  printf '%b%s%b%b%s%b' \
    "${UI_ACCENT}" "$(ui_repeat "${UI_G_BAR_ON}" "${filled}")" "${UI_RESET}" \
    "${UI_FAINT}" "$(ui_repeat "${UI_G_BAR_OFF}" "$((width - filled))")" "${UI_RESET}"
}

step() {
  local current="$1" total="$2" label="$3" index dot
  printf '\n'
  # Step dots make position legible without reading the numbers, which is what
  # an operator actually wants from across a room during a long install.
  printf '  '
  for (( index = 1; index <= total; index++ )); do
    if (( index < current )); then
      dot="${UI_ACCENT_SOFT}${UI_G_DOT_ON}"
    elif (( index == current )); then
      dot="${UI_ACCENT}${UI_BOLD}${UI_G_DOT_ON}"
    else
      dot="${UI_FAINT}${UI_G_DOT_OFF}"
    fi
    # `if` rather than `(( … )) && printf`: a false arithmetic test is a failing
    # command, and as the last statement in the body it would trip the caller's
    # `set -e` on the final dot of every step.
    printf '%b%b' "${dot}" "${UI_RESET}"
    if (( index < total )); then printf ' '; fi
  done
  printf '\n'
  printf '  %b%02d%b %b%s%b %b%s%b\n' \
    "${UI_ACCENT}${UI_BOLD}" "${current}" "${UI_RESET}" \
    "${UI_FAINT}" "${UI_G_RULE}" "${UI_RESET}" \
    "${UI_BOLD}" "${label}" "${UI_RESET}"
  printf '  %s %b%3d%%%b\n' \
    "$(ui_meter "${current}" "${total}" 30)" \
    "${UI_MUTED}" "$((current * 100 / total))" "${UI_RESET}"
  ui_log "STEP ${current}/${total} ${label}"
}

info() {
  printf '     %b%s%b %b%s%b\n' "${UI_ACCENT}" "${UI_G_INFO}" "${UI_RESET}" "${UI_MUTED}" "$1" "${UI_RESET}"
  ui_log "info ${1}"
}

success() {
  printf '     %b%s%b %s\n' "${UI_GREEN}${UI_BOLD}" "${UI_G_OK}" "${UI_RESET}" "$1"
  ui_log "ok   ${1}"
}

warning() {
  printf '     %b%s%b %s\n' "${UI_AMBER}${UI_BOLD}" "${UI_G_WARN}" "${UI_RESET}" "$1" >&2
  ui_log "warn ${1}"
}

fail() {
  local width
  width="$(ui_width)"
  printf '\n  %b%s%b\n' "${UI_RED}" "$(ui_repeat "${UI_G_RULE}" "${width}")" "${UI_RESET}" >&2
  printf '  %b%s FAILED%b  %s\n' "${UI_RED}${UI_BOLD}" "${UI_G_FAIL}" "${UI_RESET}" "$1" >&2
  printf '  %b%s%b\n\n' "${UI_RED}" "$(ui_repeat "${UI_G_RULE}" "${width}")" "${UI_RESET}" >&2
  ui_log "ERROR ${1}"
  exit 1
}

render_activity_progress() {
  local label="$1" elapsed="$2" tick="$3" frame count
  count="${#UI_SPINNER_FRAMES[@]}"
  frame="${UI_SPINNER_FRAMES[$((tick % count))]}"
  printf '\r\033[2K     %b%s%b %-44.44s %b%3ss%b' \
    "${UI_ACCENT}" "${frame}" "${UI_RESET}" "${label}" "${UI_FAINT}" "${elapsed}" "${UI_RESET}"
}

run_with_progress() {
  local label="$1"
  shift
  if (( ! UI_INTERACTIVE )); then
    info "${label}"
    # Capture the status explicitly: call sites guard with `|| fail`, which
    # suppresses errexit inside this function, so a bare "$@" would fall
    # through to success on failure.
    local direct_status=0
    "$@" || direct_status=$?
    if (( direct_status == 0 )); then
      success "${label}"
    else
      printf '     %b%s%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_G_FAIL}" "${UI_RESET}" "${label}" >&2
      ui_log "FAIL ${label}"
    fi
    return "${direct_status}"
  fi

  local log_file pid status=0 frame_index=0 started elapsed
  log_file="$(mktemp /tmp/orcasynapse-command.XXXXXX)"
  ui_register_temp_file "${log_file}"
  started="${SECONDS}"
  "$@" >"${log_file}" 2>&1 &
  pid=$!
  printf '\033[?25l'
  while kill -0 "${pid}" 2>/dev/null; do
    elapsed=$((SECONDS - started))
    render_activity_progress "${label}" "${elapsed}" "${frame_index}"
    frame_index=$((frame_index + 1))
    sleep 0.12
  done
  if wait "${pid}"; then status=0; else status=$?; fi
  printf '\r\033[2K\033[?25h'
  if (( status == 0 )); then
    rm -f -- "${log_file}"
    elapsed=$((SECONDS - started))
    if (( elapsed >= 2 )); then
      printf '     %b%s%b %s %b(%ss)%b\n' \
        "${UI_GREEN}${UI_BOLD}" "${UI_G_OK}" "${UI_RESET}" "${label}" "${UI_FAINT}" "${elapsed}" "${UI_RESET}"
      ui_log "ok   ${label} (${elapsed}s)"
    else
      success "${label}"
    fi
    return 0
  fi

  printf '     %b%s%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_G_FAIL}" "${UI_RESET}" "${label}" >&2
  tail -n 120 "${log_file}" >&2 || true
  if [[ -n "${UI_LOG_FILE}" ]]; then
    {
      printf -- 'FAIL %s — output tail:\n' "${label}"
      tail -n 120 "${log_file}"
    } >> "${UI_LOG_FILE}" 2>/dev/null || true
  fi
  rm -f -- "${log_file}"
  return "${status}"
}

format_transfer_bytes() {
  local bytes="${1:-0}" unit=1 suffix="B" tenths
  if (( bytes >= 1073741824 )); then unit=1073741824; suffix="GB"
  elif (( bytes >= 1048576 )); then unit=1048576; suffix="MB"
  elif (( bytes >= 1024 )); then unit=1024; suffix="KB"
  fi
  if (( unit == 1 )); then
    printf '%d B' "${bytes}"
    return
  fi
  tenths=$((bytes * 10 / unit))
  printf '%d.%d %s' "$((tenths / 10))" "$((tenths % 10))" "${suffix}"
}

render_download_progress() {
  local label="$1" current="$2" total="$3" elapsed="$4" percent=0 speed
  (( total > 0 )) && percent=$((current * 100 / total))
  # Held at 99 until the transfer actually ends: a bar that sits at 100% while
  # bytes are still moving teaches an operator to distrust every bar after it.
  if (( current < total && percent > 99 )); then percent=99; fi
  (( percent > 100 )) && percent=100
  (( elapsed > 0 )) && speed=$((current / elapsed)) || speed=0
  printf '\r\033[2K     %s %b%3d%%%b  %b%s / %s%b  %b%s/s%b  %-22.22s' \
    "$(ui_meter "${percent}" 100 24)" \
    "${UI_BOLD}" "${percent}" "${UI_RESET}" \
    "${UI_MUTED}" "$(format_transfer_bytes "${current}")" "$(format_transfer_bytes "${total}")" "${UI_RESET}" \
    "${UI_FAINT}" "$(format_transfer_bytes "${speed}")" "${UI_RESET}" \
    "${label}"
}

download_with_progress() {
  local label="$1" url="$2" destination="$3"
  local headers total=0 log_file pid status=0 started current=0 elapsed=0 tick=0
  headers="$(curl --fail --silent --show-error --location --head --max-time 30 "${url}" 2>/dev/null || true)"
  total="$(printf '%s\n' "${headers}" | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" && $2 ~ /^[0-9]+$/ { size=$2 } END { print size+0 }')"
  log_file="$(mktemp /tmp/orcasynapse-download.XXXXXX)"
  ui_register_temp_file "${log_file}"
  started="${SECONDS}"
  curl --fail --silent --show-error --location --retry 3 --max-time "${UI_DOWNLOAD_MAX_TIME:-1800}" \
    "${url}" --output "${destination}" 2>"${log_file}" &
  pid=$!
  if (( UI_INTERACTIVE )); then printf '\033[?25l'; else info "${label}"; fi
  while kill -0 "${pid}" 2>/dev/null; do
    current="$(stat -c '%s' "${destination}" 2>/dev/null || printf '0')"
    elapsed=$((SECONDS - started))
    if (( UI_INTERACTIVE )); then
      if (( total > 0 )); then
        render_download_progress "${label}" "${current}" "${total}" "${elapsed}"
      else
        render_activity_progress "${label}" "${elapsed}" "${tick}"
      fi
    fi
    tick=$((tick + 1))
    sleep 0.12
  done
  if wait "${pid}"; then status=0; else status=$?; fi
  current="$(stat -c '%s' "${destination}" 2>/dev/null || printf '0')"
  elapsed=$((SECONDS - started))
  if (( UI_INTERACTIVE )); then
    if (( status == 0 )); then
      (( total > 0 )) || total="${current}"
      render_download_progress "${label}" "${total}" "${total}" "${elapsed}"
    fi
    printf '\r\033[2K\033[?25h'
  fi
  if (( status != 0 )); then
    printf '     %b%s%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_G_FAIL}" "${UI_RESET}" "${label}" >&2
    tail -n 40 "${log_file}" >&2 || true
    ui_log "FAIL ${label}"
    rm -f -- "${log_file}"
    return "${status}"
  fi
  rm -f -- "${log_file}"
  success "${label} ($(format_transfer_bytes "${current}") transferred)."
}

# Panels. The signature is unchanged from the bracketed-ASCII generation so
# every call site keeps working; only the ink is different. `edge` is still
# accepted and still selects a heavier rule, which is how a completion panel
# distinguishes itself from an informational one.
ui_panel_rule() {
  local color="$1" edge="${2:-=}" glyph="${UI_G_RULE}" width
  [[ "${edge}" == "=" ]] && glyph="${UI_G_RULE_HEAVY}"
  width="$(ui_width)"
  printf '  %b%s%b\n' "${color}" "$(ui_repeat "${glyph}" "${width}")" "${UI_RESET}"
}

ui_panel_begin() {
  local color="$1" title="$2" edge="${3:-=}"
  printf '\n'
  printf '  %b%s%b  %b%s%b\n' "${color}${UI_BOLD}" "${UI_G_MARK}" "${UI_RESET}" "${UI_BOLD}" "${title}" "${UI_RESET}"
  ui_panel_rule "${color}" "${edge}"
}

ui_panel_kv() {
  printf '  %b%-22s%b %s\n' "${UI_MUTED}" "$1" "${UI_RESET}" "$2"
}

ui_panel_line() {
  printf '  %s\n' "$1"
}

ui_panel_end() {
  local color="$1" edge="${2:-=}"
  ui_panel_rule "${color}" "${edge}"
  printf '\n'
}

# The closing note of a successful run. Distinct from a panel because it is the
# one thing an operator is looking for when they come back to the terminal.
ui_complete() {
  local title="$1" width
  width="$(ui_width)"
  printf '\n  %b%s%b\n' "${UI_GREEN}" "$(ui_repeat "${UI_G_RULE_HEAVY}" "${width}")" "${UI_RESET}"
  printf '  %b%s  %s%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_G_OK}" "${title}" "${UI_RESET}"
  printf '  %b%s%b\n' "${UI_GREEN}" "$(ui_repeat "${UI_G_RULE_HEAVY}" "${width}")" "${UI_RESET}"
  ui_log "complete ${title}"
}

ui_next() {
  printf '\n  %b%s NEXT%b  %s\n\n' "${UI_ACCENT}${UI_BOLD}" "${UI_G_MARK}" "${UI_RESET}" "$1"
  ui_log "next ${1}"
}

# Resolves the release version from the extracted tree when available. Scripts
# that run standalone (outside a release tree) fall back to "unknown" and
# should prefer their own INSTALLER_VERSION constant.
installer_release_version() {
  local version_file="${ORCASYNAPSE_ROOT:-}/packages/contracts/src/version.ts" version=""
  if [[ -n "${ORCASYNAPSE_ROOT:-}" && -r "${version_file}" ]]; then
    version="$(sed -nE 's/.*ORCASYNAPSE_VERSION = "([^"]+)".*/\1/p' "${version_file}" | head -n 1)"
  fi
  printf '%s' "${version:-unknown}"
}
# <<< ORCASYNAPSE-INSTALLER-UI <<<

UI_ACCENT="${UI_RED}"
UI_ACCENT_SOFT="${UI_RED_SOFT}"
UI_BANNER_TAGLINE="AGENTIC SYSTEM  /  VM2 SECURE DECOMMISSION"
UI_BANNER_META="Remover ${INSTALLER_VERSION}"

validate_state_root() {
  local label="$1" path="$2"
  # `/*/*` alone is not "two levels deep": the trailing `*` matches the empty
  # string, so `/var/` and `/etc/` both pass it and reach `rm -rf`. Requiring a
  # non-slash character after the second slash is what the message has always
  # claimed. A trailing slash is stripped first so `/var/lib/x/` still works.
  path="${path%/}"
  # `//` is rejected explicitly: `/*/?*` alone matches `///etc` and `//x`,
  # because `*` and `?` both match a slash. Those collapse to `/etc` and `/x`,
  # so the earlier trailing-slash fix closed one shape of the same hole and
  # left another that still reached `rm -rf`.
  [[ "${path}" == /*/?* && "${path}" != *..* && "${path}" != *//* ]] \
    || fail "unsafe ${label} state path '${path}'; an absolute path at least two levels deep is required"
  [[ ! -L "${path}" ]] || fail "refusing to traverse a symbolic-link ${label} state root"
}

require_safe_host() {
  [[ "${EUID}" -eq 0 ]] || fail "run the decommissioner as root"
  [[ -r /etc/os-release ]] || fail "this host does not expose operating-system identity"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "the managed Agentic System remover supports Ubuntu VM2 hosts only"
  [[ -d /run/systemd/system ]] || fail "systemd is not active on this host"
  validate_state_root "Hermes" "${STATE_ROOT}"
  if [[ "${STATE_ROOT}" != "/var/lib/orcasynapse-hermes" ]]; then
    warning "Removing a non-default state layout: ${STATE_ROOT}"
  fi
}

managed_install_exists() {
  [[ -e "${STATE_ROOT}" \
    || -e "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" \
    || -e "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" \
    || -e "/etc/systemd/system/${DESIRED_STATE_SERVICE}.service" \
    || -e "/etc/systemd/system/${DESIRED_STATE_SERVICE}.timer" \
    || -e "/etc/systemd/system/${CORPUS_SERVICE}.service" \
    || -e "/etc/systemd/system/${CORPUS_SERVICE}.timer" \
    || -e "/etc/systemd/system/${ARTIFACT_SERVICE}.service" \
    || -e "/etc/systemd/system/${ARTIFACT_SERVICE}.timer" \
    || -e "${HEARTBEAT_CLIENT}" \
    || -e "${DESIRED_STATE_CLIENT}" \
    || -e "${CORPUS_CLIENT}" \
    || -e "${ARTIFACT_CLIENT}" ]] && return 0
  [[ -e "/etc/systemd/system/${RUNTIME_SERVICE}.service" || -e "${HERMES_INSTALL_DIR}" ]]
}

# Proves this is our runtime before anything irreversible happens.
#
# The container path checked an `io.orcasynapse.managed=true` label and the
# /opt/data mount. The unit carries the same two facts: the marker the installer
# writes into [Unit], and a ReadWritePaths= naming this state root. Either one
# is sufficient and both are things only our installer writes, so a Hermes
# someone set up by hand -- with no unit, or a unit of their own -- is never
# mistaken for ours and destroyed.
# Positive proof that OrcaSynapse installed what we are about to delete.
#
# Distinct from validate_service_ownership, which only refuses a unit that is
# demonstrably *not* ours. Absence of a unit is not evidence of ownership, and
# the Hermes program lives at the same path whether we installed it or the
# operator did -- so deleting it needs a reason, not merely the lack of an
# objection. Either artefact below is created solely by our installer.
# Captured once, before anything is deleted, because both pieces of evidence are
# themselves removed during the purge.
RUNTIME_IS_OURS=0

managed_ownership_proof() {
  # One artefact, written by the installer only after it has itself installed
  # the Hermes program and verified the commit pin.
  #
  # Two weaker signals were tried and both are wrong. The unit file is deleted
  # by the step that later consults this, so its marker can never be seen. And
  # the node identity is created in step 3 -- *before* step 4 discovers a
  # pre-existing Hermes and tells the operator to decommission -- so treating it
  # as proof destroys exactly the installation this guard exists to protect.
  # The marker the installer writes after installing and pin-verifying Hermes.
  [[ -e "${STATE_ROOT}/runtime-owned" ]] && return 0
  # Nodes enrolled before that marker existed carry no such file, and refusing
  # to decommission every one of them is not an option. Their unit still has the
  # managed marker, which only our installer writes -- but it is deleted during
  # the purge, so this must be evaluated before the purge starts.
  local unit="/etc/systemd/system/${RUNTIME_SERVICE}.service"
  [[ -e "${unit}" ]] && grep -Fq "X-OrcaSynapse-Managed=true" "${unit}" && return 0
  return 1
}

validate_service_ownership() {
  local unit="/etc/systemd/system/${RUNTIME_SERVICE}.service"
  [[ -e "${unit}" ]] || return 0
  if grep -Fq "X-OrcaSynapse-Managed=true" "${unit}"     || grep -Fq "ReadWritePaths=${STATE_ROOT}" "${unit}"; then
    return 0
  fi
  fail "a '${RUNTIME_SERVICE}' service exists but is not identifiable as OrcaSynapse-managed; refusing to remove it"
}

confirm_destruction() {
  cat <<EOF

  ${UI_RED}${UI_BOLD}PERMANENT HOST-SIDE DESTRUCTION${UI_RESET}
  This removes only OrcaSynapse-managed Agentic System resources:

    - Hermes runtime service, and the program under /usr/local it installed
    - Node identity, enrollment state, managed policy, and runtime data
    - Signed-heartbeat service and timer
    - Toolset desired-state reconciler service and timer
    - Hermes corpus observability reconciler service and timer
    - The ${HERMES_USER} service account

  Ubuntu packages, unrelated services, the Python and Node runtimes Hermes
  installed for itself, and external backups are preserved. Storage snapshots
  must be retired under your own policy.
EOF
  [[ -r /dev/tty ]] || fail "an interactive terminal is required for destructive confirmation"
  local confirmation
  printf '\n  Type %bDESTROY%b to continue: ' "${UI_RED}${UI_BOLD}" "${UI_RESET}" > /dev/tty
  IFS= read -r confirmation < /dev/tty
  [[ "${confirmation}" == "DESTROY" ]] || fail "decommission cancelled; no resources were changed"
}

stop_managed_services() {
  # The target first. It Wants the other four, so leaving it enabled while they
  # are stopped one at a time gives systemd a reason to pull them back up.
  # Tolerated like everything else here: a node enrolled before the target
  # existed simply has none.
  systemctl disable --now "${NODE_TARGET}.target" >/dev/null 2>&1 || true
  # Then the runtime: the timers only report on and reconcile it, so stopping
  # them first would leave the reconciler free to restart what we just stopped.
  systemctl disable --now "${RUNTIME_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl disable --now "${HEARTBEAT_SERVICE}.timer" >/dev/null 2>&1 || true
  systemctl stop "${HEARTBEAT_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl disable --now "${DESIRED_STATE_SERVICE}.timer" >/dev/null 2>&1 || true
  systemctl stop "${DESIRED_STATE_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl disable --now "${CORPUS_SERVICE}.timer" >/dev/null 2>&1 || true
  systemctl stop "${CORPUS_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl disable --now "${ARTIFACT_SERVICE}.timer" >/dev/null 2>&1 || true
  systemctl stop "${ARTIFACT_SERVICE}.service" >/dev/null 2>&1 || true

  # Every call above tolerates failure, so success has to be checked rather than
  # assumed. A stop job that hangs or times out would otherwise be reported as
  # stopped, and the steps after this delete the unit file and the program out
  # from under a live process -- leaving Hermes listening on 8642 with its
  # credentials in memory and no unit left to stop it.
  if systemctl is-active --quiet "${RUNTIME_SERVICE}.service"; then
    fail "the ${RUNTIME_SERVICE} service is still active after a stop request; resolve that before destroying its files"
  fi
  success "Managed heartbeat services stopped."
}

remove_hermes_runtime() {
  if [[ -e "/etc/systemd/system/${NODE_TARGET}.target" ]]; then
    rm -f -- "/etc/systemd/system/${NODE_TARGET}.target"
    success "Agentic System node target removed."
  fi
  if [[ -e "/etc/systemd/system/${RUNTIME_SERVICE}.service" ]]; then
    rm -f -- "/etc/systemd/system/${RUNTIME_SERVICE}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
    success "Hermes runtime service removed."
  else
    success "No managed Hermes runtime service remains."
  fi

  # The program itself, which the container path deleted as image layers.
  #
  # Only when we can prove we installed it. Hermes's own installer defaults to
  # exactly ${HERMES_INSTALL_DIR}, so "it is at the managed location" proves
  # nothing -- a Hermes the operator installed for themselves lands in the same
  # place. And the installer actively steers people here: it refuses to enrol a
  # host that already has Hermes and tells them to decommission first. Following
  # that instruction must not destroy an installation we never made.
  if (( RUNTIME_IS_OURS == 0 )); then
    # What is on disk, rather than what the constants say could be there.
    #
    # This used to state as fact that a Hermes installation exists at
    # ${HERMES_INSTALL_DIR}, and hand over an `rm -rf` for it and one launcher,
    # without testing either path. Neither is implied by getting here:
    # managed_install_exists upstream is satisfied by the runtime unit *or* the
    # install directory, so this runs with the directory absent, and the
    # launchers are independent of it again -- a Hermes with `hermes` but no
    # `hermes-acp` is ordinary. A line telling somebody to `rm -rf` a path is
    # the last place to be relaxed about whether the path is real.
    #
    # All four are considered, not just the first two. The purge below removes
    # ${HERMES_BINARY}-agent and -acp as well, so a manual remedy that omits
    # them leaves behind exactly the files this script would have taken.
    local leftovers=() candidate
    for candidate in "${HERMES_INSTALL_DIR}" "${HERMES_BINARY}" "${HERMES_BINARY}-agent" "${HERMES_BINARY}-acp"; do
      [[ -e "${candidate}" ]] && leftovers+=("${candidate}")
    done
    if (( ${#leftovers[@]} == 0 )); then
      success "No Hermes program files remain; nothing here was OrcaSynapse-managed and nothing is left to remove."
      return 0
    fi
    warning "Hermes files exist here but nothing identifies them as OrcaSynapse-managed; leaving them untouched."
    warning "Remove them yourself if they are unwanted: rm -rf ${leftovers[*]}"
    return 0
  fi

  local removed=0
  if [[ -d "${HERMES_INSTALL_DIR}" ]]; then
    rm -rf -- "${HERMES_INSTALL_DIR}"
    removed=1
  fi
  local launcher
  for launcher in "${HERMES_BINARY}" "${HERMES_BINARY}-agent" "${HERMES_BINARY}-acp"; do
    [[ -e "${launcher}" ]] && { rm -f -- "${launcher}"; removed=1; }
  done
  if (( removed )); then
    success "Hermes runtime files removed."
  else
    success "No managed Hermes runtime files remain."
  fi
}

remove_managed_state() {
  rm -f -- \
    "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" \
    "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" \
    "/etc/systemd/system/${DESIRED_STATE_SERVICE}.service" \
    "/etc/systemd/system/${DESIRED_STATE_SERVICE}.timer" \
    "/etc/systemd/system/${CORPUS_SERVICE}.service" \
    "/etc/systemd/system/${CORPUS_SERVICE}.timer" \
    "/etc/systemd/system/${ARTIFACT_SERVICE}.service" \
    "/etc/systemd/system/${ARTIFACT_SERVICE}.timer" \
    "${HEARTBEAT_CLIENT}" \
    "${DESIRED_STATE_CLIENT}" \
    "${CORPUS_CLIENT}" \
    "${ARTIFACT_CLIENT}"
  systemctl daemon-reload
  systemctl reset-failed "${HEARTBEAT_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl reset-failed "${DESIRED_STATE_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl reset-failed "${CORPUS_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl reset-failed "${ARTIFACT_SERVICE}.service" >/dev/null 2>&1 || true

  rm -rf --one-file-system -- "${STATE_ROOT}"
  [[ ! -e "${STATE_ROOT}" ]] \
    || fail "the managed state root could not be removed; check for a mounted filesystem and rerun"
  rmdir /usr/local/lib/orcasynapse >/dev/null 2>&1 || true
  rm -rf -- "${HERMES_MANAGED_DIR}"

  # The account owned nothing but the state root that just went, so it is an
  # orphan now. Left behind, a re-enrollment would silently reuse a UID whose
  # history nobody can account for.
  if id -u "${HERMES_USER}" >/dev/null 2>&1; then
    userdel "${HERMES_USER}" >/dev/null 2>&1       || warning "The ${HERMES_USER} service account could not be removed; delete it by hand."
  fi
  success "Identity keys, runtime state, managed policy, units, and the service account removed."
}

main() {
  [[ "$#" -eq 0 ]] || fail "this command accepts no arguments"
  banner

  step 1 4 "Inventory the managed installation"
  require_safe_host
  validate_service_ownership
  # Before confirm_destruction, so the panel below can tell the operator what
  # will and will not be removed rather than surprising them mid-purge.
  managed_ownership_proof && RUNTIME_IS_OURS=1
  if ! managed_install_exists; then
    success "No OrcaSynapse-managed Agentic System installation was found."
    printf '\n%b  NOTHING TO REMOVE%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
    exit 0
  fi
  success "Managed VM2 resources found; unrelated host resources are outside scope."

  step 2 4 "Authorize irreversible destruction"
  confirm_destruction
  success "Destruction explicitly authorized."

  step 3 4 "Stop and remove Agentic System services"
  stop_managed_services
  remove_hermes_runtime

  step 4 4 "Purge node identity and durable memory"
  remove_managed_state

  ui_panel_begin "${UI_GREEN}" "AGENTIC SYSTEM REMOVED FROM THIS VM"
  ui_panel_kv 'Remover' "${INSTALLER_VERSION}"
  ui_panel_end "${UI_GREEN}"
  warning "This host can no longer authenticate to OrcaSynapse. Remove the revoked node from the dashboard to finish control-plane cleanup."
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
