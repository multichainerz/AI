#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

INSTALLER_VERSION="v4.7.0"
STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
HERMES_HOME_DIR="${STATE_ROOT}/home"
RUNTIME_SERVICE="orcasynapse-hermes"
HEARTBEAT_SERVICE="orcasynapse-hermes-heartbeat"
DESIRED_STATE_SERVICE="orcasynapse-hermes-desired-state"
CORPUS_SERVICE="orcasynapse-hermes-corpus"
# Hermes runs as an unprivileged service account rather than a container
# identity. The name is the unit name so `systemctl`, `journalctl` and `ps` all
# agree about what is running.
HERMES_USER="orcasynapse-hermes"
# Where the Hermes installer puts a root install, and the managed policy layer
# that outranks anything the service account can write.
HERMES_INSTALL_DIR="/usr/local/lib/hermes-agent"
HERMES_BINARY="/usr/local/bin/hermes"
HERMES_PYTHON="${HERMES_INSTALL_DIR}/venv/bin/python"
HERMES_MANAGED_DIR="/etc/hermes"
HERMES_INSTALL_URL="${ORCASYNAPSE_HERMES_INSTALL_URL:-https://hermes-agent.nousresearch.com/install.sh}"
ENROLLMENT_STATE="${STATE_ROOT}/enrollment-state.json"
TEMPORARY_FILES=()
RESOLVED_BUNDLE=""
INSTALLATION_COMPLETED=0
REPAIR_RUNTIME_WAS_ACTIVE=0
REPAIR_COMPLETED=0

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

UI_ACCENT="${UI_CYAN}"
UI_ACCENT_SOFT="${UI_CYAN_SOFT}"
UI_BANNER_TAGLINE="AGENTIC SYSTEM  /  VM2 SECURE ENROLLMENT"
UI_BANNER_ACTIVITY="Establishing node enrollment context"
UI_BANNER_META="Installer ${INSTALLER_VERSION}"

# Track helper temp files in this script's EXIT cleanup.
ui_register_temp_file() {
  TEMPORARY_FILES+=("$1")
}

cleanup() {
  local status=$?
  (( UI_INTERACTIVE )) && printf '\033[?25h'
  local file
  for file in "${TEMPORARY_FILES[@]:-}"; do
    [[ -z "${file}" || ! -e "${file}" ]] || rm -f -- "${file}"
  done
  if (( status != 0 )) && [[ -s "${ENROLLMENT_STATE}" ]] && (( INSTALLATION_COMPLETED == 0 )); then
    printf '\n%b[RECOVERY]%b Protected enrollment state was retained. Rerun the same installer command to resume safely.\n' \
      "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  fi
  if (( status != 0 && REPAIR_RUNTIME_WAS_ACTIVE == 1 && REPAIR_COMPLETED == 0 )); then
    systemctl start "${RUNTIME_SERVICE}" >/dev/null 2>&1 \
      || printf '%s\n' "[RECOVERY] The Hermes service was active before repair but could not be restarted automatically." >&2
  fi
  return "${status}"
}
trap cleanup EXIT

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "run the installer as root (for example: sudo ./install-agentic-node.sh enrollment.json)"
}

require_ubuntu_host() {
  [[ -r /etc/os-release ]] || fail "VM2 must run Ubuntu with a readable /etc/os-release"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "VM2 must run Ubuntu; detected '${PRETTY_NAME:-unknown operating system}'"
  [[ -n "${VERSION_ID:-}" ]] || fail "the Ubuntu release version could not be identified"
  # Ubuntu LTS is the April release of an even year. VERSION_ID was read and
  # checked non-empty but never compared, so a 9-month interim release passed --
  # a shorter support window than this product's own.
  local ubuntu_major="${VERSION_ID%%.*}" ubuntu_minor="${VERSION_ID##*.}"
  [[ "${ubuntu_minor}" == "04" && "${ubuntu_major}" =~ ^[0-9]+$ ]]     && (( ubuntu_major >= 22 )) && (( ubuntu_major % 2 == 0 ))     || fail "VM2 must run an Ubuntu LTS release of 22.04 or later; detected '${PRETTY_NAME:-Ubuntu ${VERSION_ID}}'"
  [[ -d /run/systemd/system ]] || fail "VM2 must be an Ubuntu systemd VM, not a minimal container userland"
  case "$(uname -m)" in
    x86_64|aarch64) ;;
    *) fail "VM2 architecture '$(uname -m)' is unsupported; use x86_64 or aarch64 Ubuntu" ;;
  esac
  validate_state_root "${STATE_ROOT}"
}

# The installer chmods and populates this path, and the decommissioner later
# deletes it recursively. A one-level root like `/var/` would re-permission a
# system directory to 0711 on install and be handed to `rm -rf` on removal, so
# it is refused on the way in rather than only on the way out.
validate_state_root() {
  local path="${1%/}"
  # `//` is rejected explicitly: `/*/?*` alone matches `///etc` and `//x`,
  # because `*` and `?` both match a slash. Those collapse to `/etc` and `/x`,
  # so the earlier trailing-slash fix closed one shape of the same hole and
  # left another that still reached `rm -rf`.
  [[ "${path}" == /*/?* && "${path}" != *..* && "${path}" != *//* ]] \
    || fail "unsafe Hermes state path '${1}'; an absolute path at least two levels deep is required"
  [[ ! -L "${path}" ]] || fail "refusing to use a symbolic-link Hermes state root"
}

install_hermes_directory() {
  local mode="$1" destination="$2"
  install -d -m "${mode}" "${destination}"
  chown "${HERMES_USER}:${HERMES_USER}" "${destination}"
}

# A system account with no login shell. Its passwd home is an intentionally
# small, writable directory inside ${STATE_ROOT}: upstream Hermes uses the OS
# home as the fallback terminal working directory, while ProtectHome makes the
# conventional /home tree inaccessible inside the service sandbox.
create_service_account() {
  if id -u "${HERMES_USER}" >/dev/null 2>&1; then
    local current_home
    current_home="$(getent passwd "${HERMES_USER}" | cut -d: -f6)"
    if [[ "${current_home}" != "${HERMES_HOME_DIR}" ]]; then
      usermod --home "${HERMES_HOME_DIR}" --shell /usr/sbin/nologin "${HERMES_USER}" \
        || fail "could not reconcile the ${HERMES_USER} service account home"
      info "Reconciled the existing ${HERMES_USER} service account home."
    else
      info "Reusing the existing ${HERMES_USER} service account."
    fi
    return 0
  fi
  useradd --system --no-create-home --home-dir "${HERMES_HOME_DIR}" \
    --shell /usr/sbin/nologin "${HERMES_USER}" \
    || fail "could not create the ${HERMES_USER} service account"
}

write_file_from_stdin() {
  local mode="$1" owner="$2" group="$3" destination="$4" parent temporary
  parent="${destination%/*}"
  [[ -d "${parent}" ]] || fail "managed-file parent directory '${parent}' does not exist"
  temporary="$(mktemp "${parent}/.orcasynapse-write.XXXXXX")" \
    || fail "could not create a protected temporary file in '${parent}'"
  TEMPORARY_FILES+=("${temporary}")
  cat > "${temporary}" || fail "could not write managed file '${destination}'"
  chmod "${mode}" "${temporary}"
  chown "${owner}:${group}" "${temporary}"
  mv -f -- "${temporary}" "${destination}" \
    || fail "could not atomically replace managed file '${destination}'"
}

install_hermes_file_from_stdin() {
  local mode="$1" destination="$2"
  write_file_from_stdin "${mode}" "${HERMES_USER}" "${HERMES_USER}" "${destination}"
}

write_hermes_managed_policy() {
  local model_alias_json="$1" model_base_url_json="$2"
  install -d -m 0755 "${HERMES_MANAGED_DIR}"
  chown root:root "${HERMES_MANAGED_DIR}"
  write_file_from_stdin 0644 root root "${HERMES_MANAGED_DIR}/config.yaml" <<EOF
model:
  provider: custom
  default: ${model_alias_json}
  base_url: ${model_base_url_json}
  api_key: \${OPENAI_API_KEY}
terminal:
  # Keep Hermes work inside the service account's managed, writable home. This
  # is the canonical replacement for the deprecated MESSAGING_CWD environment.
  cwd: ${HERMES_HOME_DIR}
# Hermes owns agent memory and session continuity. The runtime uses these files
# directly; OrcaSynapse only receives the bounded corpus mirror and sends
# conflict-safe mutations back through Hermes-native APIs.
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
  nudge_interval: 10
  flush_min_turns: 6
# Hermes otherwise falls back to its broad api_server platform preset. Keep
# the production baseline limited to native memory (and no dynamically
# configured MCP servers) until OrcaSynapse explicitly distributes and verifies
# another governed toolset.
platform_toolsets:
  api_server:
    - no_mcp
    - memory
security:
  redact_secrets: true
  allow_lazy_installs: false
tool_loop_guardrails:
  hard_stop_enabled: true
  hard_stop_after:
    exact_failure: 5
    idempotent_no_progress: 5
EOF
}

# Reconciles the workspace and introduces Hermes-native memory on an existing
# OrcaSynapse-managed policy. Repair mode must preserve the enrolled model route
# and guardrails rather than regenerate them from secrets.
reconcile_managed_runtime_policy() {
  local config="${HERMES_MANAGED_DIR}/config.yaml" rendered
  [[ -s "${config}" ]] || fail "the OrcaSynapse-managed Hermes policy is missing"
  rendered="$(python3 - "${config}" "${HERMES_HOME_DIR}" <<'PYTHON'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
cwd = sys.argv[2]
lines = path.read_text().splitlines()
output = []
inside_terminal = False
terminal_seen = False
cwd_written = False

for line in lines:
    if re.fullmatch(r"terminal:\s*", line):
        terminal_seen = True
        inside_terminal = True
        cwd_written = False
        output.append(line)
        continue
    if inside_terminal and line and not line[0].isspace() and not line.startswith("#"):
        if not cwd_written:
            output.append(f"  cwd: {cwd}")
        inside_terminal = False
    if inside_terminal and re.match(r"^\s+cwd\s*:", line):
        if not cwd_written:
            output.append(f"  cwd: {cwd}")
            cwd_written = True
        continue
    output.append(line)

if inside_terminal and not cwd_written:
    output.append(f"  cwd: {cwd}")
if not terminal_seen:
    if output and output[-1] != "":
        output.append("")
    output.extend(["terminal:", f"  cwd: {cwd}"])

managed_memory = [
    "memory:",
    "  memory_enabled: true",
    "  user_profile_enabled: true",
    "  memory_char_limit: 2200",
    "  user_char_limit: 1375",
    "  nudge_interval: 10",
    "  flush_min_turns: 6",
]
memory_index = next((index for index, line in enumerate(output) if re.fullmatch(r"memory:\s*", line)), None)
if memory_index is None:
    if output and output[-1] != "":
        output.append("")
    output.append("# Hermes owns MEMORY.md and USER.md inside its isolated home.")
    output.extend(managed_memory)
else:
    # Replace the whole root memory block. In particular, remove any external
    # provider left by manual drift: this product mode is vanilla built-in
    # MEMORY.md / USER.md only, not built-in plus a second memory owner.
    memory_end = memory_index + 1
    while memory_end < len(output) and (
        output[memory_end] == "" or output[memory_end][0].isspace()
    ):
        memory_end += 1
    output[memory_index:memory_end] = managed_memory

sys.stdout.write("\n".join(output) + "\n")
PYTHON
)" || fail "the managed Hermes runtime policy could not be reconciled"
  write_file_from_stdin 0644 root root "${config}" <<<"${rendered}"
}

# Installs Hermes from its own installer, pinned to a commit.
#
# Root install, so it lands in the FHS layout at /usr/local/lib/hermes-agent
# with the launcher at /usr/local/bin/hermes.
install_hermes_runtime() {
  local commit="$1"
  # Relaxed umask, in a subshell so it never leaks into the secret handling.
  #
  # This script runs under `umask 077` so anything it writes is root-only --
  # right for keys and enrollment state, wrong for a program. The upstream
  # installer inherits that umask and finishes with `chmod +x`, which only adds
  # the bits the umask permits, so the launcher landed at 0700 root and systemd
  # failed the unit with 203/EXEC: the unprivileged service account could not
  # execute its own runtime. Hermes is code under /usr/local, not a secret.
  #
  # `--force-commit` is required, not defensive. Upstream deliberately ignores
  # `--commit` when the existing checkout is already newer -- it logs "Ignoring
  # --commit ...: the checkout is already newer" and carries on -- so without
  # the override a host that already has a newer Hermes silently keeps it, and
  # the commit the control plane approved is not the commit that runs. On this
  # node OrcaSynapse decides the revision, including downgrades to an older
  # approved one, and the readback below is what proves it took.
  (
    umask 022
    curl -fsSL "${HERMES_INSTALL_URL}"       | bash -s -- --skip-browser --skip-setup --non-interactive       --commit "${commit}" --force-commit
  )
}

# The unit that replaces `docker run`, flag for flag and then some.
#
# Every container hardening option has a systemd equivalent here; the last three
# have no Docker counterpart we were using at all. The runtime is confined to
# its own state directory and can read the managed policy but never write it,
# which is what the read-only bind mount used to buy.
write_hermes_runtime_unit() {
  write_file_from_stdin 0644 root root "/etc/systemd/system/${RUNTIME_SERVICE}.service" <<EOF
[Unit]
Description=OrcaSynapse-managed Hermes agent runtime
Documentation=https://github.com/multichainerz/AI
After=network-online.target
Wants=network-online.target
# Proof of ownership for the decommissioner, which refuses to destroy a runtime
# it cannot identify as ours.
X-OrcaSynapse-Managed=true

[Service]
Type=simple
User=${HERMES_USER}
Group=${HERMES_USER}
WorkingDirectory=${HERMES_HOME_DIR}
ExecStart=${HERMES_BINARY} gateway run
Restart=always
RestartSec=5s

Environment=HERMES_HOME=${STATE_ROOT}/data
Environment=HOME=${HERMES_HOME_DIR}
Environment=HERMES_MANAGED_DIR=${HERMES_MANAGED_DIR}
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_HOST=0.0.0.0
Environment=API_SERVER_PORT=8642
# The gateway key is deliberately NOT an Environment= line: a unit file is 0644
# by convention, and that would publish the credential that authenticates every
# governed call to port 8642 to any local reader. It lives in the 0600 env file
# below, which systemd reads as root before dropping to ${HERMES_USER}.
#
# No leading '-': if that file is missing the unit must fail rather than start a
# gateway on 0.0.0.0:8642 with no key set.
EnvironmentFile=${STATE_ROOT}/data/.env

MemoryMax=${HERMES_MEMORY_LIMIT:-4G}
CPUQuota=${HERMES_CPU_QUOTA:-200%}
TasksMax=512

NoNewPrivileges=yes
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_SETGID CAP_SETUID
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=true
ReadWritePaths=${STATE_ROOT}/data ${HERMES_HOME_DIR}
ReadOnlyPaths=${HERMES_MANAGED_DIR}
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

install_host_dependencies() {
  require_ubuntu_host
  # git, curl and xz-utils are what the Hermes installer requires of the host;
  # it brings its own Python, Node and uv. python3 and jq are ours: the
  # desired-state reconciler this script writes reconciles the toolset allowlist
  # with a python3 block, and without it a node enrolls, reports Healthy, and
  # silently never applies a toolset the operator admitted.
  if ! command -v git >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1     || ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1     || ! command -v xz >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    run_with_progress "Refresh operating-system packages" apt-get update       || fail "could not refresh Ubuntu package metadata"
    run_with_progress "Install runtime security dependencies" env DEBIAN_FRONTEND=noninteractive       apt-get install -y ca-certificates curl git jq openssl python3 xz-utils       || fail "could not install the runtime security dependencies"
  fi

  # Everything this installer runs, and everything the heartbeat and
  # desired-state scripts it writes will run later. The second group is the one
  # that matters: those fail on a timer, hours after anyone is watching.
  local required_command
  for required_command in install chown useradd journalctl sha256sum awk sed grep date hostname mktemp cat chmod mv \
    python3 base64 cmp tr paste; do
    command -v "${required_command}" >/dev/null 2>&1 \
      || fail "the Ubuntu host is missing required command '${required_command}'"
  done
}

validate_bundle() {
  local bundle="$1"
  [[ -r "${bundle}" ]] || fail "the enrollment bundle is not readable"
  [[ "$(jq -r '.format // empty' "${bundle}")" == "orcasynapse-hermes-enrollment/v1" ]] \
    || fail "the enrollment bundle format is unsupported"
  jq -e '
    (.nodeId | type == "string") and
    (.nodeSlug | type == "string") and
    (.token | type == "string" and length >= 32) and
    (.controlPlaneUrl | test("^https?://")) and
    (.hermesBaseUrl | test("^https?://")) and
    (.hermesCommit | test("^[0-9a-f]{40}$")) and
    (.expiresAt | type == "string")
  ' "${bundle}" >/dev/null || fail "the enrollment bundle is incomplete"

  local expires_at expires_epoch
  expires_at="$(jq -r '.expiresAt' "${bundle}")"
  expires_epoch="$(date --date="${expires_at}" '+%s' 2>/dev/null)" || fail "the enrollment expiry is invalid"
  (( expires_epoch > $(date '+%s') )) || fail "the enrollment bundle has expired; issue a new invitation in OrcaSynapse"
}

validate_resume_state() {
  local state_file="$1"
  [[ -r "${state_file}" ]] || return 1
  jq -e '
    (.format == "orcasynapse-hermes-resume/v1") and
    (.nodeId | type == "string" and length > 0) and
    (.controlPlaneUrl | test("^https?://")) and
    (.hermesBaseUrl | test("^https?://")) and
    (.hermesCommit | test("^[0-9a-f]{40}$")) and
    (.hostname | type == "string" and length > 0) and
    (.apiKey | type == "string" and length >= 32) and
    ((.identityFingerprint == null) or (.identityFingerprint | test("^[a-f0-9]{64}$"))) and
    ((.heartbeatPath == null) or (((.heartbeatPath | type) == "string") and (.heartbeatPath | startswith("/")) and ((.heartbeatPath | startswith("//")) | not))) and
    ((.desiredStatePath == null) or (((.desiredStatePath | type) == "string") and (.desiredStatePath | startswith("/")) and ((.desiredStatePath | startswith("//")) | not))) and
    (.modelBootstrap.baseUrl | test("^https?://")) and
    (.modelBootstrap.modelAlias | type == "string" and length > 0) and
    (.modelBootstrap.apiKey | type == "string" and length > 0)
  ' "${state_file}" >/dev/null
}

# Enrollment returns control-plane-relative paths so VM2 does not have to know
# the API's routing layout. Older receipts predate those fields, hence the
# explicit compatibility fallback; any path that is supplied must still be a
# single-origin URL path rather than a second authority or a fragment.
resolve_control_plane_path() {
  local supplied="$1" fallback="$2" label="$3" path
  path="${supplied:-${fallback}}"
  [[ "${path}" =~ ^/[^[:space:]#]*$ && "${path}" != //* ]] \
    || fail "OrcaSynapse returned an invalid ${label} path"
  printf '%s' "${path}"
}

resolve_bundle_from_orcasynapse() {
  local control_plane_url="$1"
  control_plane_url="${control_plane_url%/}"
  [[ "${control_plane_url}" =~ ^https?://[^/?#]+$ ]] \
    || fail "--connect must be an OrcaSynapse origin without a path, query, or fragment"

  local token=""
  if [[ -n "${ORCASYNAPSE_ENROLLMENT_TOKEN_FILE:-}" ]]; then
    [[ -r "${ORCASYNAPSE_ENROLLMENT_TOKEN_FILE}" ]] || fail "ORCASYNAPSE_ENROLLMENT_TOKEN_FILE is not readable"
    token="$(tr -d '\r\n' < "${ORCASYNAPSE_ENROLLMENT_TOKEN_FILE}")"
  else
    [[ -r /dev/tty && -w /dev/tty ]] \
      || fail "a terminal is required to enter the one-time claim; alternatively set ORCASYNAPSE_ENROLLMENT_TOKEN_FILE"
    printf '\n%bSECURE CLAIM%b\n' "${UI_CYAN}${UI_BOLD}" "${UI_RESET}" > /dev/tty
    printf 'Paste the one-time claim shown by OrcaSynapse (input hidden): ' > /dev/tty
    IFS= read -r -s token < /dev/tty
    printf '\n' > /dev/tty
  fi
  [[ ${#token} -ge 32 ]] || fail "the one-time enrollment claim is incomplete"

  local request_file response_file http_status returned_control_plane
  request_file="$(mktemp)"
  response_file="$(mktemp)"
  TEMPORARY_FILES+=("${request_file}" "${response_file}")
  jq -n --arg token "${token}" '{token:$token}' > "${request_file}"
  token=""
  http_status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' --data-binary "@${request_file}" \
    "${control_plane_url}/api/v1/runtime-nodes/bootstrap")"
  if [[ "${http_status}" != "200" ]]; then
    fail "OrcaSynapse rejected the bootstrap claim (HTTP ${http_status}): $(jq -r '.message // "unknown error"' "${response_file}" 2>/dev/null)"
  fi

  validate_bundle "${response_file}"
  returned_control_plane="$(jq -r '.controlPlaneUrl' "${response_file}" | sed 's:/*$::')"
  [[ "${returned_control_plane}" == "${control_plane_url}" ]] \
    || fail "OrcaSynapse returned a bundle bound to a different control-plane origin"
  RESOLVED_BUNDLE="${response_file}"
}

sign_node_payload() {
  local body="$1" timestamp="$2" nonce="$3"
  local body_digest message_file signature sign_status=0
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  message_file="$(mktemp /tmp/orcasynapse-node-signature.XXXXXX)"
  printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}" > "${message_file}"
  signature="$(
    openssl pkeyutl -sign -rawin \
      -inkey "${STATE_ROOT}/identity/node.key" \
      -in "${message_file}" \
      | openssl base64 -A \
      | tr '+/' '-_' \
      | tr -d '='
  )" || sign_status=$?
  rm -f -- "${message_file}"
  (( sign_status == 0 )) || return "${sign_status}"
  printf '%s' "${signature}"
}

public_identity_fingerprint() {
  openssl pkey -pubin -in "${STATE_ROOT}/identity/node.pub" -outform DER 2>/dev/null \
    | sha256sum \
    | awk '{print $1}'
}

private_identity_fingerprint() {
  openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -outform DER 2>/dev/null \
    | sha256sum \
    | awk '{print $1}'
}

verify_enrolled_identity() {
  local node_id="$1" control_plane_url="$2" hermes_commit="$3" node_fingerprint="$4" heartbeat_path="$5"
  local observed_at node_status payload nonce signature response_file http_status response_error
  node_status="DEGRADED"
  if curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null; then
    node_status="ONLINE"
  fi
  observed_at="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  payload="$(jq -cS -n \
    --arg observedAt "${observed_at}" \
    --arg status "${node_status}" \
    --arg version "${hermes_commit}" \
    '{observedAt:$observedAt,status:$status,hermesVersion:$version,capabilities:["gateway-api","signed-heartbeat"]}')"
  nonce="$(cat /proc/sys/kernel/random/uuid)"
  signature="$(sign_node_payload "${payload}" "${observed_at}" "${nonce}")"
  response_file="$(mktemp)"
  TEMPORARY_FILES+=("${response_file}")
  http_status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' \
    -H "X-OrcaSynapse-Node-Timestamp: ${observed_at}" \
    -H "X-OrcaSynapse-Node-Nonce: ${nonce}" \
    -H "X-OrcaSynapse-Node-Signature: ${signature}" \
    --data-binary "${payload}" \
    "${control_plane_url}${heartbeat_path}")"
  if [[ "${http_status}" == "200" ]]; then
    return 0
  fi
  response_error="$(jq -r '.message // .error // empty' "${response_file}" 2>/dev/null \
    | LC_ALL=C tr -cd '[:print:]' || true)"
  response_error="${response_error:0:400}"
  [[ -n "${response_error}" ]] || response_error="The control plane returned no diagnostic message."
  if [[ "${http_status}" == "401" ]]; then
    fail "VM1 rejected the enrolled VM2 identity ${node_fingerprint} for node ${node_id}. The retained VM2 state and dashboard record no longer share the same trust binding. Revoke and decommission the stale Agentic System node in the dashboard, run 'curl -fsSL ${control_plane_url}/install/remove-agentic-node.sh | sudo bash' on VM2, then issue a fresh installer claim. Server response: ${response_error}"
  fi
  fail "VM1 could not verify the enrolled VM2 trust binding (HTTP ${http_status}): ${response_error}"
}

wait_for_hermes() {
  local stop_on_failure="${1:-0}"
  local deadline=$((SECONDS + 180))
  until curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      journalctl -u "${RUNTIME_SERVICE}" -n 100 --no-pager >&2 || true
      if [[ "${stop_on_failure}" == "1" ]]; then
        systemctl stop "${RUNTIME_SERVICE}" >/dev/null 2>&1 || true
      fi
      return 1
    fi
    sleep 2
  done
}

# The commit actually checked out, read back rather than assumed.
#
# `--commit` is silently ignored when it would roll an existing install
# backwards, so the requested SHA is not proof of the installed one -- and the
# pin is the entire artifact-identity story.
installed_hermes_commit() {
  git -C "${HERMES_INSTALL_DIR}" rev-parse HEAD 2>/dev/null
}


write_desired_state_client() {
  install -d -m 0755 /usr/local/lib/orcasynapse
  write_file_from_stdin 0755 root root /usr/local/lib/orcasynapse/hermes-desired-state.sh <<'DESIREDSTATE'
#!/usr/bin/env bash
set -Eeuo pipefail

# Applies the toolset allowlist OrcaSynapse has admitted for this installation.
#
# The document is carried base64-encoded and signed over those exact bytes, so
# this never has to reproduce a canonical JSON serialization to check the
# signature: decode, verify, and only then parse.

STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTROL_PLANE_KEY="${STATE_ROOT}/control-plane-key.pem"
MANAGED_CONFIG="${ORCASYNAPSE_HERMES_MANAGED_DIR:-/etc/hermes}/config.yaml"
RUNTIME_SERVICE="${ORCASYNAPSE_HERMES_SERVICE:-orcasynapse-hermes}"

# A node enrolled before the control plane could sign has nothing to verify
# against. Applying an unverified document would be worse than applying none.
[[ -s "${CONTROL_PLANE_KEY}" ]] || exit 0
[[ -s "${MANAGED_CONFIG}" ]] || exit 0

CONTROL_PLANE_URL="$(<"${STATE_ROOT}/control-plane-url")"
NODE_ID="$(<"${STATE_ROOT}/node-id")"
if [[ -s "${STATE_ROOT}/desired-state-path" ]]; then
  DESIRED_STATE_PATH="$(<"${STATE_ROOT}/desired-state-path")"
else
  # Compatibility with receipts created before the control plane distributed
  # endpoint paths. New installations always persist the enrolled value.
  DESIRED_STATE_PATH="/api/v1/runtime-nodes/${NODE_ID}/desired-state"
fi
PRIVATE_KEY="${STATE_ROOT}/identity/node.key"

WORK="$(mktemp -d /tmp/orcasynapse-desired-state.XXXXXX)"
trap 'rm -rf -- "${WORK}"' EXIT

sign_request() {
  local timestamp="$1" nonce="$2" body="$3" body_digest
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}" > "${WORK}/message"
  openssl pkeyutl -sign -rawin -inkey "${PRIVATE_KEY}" -in "${WORK}/message" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '='
}

timestamp="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
nonce="$(cat /proc/sys/kernel/random/uuid)"
# A GET carries no body; the control plane checksums the literal JSON null.
signature="$(sign_request "${timestamp}" "${nonce}" 'null')"

http_status="$(curl --silent --show-error --max-time 20 \
  --output "${WORK}/response.json" --write-out '%{http_code}' \
  -H "X-OrcaSynapse-Node-Timestamp: ${timestamp}" \
  -H "X-OrcaSynapse-Node-Nonce: ${nonce}" \
  -H "X-OrcaSynapse-Node-Signature: ${signature}" \
  "${CONTROL_PLANE_URL}${DESIRED_STATE_PATH}")" || exit 0

# A control plane that does not serve desired state yet is not an error.
[[ "${http_status}" == "200" ]] || exit 0

jq -r '.documentBase64' "${WORK}/response.json" | base64 -d > "${WORK}/document.json"
jq -r '.signature' "${WORK}/response.json" | base64 -d > "${WORK}/document.sig"

openssl pkeyutl -verify -pubin -inkey "${CONTROL_PLANE_KEY}" -rawin \
  -in "${WORK}/document.json" -sigfile "${WORK}/document.sig" >/dev/null 2>&1 \
  || { echo "orcasynapse: desired-state signature did not verify; nothing applied" >&2; exit 1; }

# The signature proves the control plane wrote it; this proves it wrote it for
# this node, so a document meant for another runtime cannot be replayed here.
document_node="$(jq -r '.nodeId // empty' "${WORK}/document.json")"
[[ "${document_node}" == "${NODE_ID}" ]] \
  || { echo "orcasynapse: desired state addressed to another node; nothing applied" >&2; exit 1; }

[[ "$(jq -r '.format // empty' "${WORK}/document.json")" == "orcasynapse-runtime-desired-state/v1" ]] \
  || { echo "orcasynapse: unrecognized desired-state format; nothing applied" >&2; exit 1; }

# Recorded after verification and before anything is applied, so the installer
# and an operator reading the host can both see what the control plane last
# admitted -- including the empty set, which is a real instruction.
# Staged inside this run's own mktemp directory, not under a fixed name in the
# shared state root. The boot timer and the installer's preseed both run this
# script within seconds of each other on a fresh install, and a shared temp name
# lets one delete the file the other is about to install, killing it under
# `set -e`.
jq -r '.admittedToolsets[]?' "${WORK}/document.json" > "${WORK}/admitted-toolsets"
install -m 0644 -o root -g root "${WORK}/admitted-toolsets" "${STATE_ROOT}/admitted-toolsets"

# Admitted names drive two settings, because one is not enough.
#
# `platform_toolsets` allowlists this platform, and `no_mcp` suppresses MCP
# servers — but a toolset enabled globally still runs regardless of both.
# Verified on the pilot: admitting `clarify` alone left `bfl` enabled too, which
# the control plane then correctly refused as drift. `agent.disabled_toolsets`
# is subtracted after every other rule, so naming everything unadmitted there is
# what actually produces the admitted set and nothing else.
KEY="$(sed -n 's/^API_SERVER_KEY=//p' "${STATE_ROOT}/data/.env" 2>/dev/null || true)"
# KNOWN GAP: this key is visible in `ps` for the length of each tick, every
# five minutes, for the life of the node -- the same credential the unit file
# deliberately keeps out of its 0644 permissions.
#
# A `--config` file was tried here and reverted; it was not the cause of the
# regression it was blamed for, and the replacement needs verifying against a
# real node before it lands.
#
# The catalogue fetch is retried, and this is load-bearing. This script runs
# immediately after `systemctl restart` of the runtime, so the very first
# attempt regularly lands while Hermes is still coming back up. A single failed
# attempt yielded an empty catalogue, which the reconciler treats as "nothing to
# suppress" -- so `agent.disabled_toolsets` was never written and every
# unadmitted toolset stayed live, on a node reporting healthy. The endpoint
# answers 200 with a full catalogue seconds later, which is what made this look
# like a fetch bug rather than a race.
fetch_toolset_catalogue() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s -m 10 -H "Authorization: Bearer ${KEY}" http://127.0.0.1:8642/v1/toolsets \
      > "${WORK}/catalogue.json" 2>/dev/null && [[ -s "${WORK}/catalogue.json" ]]; then
      return 0
    fi
    sleep 3
  done
  : > "${WORK}/catalogue.json"
  # Still fails open -- suppressing nothing is safer than applying a policy
  # derived from a catalogue we could not read -- but it no longer does so
  # silently, and the allowlist above still applies.
  echo "orcasynapse: could not read the runtime toolset catalogue; unadmitted toolsets were NOT disabled this pass" >&2
  return 0
}
fetch_toolset_catalogue

python3 - "${MANAGED_CONFIG}" "${WORK}/document.json" "${WORK}/catalogue.json" "${WORK}/config.yaml" <<'RECONCILE'
import json, re, sys

config_path, document_path, catalogue_path, output_path = sys.argv[1:5]
admitted = json.load(open(document_path)).get("admittedToolsets") or []

# The runtime's own catalogue is the only complete list of names. If it is
# unavailable the admitted set still applies; nothing extra can be suppressed
# this pass, and the control plane keeps refusing runs until one succeeds.
try:
    raw = json.load(open(catalogue_path))
    items = raw if isinstance(raw, list) else raw.get("data") or raw.get("toolsets") or []
    every = [t["name"] for t in items if isinstance(t, dict) and t.get("name")]
except Exception:
    every = []

text = open(config_path).read()
# Drop any block a previous pass wrote, so this stays idempotent.
text = re.sub(r"\nagent:\n  disabled_toolsets:\n(?:    - .*\n)*", "\n", text)

allowlist = list(dict.fromkeys(["no_mcp", "memory"] + admitted))
text = re.sub(
    r"(platform_toolsets:\n  api_server:\n)(?:    - .*\n)+",
    lambda m: m.group(1) + "".join(f"    - {name}\n" for name in allowlist),
    text,
    count=1,
)

disabled = [name for name in every if name not in admitted and name != "memory"]
if disabled:
    block = "agent:\n  disabled_toolsets:\n" + "".join(f"    - {name}\n" for name in disabled)
    text = text.rstrip("\n") + "\n" + block

open(output_path, "w").write(text)
RECONCILE

if cmp -s "${WORK}/config.yaml" "${MANAGED_CONFIG}"; then
  exit 0
fi

install -m 0644 -o root -g root "${WORK}/config.yaml" "${MANAGED_CONFIG}"
echo "orcasynapse: applied toolset allowlist ($(jq -r '.admittedToolsets | length' "${WORK}/document.json") admitted); restarting Hermes" >&2
systemctl restart "${RUNTIME_SERVICE}" >/dev/null
DESIREDSTATE

  write_file_from_stdin 0644 root root "/etc/systemd/system/${DESIRED_STATE_SERVICE}.service" <<EOF
[Unit]
Description=Apply the OrcaSynapse toolset allowlist to the Hermes runtime
After=network-online.target orcasynapse-hermes.service
Wants=network-online.target

[Service]
Type=oneshot
# The client derives every path it uses from these. The heartbeat unit already
# carried the state root; without it here a non-default install reconciled
# correctly during installation (which runs in the installer's own environment)
# and then silently stopped forever, exiting 0 each tick so the timer reported
# success while no admitted toolset was ever applied.
Environment=ORCASYNAPSE_HERMES_STATE_ROOT=${STATE_ROOT}
Environment=ORCASYNAPSE_HERMES_MANAGED_DIR=${HERMES_MANAGED_DIR}
Environment=ORCASYNAPSE_HERMES_SERVICE=${RUNTIME_SERVICE}
ExecStart=/usr/local/lib/orcasynapse/hermes-desired-state.sh
EOF

  write_file_from_stdin 0644 root root "/etc/systemd/system/${DESIRED_STATE_SERVICE}.timer" <<EOF
[Unit]
Description=Reconcile the OrcaSynapse toolset allowlist every five minutes

[Timer]
OnBootSec=90s
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${DESIRED_STATE_SERVICE}.timer" >/dev/null
}

# Applies the admitted toolsets now instead of waiting for the timer.
#
# Without this a freshly enrolled node runs the tool-free baseline until the
# first tick — up to five minutes during which the runtime does not match what
# the dashboard says it admitted, and the operator watching the install has no
# way to tell the difference between "not yet" and "not working".
preseed_desired_state() {
  [[ -s "${STATE_ROOT}/control-plane-key.pem" ]] || return 0
  /usr/local/lib/orcasynapse/hermes-desired-state.sh
}

# The names the control plane last admitted, for the completion panel. Absent
# means the control plane never answered; empty means it answered "none", and
# those are different facts.
admitted_toolset_summary() {
  local file="${STATE_ROOT}/admitted-toolsets"
  [[ -r "${file}" ]] || { printf 'not yet reported by OrcaSynapse'; return 0; }
  if [[ ! -s "${file}" ]]; then
    printf 'none — every toolset disabled'
    return 0
  fi
  paste -sd ',' -- "${file}" 2>/dev/null | sed 's/,/, /g' || tr '
' ' ' < "${file}"
}

write_heartbeat_client() {
  install -d -m 0755 /usr/local/lib/orcasynapse
  write_file_from_stdin 0755 root root /usr/local/lib/orcasynapse/hermes-heartbeat.sh <<'HEARTBEAT'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_ROOT="${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}"
CONTROL_PLANE_URL="$(<"${STATE_ROOT}/control-plane-url")"
NODE_ID="$(<"${STATE_ROOT}/node-id")"
if [[ -s "${STATE_ROOT}/heartbeat-path" ]]; then
  HEARTBEAT_PATH="$(<"${STATE_ROOT}/heartbeat-path")"
else
  # Compatibility with nodes enrolled before endpoint paths were returned.
  HEARTBEAT_PATH="/api/v1/runtime-nodes/${NODE_ID}/heartbeat"
fi
PRIVATE_KEY="${STATE_ROOT}/identity/node.key"
COMMIT_PIN="$(<"${STATE_ROOT}/commit-pin")"

sign_request() {
  local timestamp="$1" nonce="$2" body="$3"
  local body_digest message_file signature sign_status=0
  body_digest="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  message_file="$(mktemp /tmp/orcasynapse-heartbeat-signature.XXXXXX)"
  printf '%s\n%s\n%s' "${timestamp}" "${nonce}" "${body_digest}" > "${message_file}"
  signature="$(
    openssl pkeyutl -sign -rawin \
      -inkey "${PRIVATE_KEY}" \
      -in "${message_file}" \
      | openssl base64 -A \
      | tr '+/' '-_' \
      | tr -d '='
  )" || sign_status=$?
  rm -f -- "${message_file}"
  (( sign_status == 0 )) || return "${sign_status}"
  printf '%s' "${signature}"
}

# Agent memory and session history are native to Hermes on this node. The
# separate corpus reconciler mirrors only its allowlisted memory/skill files for
# governed operator observability; it never becomes the runtime memory source.
hermes_status="DEGRADED"
if curl --fail --silent --max-time 5 http://127.0.0.1:8642/health >/dev/null; then
  hermes_status="ONLINE"
fi
observed_at="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
payload="$(jq -cS -n \
  --arg observedAt "${observed_at}" \
  --arg status "${hermes_status}" \
  --arg version "${COMMIT_PIN}" \
  '{observedAt:$observedAt,status:$status,hermesVersion:$version,capabilities:["gateway-api","native-sessions","native-memory","signed-heartbeat","corpus-sync-v1","corpus-crud-v1"]}')"
timestamp="${observed_at}"
nonce="$(cat /proc/sys/kernel/random/uuid)"
signature="$(sign_request "${timestamp}" "${nonce}" "${payload}")"

curl --fail --silent --show-error --max-time 15 \
  -H 'Content-Type: application/json' \
  -H "X-OrcaSynapse-Node-Timestamp: ${timestamp}" \
  -H "X-OrcaSynapse-Node-Nonce: ${nonce}" \
  -H "X-OrcaSynapse-Node-Signature: ${signature}" \
  --data-binary "${payload}" \
  "${CONTROL_PLANE_URL}${HEARTBEAT_PATH}" >/dev/null
HEARTBEAT

  write_file_from_stdin 0644 root root "/etc/systemd/system/${HEARTBEAT_SERVICE}.service" <<EOF
[Unit]
Description=OrcaSynapse Hermes runtime node heartbeat
After=network-online.target orcasynapse-hermes.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=ORCASYNAPSE_HERMES_STATE_ROOT=${STATE_ROOT}
ExecStart=/usr/local/lib/orcasynapse/hermes-heartbeat.sh
User=root
Group=root
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=${STATE_ROOT}
EOF

  write_file_from_stdin 0644 root root "/etc/systemd/system/${HEARTBEAT_SERVICE}.timer" <<EOF
[Unit]
Description=Send OrcaSynapse Hermes runtime node heartbeat every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
RandomizedDelaySec=10s
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

verify_hermes_corpus_compatibility() {
  [[ -x "${HERMES_PYTHON}" ]] \
    || fail "the approved Hermes runtime has no virtualenv interpreter at ${HERMES_PYTHON}"
  HERMES_HOME="${STATE_ROOT}/data" HERMES_MANAGED_DIR="${HERMES_MANAGED_DIR}" \
    HOME="${HERMES_HOME_DIR}" "${HERMES_PYTHON}" - <<'PYTHON' \
    || fail "the approved Hermes commit does not expose the native memory and Skill APIs required by the Corpus plane"
from tools.memory_tool import load_on_disk_store
from tools.skill_manager_tool import apply_skill_pending

assert callable(load_on_disk_store)
assert callable(apply_skill_pending)
PYTHON
}

write_corpus_reconciler() {
  local control_plane_url="$1" staged
  verify_hermes_corpus_compatibility
  install -d -m 0755 /usr/local/lib/orcasynapse
  staged="$(mktemp /tmp/orcasynapse-corpus-reconciler.XXXXXX)"
  ui_register_temp_file "${staged}"
  download_with_progress "Download the governed Hermes corpus reconciler" \
    "${control_plane_url%/}/install/hermes-corpus-reconciler.py" "${staged}" \
    || fail "could not download the Hermes corpus reconciler from OrcaSynapse"
  grep -Fq 'orcasynapse-hermes-corpus-snapshot/v1' "${staged}" \
    || fail "the downloaded Hermes corpus reconciler is not a recognized OrcaSynapse artifact"
  install -m 0755 -o root -g root "${staged}" /usr/local/lib/orcasynapse/hermes-corpus-reconciler.py

  write_file_from_stdin 0644 root root "/etc/systemd/system/${CORPUS_SERVICE}.service" <<EOF
[Unit]
Description=Synchronize the governed Hermes corpus with OrcaSynapse
After=network-online.target orcasynapse-hermes.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=ORCASYNAPSE_HERMES_STATE_ROOT=${STATE_ROOT}
Environment=ORCASYNAPSE_HERMES_SOURCE=${HERMES_INSTALL_DIR}
Environment=HERMES_HOME=${STATE_ROOT}/data
Environment=HERMES_MANAGED_DIR=${HERMES_MANAGED_DIR}
Environment=HOME=${HERMES_HOME_DIR}
Environment=ORCASYNAPSE_HERMES_USER=${HERMES_USER}
ExecStart=${HERMES_PYTHON} /usr/local/lib/orcasynapse/hermes-corpus-reconciler.py
User=root
Group=root
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_SETGID CAP_SETUID
ReadWritePaths=${STATE_ROOT}
ReadOnlyPaths=${HERMES_INSTALL_DIR}
EOF

  write_file_from_stdin 0644 root root "/etc/systemd/system/${CORPUS_SERVICE}.timer" <<EOF
[Unit]
Description=Synchronize the governed Hermes corpus every minute

[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
RandomizedDelaySec=10s
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${CORPUS_SERVICE}.timer" >/dev/null
}

# Repairs the runtime boundary of an already-enrolled node in place. This is
# deliberately narrower than enrollment: identity, API keys, model policy and
# control-plane trust remain untouched. It exists because nodes installed by an
# older release cannot enter the enrollment-resume path once their receipt has
# been cleared, yet still need their service account and unit reconciled.
repair_runtime_installation() {
  step 1 2 "Validate the enrolled Hermes runtime"
  require_root
  validate_state_root "${STATE_ROOT}"
  [[ -s "${STATE_ROOT}/node-id" ]] \
    || fail "no completed OrcaSynapse enrollment exists under ${STATE_ROOT}"
  [[ -s "${STATE_ROOT}/data/.env" && -x "${HERMES_BINARY}" ]] \
    || fail "the enrolled Hermes runtime is incomplete; decommission and re-enroll this node"
  [[ -r "/etc/systemd/system/${RUNTIME_SERVICE}.service" ]] \
    || fail "the managed ${RUNTIME_SERVICE} unit is missing"
  grep -Fqx 'X-OrcaSynapse-Managed=true' "/etc/systemd/system/${RUNTIME_SERVICE}.service" \
    || fail "refusing to replace a ${RUNTIME_SERVICE} unit not owned by OrcaSynapse"
  success "The existing enrollment and managed runtime are intact."

  step 2 2 "Reconcile the runtime filesystem boundary"
  # usermod refuses to change the home of an account with a live process. Stop
  # only the unit whose ownership marker was verified above; restart it after
  # the account and sandbox paths agree.
  if systemctl is-active "${RUNTIME_SERVICE}" >/dev/null 2>&1; then
    REPAIR_RUNTIME_WAS_ACTIVE=1
  fi
  systemctl stop "${RUNTIME_SERVICE}" \
    || fail "the managed Hermes service could not be stopped for repair"
  install -d -m 0711 "${STATE_ROOT}"
  create_service_account
  install_hermes_directory 0750 "${STATE_ROOT}/data"
  install_hermes_directory 0750 "${HERMES_HOME_DIR}"
  reconcile_managed_runtime_policy
  write_hermes_runtime_unit
  systemctl enable "${RUNTIME_SERVICE}" >/dev/null
  systemctl restart "${RUNTIME_SERVICE}" \
    || fail "the repaired Hermes service could not restart"
  wait_for_hermes 0 \
    || fail "the repaired Hermes service did not become healthy within three minutes"
  # Re-render the heartbeat as part of repair so a node installed before the
  # corpus companion advertises its new capability immediately. Installing the
  # companion alone would leave VM1 correctly treating the Corpus surface as
  # unavailable forever, even while snapshots arrived.
  write_heartbeat_client
  write_corpus_reconciler "$(<"${STATE_ROOT}/control-plane-url")"
  systemctl enable --now "${HEARTBEAT_SERVICE}.timer" >/dev/null
  systemctl start "${HEARTBEAT_SERVICE}.service" \
    || warning "The signed heartbeat will retry from its one-minute timer."
  systemctl start "${CORPUS_SERVICE}.service" \
    || warning "The corpus reconciler will retry from its one-minute timer."
  REPAIR_COMPLETED=1

  ui_complete "AGENTIC SYSTEM RUNTIME REPAIRED"
  ui_panel_kv "Service account home" "${HERMES_HOME_DIR}"
  ui_panel_kv "Runtime workspace" "${HERMES_HOME_DIR}"
  ui_next "Return to Agents > Corpus and confirm this node has synchronized."
}

main() {
  if [[ "$#" -eq 1 && "$1" == "--repair" ]]; then
    UI_BANNER_TAGLINE="AGENTIC SYSTEM  /  VM2 RUNTIME REPAIR"
    UI_BANNER_ACTIVITY="Reconciling the managed runtime boundary"
  fi
  banner

  if [[ "$#" -eq 1 && "$1" == "--repair" ]]; then
    repair_runtime_installation
    return 0
  fi

  step 1 7 "Validate the isolated host"
  require_root
  install_host_dependencies
  success "Ubuntu, systemd, git, OpenSSL, curl, jq, and python3 are ready."

  step 2 7 "Resolve or resume the protected enrollment"
  local bundle="" resuming=0
  local node_id token control_plane_url hermes_base_url hermes_commit hostname_value public_key api_key
  local node_fingerprint private_fingerprint retained_fingerprint enrolled_fingerprint
  if [[ -s "${ENROLLMENT_STATE}" ]]; then
    validate_resume_state "${ENROLLMENT_STATE}" || fail "the protected enrollment recovery state is invalid"
    resuming=1
    node_id="$(jq -r '.nodeId' "${ENROLLMENT_STATE}")"
    control_plane_url="$(jq -r '.controlPlaneUrl' "${ENROLLMENT_STATE}" | sed 's:/*$::')"
    hermes_base_url="$(jq -r '.hermesBaseUrl' "${ENROLLMENT_STATE}" | sed 's:/*$::')"
    hermes_commit="$(jq -r '.hermesCommit' "${ENROLLMENT_STATE}")"
    hostname_value="$(jq -r '.hostname' "${ENROLLMENT_STATE}")"
    api_key="$(jq -r '.apiKey' "${ENROLLMENT_STATE}")"
    if [[ "$#" -eq 2 && "$1" == "--connect" ]]; then
      [[ "${2%/}" == "${control_plane_url}" ]] || fail "the resume command points to a different OrcaSynapse origin"
    elif [[ "$#" -eq 1 && "$1" != "--connect" ]]; then
      [[ -r "$1" ]] || fail "the original enrollment bundle is not readable"
      [[ "$(jq -r '.nodeId // empty' "$1")" == "${node_id}" ]] \
        || fail "the enrollment bundle belongs to a different runtime node"
    else
      fail "resume with the same --connect command or the original enrollment-bundle path"
    fi
    success "Protected enrollment state found; continuing without another claim."
  else
    [[ ! -e "${STATE_ROOT}/node-id" ]] || fail "this host is already enrolled; revoke it in OrcaSynapse before rebuilding the node"
    if [[ "$#" -eq 1 && "$1" != "--connect" ]]; then
      bundle="$(realpath "$1")"
    elif [[ "$#" -eq 2 && "$1" == "--connect" ]]; then
      resolve_bundle_from_orcasynapse "$2"
      bundle="${RESOLVED_BUNDLE}"
    else
      fail "usage: install-agentic-node.sh <enrollment-bundle.json> | install-agentic-node.sh --connect <OrcaSynapse-origin> | install-agentic-node.sh --repair"
    fi
    validate_bundle "${bundle}"
    node_id="$(jq -r '.nodeId' "${bundle}")"
    token="$(jq -r '.token' "${bundle}")"
    control_plane_url="$(jq -r '.controlPlaneUrl' "${bundle}" | sed 's:/*$::')"
    hermes_base_url="$(jq -r '.hermesBaseUrl' "${bundle}" | sed 's:/*$::')"
    hermes_commit="$(jq -r '.hermesCommit' "${bundle}")"
    hostname_value="$(hostname --fqdn 2>/dev/null || hostname)"
    systemctl list-unit-files "${RUNTIME_SERVICE}.service" >/dev/null 2>&1 \
      && fail "a '${RUNTIME_SERVICE}' service already exists without resumable enrollment state"
    success "Enrollment bundle is valid, unexpired, and bound to OrcaSynapse."
  fi

  step 3 7 "Create the node identity"
  # 0711 on the root, 0700 on the identity.
  #
  # The runtime must traverse ${STATE_ROOT} to reach the data directory it owns.
  # Under Docker nothing did -- the container bind-mounted data/ straight to
  # /opt/data and never walked the parent -- so 0700 was free. Natively it locks
  # the service out of its own state. 0711 grants traversal without listing, so
  # the account still cannot enumerate what else lives here, and identity/ stays
  # root-only: the private key is readable by nobody but root either way.
  install -d -m 0711 "${STATE_ROOT}"
  install -d -m 0700 "${STATE_ROOT}/identity"
  create_service_account
  install_hermes_directory 0750 "${HERMES_HOME_DIR}"
  # The managed scope is a root-owned policy layer at ${HERMES_MANAGED_DIR}.
  # Hermes reads it through HERMES_MANAGED_DIR and it outranks anything the
  # service account can write, so the pinned model route and the baseline
  # guardrails cannot be overridden from the runtime's own state directory.
  install_hermes_directory 0750 "${STATE_ROOT}/data"
  if (( resuming )); then
    [[ -s "${STATE_ROOT}/identity/node.key" && -s "${STATE_ROOT}/identity/node.pub" ]] \
      || fail "the retained enrollment state is missing its node identity"
    info "Reusing the protected Ed25519 identity created before enrollment."
  else
    info "Generating an Ed25519 identity locally; the private key never leaves VM2."
    openssl genpkey -algorithm ED25519 -out "${STATE_ROOT}/identity/node.key"
    chmod 0600 "${STATE_ROOT}/identity/node.key"
    openssl pkey -in "${STATE_ROOT}/identity/node.key" -pubout -out "${STATE_ROOT}/identity/node.pub"
    api_key="$(openssl rand -hex 32)"
  fi
  node_fingerprint="$(public_identity_fingerprint)" \
    || fail "the VM2 public identity is unreadable"
  private_fingerprint="$(private_identity_fingerprint)" \
    || fail "the VM2 private identity is unreadable"
  [[ "${node_fingerprint}" == "${private_fingerprint}" ]] \
    || fail "the retained VM2 private and public identity files do not belong to the same Ed25519 keypair"
  if (( resuming )); then
    retained_fingerprint="$(jq -r '.identityFingerprint // empty' "${ENROLLMENT_STATE}")"
    if [[ -n "${retained_fingerprint}" && "${retained_fingerprint}" != "${node_fingerprint}" ]]; then
      fail "the protected enrollment receipt belongs to identity ${retained_fingerprint}, but this VM2 now holds ${node_fingerprint}; do not continue with mixed trust state"
    fi
  fi
  public_key="$(<"${STATE_ROOT}/identity/node.pub")"
  success "Node identity and protected runtime state verified (${node_fingerprint:0:16}...)."

  install_hermes_file_from_stdin 0600 "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
EOF

  step 4 7 "Install and start the hardened Hermes runtime"
  write_hermes_runtime_unit
  if (( resuming )) && systemctl is-enabled "${RUNTIME_SERVICE}" >/dev/null 2>&1; then
    systemctl start "${RUNTIME_SERVICE}" >/dev/null 2>&1 || true
    run_with_progress "Verify retained Hermes runtime" wait_for_hermes 0 \
      || fail "the retained Hermes runtime is not healthy"
    hermes_commit="$(installed_hermes_commit)" \
      || fail "the retained Hermes installation has no readable commit pin"
  else
    [[ -e "${HERMES_INSTALL_DIR}" ]] && ! (( resuming )) \
      && fail "Hermes is already installed at ${HERMES_INSTALL_DIR}; decommission this host before re-enrolling"
    # --skip-setup is not optional: without it the upstream installer ends in an
    # interactive provider wizard that blocks forever under `curl | bash`. It is
    # also correct on the merits -- OrcaSynapse supplies the entire
    # configuration through the managed layer, and Hermes must not choose a
    # provider of its own. --skip-browser drops Chromium, which a headless
    # API-server node has no use for.
    run_with_progress "Install the approved Hermes runtime" install_hermes_runtime "${hermes_commit}" \
      || fail "could not install the approved Hermes runtime at commit ${hermes_commit}"

    local resolved_commit
    resolved_commit="$(installed_hermes_commit)" \
      || fail "the Hermes installation has no readable commit pin"
    # `--commit` is silently ignored when it would roll an existing install
    # backwards, so the requested SHA is not proof of the installed one. The pin
    # is the whole artifact-identity story; an unverified one is worth nothing.
    [[ "${resolved_commit}" == "${hermes_commit}" ]] \
      || fail "Hermes installed commit ${resolved_commit} instead of the approved ${hermes_commit}"
    # Written only once this installer has actually installed the program, and
    # never when it declined to adopt a pre-existing one. The decommissioner
    # deletes /usr/local/lib/hermes-agent only if this marker is present:
    # Hermes's own installer defaults to that same path, so location proves
    # nothing, and the node identity proves nothing either -- it is created in
    # step 3, before step 4 discovers a foreign Hermes and aborts.
    printf 'commit=%s\n' "${resolved_commit}" > "${STATE_ROOT}/runtime-owned"
    chmod 0600 "${STATE_ROOT}/runtime-owned"
    success "Resolved the Hermes runtime to immutable artifact ${resolved_commit}."

    run_with_progress "Start the hardened Hermes service" systemctl enable --now "${RUNTIME_SERVICE}" \
      || fail "the hardened Hermes service could not start"
    run_with_progress "Verify Hermes runtime health" wait_for_hermes 1 \
      || fail "Hermes did not become healthy within three minutes"
  fi

  # Refuse an incompatible pin before consuming an enrollment claim. Corpus
  # mutations deliberately depend on these native Hermes APIs rather than on
  # private file rewrites or a second memory implementation.
  verify_hermes_corpus_compatibility


  step 5 7 "Enroll with the OrcaSynapse control plane"
  local model_base_url_json model_alias_json model_api_key_json
  local model_base_url model_alias model_api_key
  # Declared here, not in the branch that first obtains them: step 7 reads both
  # unconditionally, and under `set -u` an unset one aborts the run outright.
  # That is what made a resumed install unrecoverable -- it died with a raw bash
  # error after Hermes was already installed and enrolled, so the node never got
  # a heartbeat client and never came back online.
  local control_plane_key="" heartbeat_path="" desired_state_path=""
  if (( resuming )); then
    model_base_url_json="$(jq -c '.modelBootstrap.baseUrl' "${ENROLLMENT_STATE}")"
    model_alias_json="$(jq -c '.modelBootstrap.modelAlias' "${ENROLLMENT_STATE}")"
    model_api_key_json="$(jq -c '.modelBootstrap.apiKey' "${ENROLLMENT_STATE}")"
    model_base_url="$(jq -r '.modelBootstrap.baseUrl' "${ENROLLMENT_STATE}")"
    model_alias="$(jq -r '.modelBootstrap.modelAlias' "${ENROLLMENT_STATE}")"
    model_api_key="$(jq -r '.modelBootstrap.apiKey' "${ENROLLMENT_STATE}")"
    # Restored from the receipt they were deliberately written to. Without this
    # a resumed node would pin no control-plane key, and its desired-state
    # client would exit early forever rather than apply a toolset allowlist.
    control_plane_key="$(jq -r '.controlPlanePublicKeyPem // empty' "${ENROLLMENT_STATE}")"
    heartbeat_path="$(jq -r '.heartbeatPath // empty' "${ENROLLMENT_STATE}")"
    desired_state_path="$(jq -r '.desiredStatePath // empty' "${ENROLLMENT_STATE}")"
    heartbeat_path="$(resolve_control_plane_path "${heartbeat_path}" "/api/v1/runtime-nodes/${node_id}/heartbeat" "heartbeat")"
    desired_state_path="$(resolve_control_plane_path "${desired_state_path}" "/api/v1/runtime-nodes/${node_id}/desired-state" "desired-state")"
    success "Enrollment is already complete; recovered its scoped inference configuration."
  else
    info "Registering the public node identity and requesting the approved inference route."
    local request_file response_file http_status resume_file
    request_file="$(mktemp)"
    response_file="$(mktemp)"
    resume_file="$(mktemp)"
    TEMPORARY_FILES+=("${request_file}" "${response_file}" "${resume_file}")
    # Corpus capability is advertised by the first signed heartbeat only after
    # its companion is installed. Enrollment must not claim a surface that a
    # failed post-enrollment setup has not actually activated.
    jq -n \
    --arg nodeId "${node_id}" \
    --arg token "${token}" \
    --arg hostname "${hostname_value}" \
    --arg publicKeyPem "${public_key}" \
    --arg controlPlaneUrl "${control_plane_url}" \
    --arg apiKey "${api_key}" \
    --arg hermesVersion "${hermes_commit}" \
    --arg installerVersion "${INSTALLER_VERSION}" \
    '{nodeId:$nodeId,token:$token,hostname:$hostname,publicKeyPem:$publicKeyPem,controlPlaneUrl:$controlPlaneUrl,apiKey:$apiKey,hermesVersion:$hermesVersion,installerVersion:$installerVersion,capabilities:["gateway-api","signed-heartbeat"]}' \
    > "${request_file}"
  http_status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' --data-binary "@${request_file}" \
    "${control_plane_url}/api/v1/runtime-nodes/enroll")"
    if [[ "${http_status}" != "200" ]]; then
      systemctl disable --now "${RUNTIME_SERVICE}" >/dev/null 2>&1 || true
      fail "OrcaSynapse rejected enrollment (HTTP ${http_status}): $(jq -r '.message // "unknown error"' "${response_file}" 2>/dev/null)"
    fi

    jq -e '
    (.modelBootstrap.provider == "custom") and
    (.modelBootstrap.baseUrl | test("^https?://")) and
    (.modelBootstrap.modelAlias | type == "string" and length > 0) and
    (.modelBootstrap.apiKey | type == "string" and length > 0)
    ' "${response_file}" >/dev/null || fail "OrcaSynapse enrollment omitted its approved inference-gateway route"
    model_base_url_json="$(jq -c '.modelBootstrap.baseUrl' "${response_file}")"
    model_alias_json="$(jq -c '.modelBootstrap.modelAlias' "${response_file}")"
    model_api_key_json="$(jq -c '.modelBootstrap.apiKey' "${response_file}")"
    model_base_url="$(jq -r '.modelBootstrap.baseUrl' "${response_file}")"
    model_alias="$(jq -r '.modelBootstrap.modelAlias' "${response_file}")"
    model_api_key="$(jq -r '.modelBootstrap.apiKey' "${response_file}")"
    # Absent on a control plane older than ai-v1.41.0. A node with no pinned
    # key applies no desired state rather than trusting an unsigned document.
    control_plane_key="$(jq -r '.controlPlanePublicKeyPem // empty' "${response_file}")"
    heartbeat_path="$(jq -r '.heartbeatPath // empty' "${response_file}")"
    desired_state_path="$(jq -r '.desiredStatePath // empty' "${response_file}")"
    heartbeat_path="$(resolve_control_plane_path "${heartbeat_path}" "/api/v1/runtime-nodes/${node_id}/heartbeat" "heartbeat")"
    desired_state_path="$(resolve_control_plane_path "${desired_state_path}" "/api/v1/runtime-nodes/${node_id}/desired-state" "desired-state")"
    enrolled_fingerprint="$(jq -r '.node.identityFingerprint // empty' "${response_file}")"
    [[ "${enrolled_fingerprint}" == "${node_fingerprint}" ]] \
      || fail "OrcaSynapse enrolled identity '${enrolled_fingerprint:-missing}' instead of the VM2 identity '${node_fingerprint}'"
    jq -n \
      --arg nodeId "${node_id}" --arg controlPlaneUrl "${control_plane_url}" \
      --arg hermesBaseUrl "${hermes_base_url}" --arg hermesCommit "${hermes_commit}" \
      --arg hostname "${hostname_value}" --arg apiKey "${api_key}" \
      --arg identityFingerprint "${node_fingerprint}" \
      --arg controlPlanePublicKeyPem "${control_plane_key}" \
      --arg heartbeatPath "${heartbeat_path}" \
      --arg desiredStatePath "${desired_state_path}" \
      --argjson modelBootstrap "$(jq -c '.modelBootstrap' "${response_file}")" \
      '{format:"orcasynapse-hermes-resume/v1",nodeId:$nodeId,controlPlaneUrl:$controlPlaneUrl,hermesBaseUrl:$hermesBaseUrl,hermesCommit:$hermesCommit,hostname:$hostname,apiKey:$apiKey,identityFingerprint:$identityFingerprint,controlPlanePublicKeyPem:$controlPlanePublicKeyPem,heartbeatPath:$heartbeatPath,desiredStatePath:$desiredStatePath,modelBootstrap:$modelBootstrap}' \
      > "${resume_file}"
    install -m 0600 -o root -g root "${resume_file}" "${ENROLLMENT_STATE}"
    success "Node enrolled; protected recovery state was saved before continuing."
  fi

  verify_enrolled_identity "${node_id}" "${control_plane_url}" "${hermes_commit}" "${node_fingerprint}" "${heartbeat_path}"
  success "VM1 accepted the signed VM2 trust handshake."

  step 6 7 "Apply the managed runtime policy"
  install_hermes_directory 0750 "${STATE_ROOT}/data"
  write_hermes_managed_policy "${model_alias_json}" "${model_base_url_json}"
  install_hermes_file_from_stdin 0600 "${STATE_ROOT}/data/.env" <<EOF
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=${api_key}
OPENAI_BASE_URL=${model_base_url}
OPENAI_API_KEY=${model_api_key}
EOF
  run_with_progress "Apply the managed runtime policy" systemctl restart "${RUNTIME_SERVICE}" \
    || fail "Hermes could not restart with its managed policy"
  run_with_progress "Verify governed runtime recovery" wait_for_hermes 0 \
    || fail "Hermes did not recover after applying the OrcaSynapse-managed inference route"

  step 7 7 "Enable monitoring"
  printf '%s' "${node_id}" > "${STATE_ROOT}/node-id"
  printf '%s' "${control_plane_url}" > "${STATE_ROOT}/control-plane-url"
  printf '%s' "${hermes_base_url}" > "${STATE_ROOT}/hermes-base-url"
  printf '%s' "${hermes_commit}" > "${STATE_ROOT}/commit-pin"
  printf '%s' "${heartbeat_path}" > "${STATE_ROOT}/heartbeat-path"
  printf '%s' "${desired_state_path}" > "${STATE_ROOT}/desired-state-path"
  if [[ -n "${control_plane_key}" ]]; then
    printf '%s' "${control_plane_key}" > "${STATE_ROOT}/control-plane-key.pem"
    chmod 0644 "${STATE_ROOT}/control-plane-key.pem"
  fi
  chmod 0600 "${STATE_ROOT}/node-id" "${STATE_ROOT}/control-plane-url" "${STATE_ROOT}/hermes-base-url" \
    "${STATE_ROOT}/commit-pin" "${STATE_ROOT}/heartbeat-path" "${STATE_ROOT}/desired-state-path"

  write_heartbeat_client
  write_desired_state_client
  write_corpus_reconciler "${control_plane_url}"
  systemctl daemon-reload
  systemctl enable --now "${HEARTBEAT_SERVICE}.timer"
  systemctl start "${HEARTBEAT_SERVICE}.service"
  systemctl start "${CORPUS_SERVICE}.service" \
    || warning "The corpus reconciler will retry from its one-minute timer."

  success "Signed heartbeat monitoring is active."

  # Reconcile once now rather than leaving the node on the tool-free baseline
  # until the timer's first tick. A failure here is not fatal: the timer will
  # try again in five minutes, and the control plane refuses runs against a
  # runtime whose toolsets it has not confirmed, so the node is never wrongly
  # permissive in the meantime.
  if run_with_progress "Apply the admitted toolset allowlist" preseed_desired_state; then
    run_with_progress "Verify runtime health after applying the allowlist" wait_for_hermes 0 \
      || warning "Hermes is still settling; the reconcile timer will retry within five minutes."
  elif [[ -s "${STATE_ROOT}/admitted-toolsets" ]]; then
    warning "Could not reach OrcaSynapse for the toolset allowlist; the reconcile timer retries every five minutes."
  else
    # Distinguished deliberately. The reconciler exits non-zero for a network
    # failure and for a signature that did not verify, a document addressed to
    # another node, or an unrecognized format -- and calling the second class a
    # network blip tells an operator to wait for a retry that will never
    # succeed. Nothing was applied either way, so the allowlist file is the
    # tell: absent means the document was rejected, not unreachable.
    warning "The toolset allowlist was not applied: OrcaSynapse was unreachable, or the signed document it returned was rejected."
    warning "Check 'journalctl -u ${DESIRED_STATE_SERVICE}' after the next tick; a signature failure will not resolve itself."
  fi
  rm -f -- "${ENROLLMENT_STATE}"
  INSTALLATION_COMPLETED=1

  ui_complete "AGENTIC SYSTEM IS READY"
  ui_panel_kv "Hermes API" "${hermes_base_url}"
  ui_panel_kv "Runtime commit" "${hermes_commit}"
  ui_panel_kv "Model route" "${model_alias} via the OrcaSynapse gateway"
  # What the runtime may actually do, stated at the end of the install rather
  # than left for the operator to infer from the dashboard.
  ui_panel_kv "Admitted toolsets" "$(admitted_toolset_summary)"
  ui_panel_kv "Node fingerprint" "${node_fingerprint}"
  printf '\n'
  info "The one-time enrollment claim has been consumed."
  info "OrcaSynapse now monitors this node without SSH or any remote execution channel."
  info "Toolset changes made in the dashboard reach this node within five minutes."
  info "Hermes memory and skill changes appear in Agents > Corpus within one minute."
  warning "Before production, allow OrcaSynapse to reach TCP/8642 and restrict VM2 egress to OrcaSynapse HTTPS plus approved inference and MCP destinations."
  ui_next "Return to OrcaSynapse and confirm this node reports Healthy."
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
