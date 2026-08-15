#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_GITHUB_REPOSITORY="${ORCASYNAPSE_GITHUB_REPOSITORY:-multichainerz/AI}"
# Exported so the host installer can bake it into the update agent's unit. An
# installation that came from a fork or a mirror must keep updating from there,
# not silently start pulling install.sh from upstream on its first unattended
# upgrade.
export ORCASYNAPSE_GITHUB_REPOSITORY
ORCASYNAPSE_REF="${ORCASYNAPSE_REF:-main}"
ORCASYNAPSE_INSTALL_DIR="${ORCASYNAPSE_INSTALL_DIR:-/opt/orcasynapse}"
ORCASYNAPSE_ARCHIVE_SHA256="${ORCASYNAPSE_ARCHIVE_SHA256:-}"

temporary_root=""
staging_dir=""
backup_dir=""
database_backup_path=""
existing_install_action=""

# The pre-upgrade source tree, retained *past* the swap so that a failure at the
# handoff -- which is where the forward-only migrations run -- has something to
# put back. Until this existed the backup was deleted the instant the swap
# succeeded, so the EXIT handler's restore covered the two rename calls and
# nothing after them.
#
# It is cleared in exactly two places: the rollback, which consumes it, and the
# success path, which discards it. Anything else reaching the EXIT handler with
# it still set means the run was interrupted, and that handler puts the source
# back rather than leaving a half-upgraded tree behind.
upgrade_backup_dir=""
# Everything the rollback needs, captured while the installation being replaced
# is still the one on disk. Read after the swap they would describe the new tree.
upgrade_database_user=""
upgrade_database_name=""
upgrade_schema_fingerprint=""
upgrade_from_version=""
upgrade_from_commit=""
upgrade_to_commit=""
# Set once a rollback has run, so the EXIT handler can tell "there is a dump and
# you must restore it yourself" apart from "this already restored itself".
upgrade_rollback_outcome=""

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

UI_BANNER_TAGLINE="PRIVATE AI CONTROL PLANE  /  SECURE HOST BOOTSTRAP"
UI_BANNER_ACTIVITY="Initializing verified installation"
UI_BANNER_META="Source ${ORCASYNAPSE_GITHUB_REPOSITORY} @ ${ORCASYNAPSE_REF}"
UI_DOWNLOAD_MAX_TIME=300

cleanup() {
  # Read before anything else in this handler: every command below overwrites
  # $?, and the restore notice at the end has to tell a failed run apart from a
  # successful one. The same mistake was already made and fixed once in
  # scripts/install-orcasynapse.sh, where it logged status=0 for every failure.
  local status=$?
  (( UI_INTERACTIVE )) && printf '\033[?25h'
  [[ -z "${temporary_root}" || ! -d "${temporary_root}" ]] || rm -rf -- "${temporary_root}"
  [[ -z "${staging_dir}" || ! -d "${staging_dir}" ]] || rm -rf -- "${staging_dir}"
  if [[ -n "${backup_dir}" && -d "${backup_dir}" ]]; then
    if [[ ! -e "${ORCASYNAPSE_INSTALL_DIR}" ]]; then
      mv -- "${backup_dir}" "${ORCASYNAPSE_INSTALL_DIR}" || true
    else
      warning "A protected source backup remains at ${backup_dir}; inspect it before removal."
    fi
  fi
  # A retained pre-upgrade tree that reaches this handler is one the supervised
  # rollback never got to: the run was interrupted, or it died before the
  # handoff was even reached. Putting the *source* back here is cheap and always
  # correct -- the tree is byte-for-byte what was replaced -- so it is done
  # rather than left to an operator who, once the dashboard owns updates, may
  # have no shell to do it from. The database is deliberately not touched from a
  # trap: that restore is destructive and takes minutes, and a signal handler is
  # the wrong place to start it. The panel below names the dump instead.
  #
  # Gated on a failing status, and that gate is not decoration: a successful run
  # that somehow still holds a backup must discard it, never undo itself. A
  # mutation that removed the success path's discard proved the point -- without
  # this gate the EXIT handler rolled a *successful* upgrade back to the previous
  # release, which is a worse defect than the one being mutated.
  if [[ -n "${upgrade_backup_dir}" && -d "${upgrade_backup_dir}" ]]; then
    if (( status == 0 )); then
      warning "A retained pre-upgrade source tree was left at ${upgrade_backup_dir} by a successful run; removing it."
      rm -rf --one-file-system -- "${upgrade_backup_dir}" || true
    elif restore_retained_source_backup; then
      warning "The interrupted upgrade's source tree was restored; the database was left as it was."
    else
      warning "The pre-upgrade source tree is at ${upgrade_backup_dir} and could not be restored automatically."
    fi
  fi
  # An upgrade that rolled itself back has already said so, at length, with the
  # outcome it reached. Repeating "the dump is intact, go and restore it" under
  # that would tell an operator to redo work the installer just did.
  if [[ -n "${upgrade_rollback_outcome}" ]]; then
    return
  fi
  # The source tree restores itself; the database does not, because the
  # migrations are forward-only and have no down step. An upgrade that fails
  # after they ran leaves a new schema under old code, and this dump is the only
  # way back -- so its path is the last thing an operator reads here, not
  # something they have to know to go looking for.
  if (( status != 0 )) && [[ -n "${database_backup_path}" && -f "${database_backup_path}" ]]; then
    ui_panel_begin "${UI_AMBER}" "THE PRE-UPGRADE DATABASE DUMP IS INTACT" "="
    ui_panel_kv 'Dump' "${database_backup_path}"
    ui_panel_kv 'Restore guide' "${ORCASYNAPSE_INSTALL_DIR}/docs/DATABASE_RESTORE_RUNBOOK.md"
    ui_panel_kv 'Backup record' "${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-database-backup.json"
    ui_panel_line 'This upgrade did not finish. Nothing else is needed to keep the dump; it is'
    ui_panel_line 'already on disk. Follow the restore guide before running any further upgrade.'
    ui_panel_end "${UI_AMBER}" "="
  fi
}
trap cleanup EXIT

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "run this installer as root (for example: sudo bash install.sh)"
}

# The operator's declaration of the scheme browsers really reach OrcaSynapse
# with, carried on the command line because that is the only channel a sudo
# invocation cannot strip. Every command deploy/BOOTSTRAP.md prints goes through
# sudo, stock sudoers is `Defaults env_reset`, and an exported
# ORCASYNAPSE_PUBLIC_SCHEME is dropped on the way in -- so an operator who set
# the variable got a plain-HTTP proxy and a summary that said nothing.
#
# This is a deliberate second copy of scripts/lib/public-scheme.sh's parser.
# This file is fetched over HTTPS and piped into a root shell with nothing else
# beside it; it cannot source a library that is not on the host yet. It only
# needs the parse: the value is exported here and the resolution, recording and
# reporting all happen in scripts/install-orcasynapse.sh, which this script
# execs into within the same process, where an export always survives.
orcasynapse_take_public_scheme_flag() {
  local value
  ORCASYNAPSE_REMAINING_ARGS=()
  while (( $# > 0 )); do
    case "$1" in
      --public-scheme)
        (( $# >= 2 )) || fail "--public-scheme needs a value: --public-scheme https"
        value="$2"
        shift 2
        ;;
      --public-scheme=*)
        value="${1#*=}"
        shift
        ;;
      *)
        ORCASYNAPSE_REMAINING_ARGS+=("$1")
        shift
        continue
        ;;
    esac
    # Anything the bundled proxy does not recognise as https is rendered as
    # http, so a near miss would leave an operator believing the session cookies
    # are Secure when they are not. Refused here, before any download.
    [[ "${value}" == "http" || "${value}" == "https" ]] \
      || fail "--public-scheme must be http or https, not '${value}'"
    ORCASYNAPSE_PUBLIC_SCHEME="${value}"
    export ORCASYNAPSE_PUBLIC_SCHEME
  done
}

install_bootstrap_dependencies() {
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 \
    && command -v sha256sum >/dev/null 2>&1; then
    return
  fi

  [[ -r /etc/os-release ]] || fail "automatic dependency installation supports Debian and Ubuntu"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) fail "automatic dependency installation supports Debian and Ubuntu; install curl, tar, and sha256sum first" ;;
  esac

  run_with_progress "Refresh operating-system packages" apt-get update \
    || fail "could not refresh operating-system packages"
  run_with_progress "Install bootstrap dependencies" env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y ca-certificates curl tar coreutils \
    || fail "could not install curl, tar, and checksum utilities"
}

validate_inputs() {
  [[ "${ORCASYNAPSE_GITHUB_REPOSITORY}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
    || fail "ORCASYNAPSE_GITHUB_REPOSITORY must be a GitHub owner/repository name"
  [[ "${ORCASYNAPSE_REF}" =~ ^[A-Za-z0-9._/-]+$ && "${ORCASYNAPSE_REF}" != *..* && "${ORCASYNAPSE_REF}" != /* ]] \
    || fail "ORCASYNAPSE_REF contains unsupported characters"
  [[ "${ORCASYNAPSE_INSTALL_DIR}" == /* ]] \
    || fail "ORCASYNAPSE_INSTALL_DIR must be an absolute path below the filesystem root"
  ORCASYNAPSE_INSTALL_DIR="$(realpath -m -- "${ORCASYNAPSE_INSTALL_DIR}")"
  [[ "${ORCASYNAPSE_INSTALL_DIR}" != "/" ]] \
    || fail "ORCASYNAPSE_INSTALL_DIR must resolve below the filesystem root"
  if [[ -n "${ORCASYNAPSE_ARCHIVE_SHA256}" ]]; then
    [[ "${ORCASYNAPSE_ARCHIVE_SHA256}" =~ ^[a-fA-F0-9]{64}$ ]] \
      || fail "ORCASYNAPSE_ARCHIVE_SHA256 must contain exactly 64 hexadecimal characters"
  fi
}

resolve_commit() {
  if [[ "${ORCASYNAPSE_REF}" =~ ^[a-f0-9]{40}$ ]]; then
    printf '%s' "${ORCASYNAPSE_REF}"
    return
  fi

  local response commit
  response="$(curl --fail --silent --show-error --location --max-time 30 \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/${ORCASYNAPSE_GITHUB_REPOSITORY}/commits/${ORCASYNAPSE_REF}")" \
    || fail "GitHub could not resolve ORCASYNAPSE_REF '${ORCASYNAPSE_REF}'"
  commit="$(printf '%s\n' "${response}" \
    | sed -nE 's/^[[:space:]]*"sha":[[:space:]]*"([a-f0-9]{40})",?[[:space:]]*$/\1/p' \
    | head -n 1)"
  [[ "${commit}" =~ ^[a-f0-9]{40}$ ]] || fail "GitHub returned an invalid commit for ORCASYNAPSE_REF '${ORCASYNAPSE_REF}'"
  printf '%s' "${commit}"
}

download_release_source() {
  local commit="$1" archive="$2"
  download_with_progress "Download immutable source ${commit:0:12}" \
    "https://codeload.github.com/${ORCASYNAPSE_GITHUB_REPOSITORY}/tar.gz/${commit}" "${archive}" \
    || fail "GitHub source download failed"

  local actual_checksum
  actual_checksum="$(sha256sum "${archive}" | awk '{print $1}')"
  if [[ -n "${ORCASYNAPSE_ARCHIVE_SHA256}" && "${actual_checksum,,}" != "${ORCASYNAPSE_ARCHIVE_SHA256,,}" ]]; then
    fail "downloaded archive checksum does not match ORCASYNAPSE_ARCHIVE_SHA256"
  fi
  success "Archive verified (sha256: ${actual_checksum})."
}

stage_source_tree() {
  local commit="$1" source_dir="$2"
  local install_parent install_name
  install_parent="$(dirname -- "${ORCASYNAPSE_INSTALL_DIR}")"
  install_name="$(basename -- "${ORCASYNAPSE_INSTALL_DIR}")"
  install -d -m 0750 "${install_parent}"
  staging_dir="${install_parent}/.${install_name}.staging.$$"
  [[ ! -e "${staging_dir}" ]] || fail "temporary installation path already exists: ${staging_dir}"
  install -d -m 0750 "${staging_dir}"
  cp -a -- "${source_dir}/." "${staging_dir}/"
  printf '%s' "${commit}" > "${staging_dir}/.orcasynapse-source-commit"
  chmod 0600 "${staging_dir}/.orcasynapse-source-commit"
}

existing_install_is_verified() {
  local marker="${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit" existing_commit=""
  [[ -d "${ORCASYNAPSE_INSTALL_DIR}" && ! -L "${ORCASYNAPSE_INSTALL_DIR}" ]] || return 1
  [[ -f "${marker}" && ! -L "${marker}" && -r "${marker}" ]] || return 1
  existing_commit="$(<"${marker}")"
  [[ "${existing_commit}" =~ ^[a-f0-9]{40}$ ]] || return 1
  [[ -f "${ORCASYNAPSE_INSTALL_DIR}/compose.yaml" \
    && -f "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh" ]] || return 1
}

existing_install_has_current_schema_epoch() {
  local marker="${ORCASYNAPSE_INSTALL_DIR}/.local/state/schema-epoch"
  [[ -f "${marker}" && ! -L "${marker}" && -r "${marker}" ]] || return 1
  [[ "$(<"${marker}")" == "hermes-native-v1" ]]
}

choose_existing_install_action() {
  local verified="$1" requested_commit="$2"
  local configured_action="${ORCASYNAPSE_EXISTING_INSTALL_ACTION:-}" choice="" epoch_compatible=0
  if [[ "${verified}" == "1" ]] && existing_install_has_current_schema_epoch; then
    epoch_compatible=1
  fi

  existing_install_action=""

  if [[ -n "${configured_action}" ]]; then
    case "${configured_action}" in
      upgrade)
        [[ "${verified}" == "1" ]] || fail "cannot upgrade an unverified directory; use an empty path or explicitly choose erase"
        [[ "${epoch_compatible}" == "1" ]] || fail "this greenfield release cannot preserve a pre-v4.6.0 database; choose erase on clean VM1 and restore only through the preserved prior release"
        existing_install_action="upgrade"
        return
        ;;
      erase)
        [[ "${ORCASYNAPSE_CONFIRM_ERASE:-}" == "ERASE" ]] \
          || fail "automated erase requires ORCASYNAPSE_CONFIRM_ERASE=ERASE"
        existing_install_action="erase"
        return
        ;;
      abort)
        existing_install_action="abort"
        return
        ;;
      *) fail "ORCASYNAPSE_EXISTING_INSTALL_ACTION must be upgrade, erase, or abort" ;;
    esac
  fi

  [[ -r /dev/tty && -w /dev/tty ]] \
    || fail "${ORCASYNAPSE_INSTALL_DIR} already exists; an interactive terminal or ORCASYNAPSE_EXISTING_INSTALL_ACTION is required"

  {
    printf '\n%b+======================================================================+%b\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}"
    printf '%b|  %-68s|%b\n' "${UI_AMBER}${UI_BOLD}" "EXISTING INSTALLATION DETECTED" "${UI_RESET}"
    printf '%b+======================================================================+%b\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}"
    printf '   Location:  %s\n' "${ORCASYNAPSE_INSTALL_DIR}"
    if [[ "${verified}" == "1" && "${epoch_compatible}" == "1" ]]; then
      printf '   Installed: %.12s\n' "$(<"${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit")"
      printf '   Requested: %.12s\n\n' "${requested_commit}"
      printf '   %b1%b  Update application source; preserve PostgreSQL and secrets %b[recommended]%b\n' \
        "${UI_CYAN}${UI_BOLD}" "${UI_RESET}" "${UI_GREEN}" "${UI_RESET}"
      printf '   %b2%b  Clean reinstall; permanently erase containers, volumes, accounts, and secrets\n' \
        "${UI_RED}${UI_BOLD}" "${UI_RESET}"
      printf '   %b3%b  Exit without changes\n' "${UI_DIM}" "${UI_RESET}"
      printf '\n   Enter 1, 2, or 3 and press Enter. Pressing Enter alone selects 1.\n'
      printf '   Awaiting selection on the next line:\n\n'
    else
      if [[ "${verified}" == "1" ]]; then
        printf '   This installation predates the hermes-native schema epoch.\n'
        printf '   Its database cannot be preserved by this greenfield release.\n\n'
      else
        printf '   This directory is not a verified OrcaSynapse source tree.\n\n'
      fi
      printf '   %b1%b  Clean the directory and install from scratch\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}"
      printf '   %b2%b  Exit without changes\n' "${UI_DIM}" "${UI_RESET}"
      printf '\n   Enter 1 or 2 and press Enter. Pressing Enter alone selects 2.\n'
      printf '   Awaiting selection on the next line:\n\n'
    fi
  } > /dev/tty

  if ! IFS= read -r choice < /dev/tty; then
    fail "the terminal closed before an installation action was received"
  fi
  if [[ "${verified}" == "1" && "${epoch_compatible}" == "1" ]]; then
    case "${choice:-1}" in
      1)
        printf '   Selection received: update and preserve data.\n\n' > /dev/tty
        existing_install_action="upgrade"
        return
        ;;
      2) choice="erase" ;;
      3)
        printf '   Selection received: exit without changes.\n\n' > /dev/tty
        existing_install_action="abort"
        return
        ;;
      *) fail "invalid existing-installation selection" ;;
    esac
  else
    case "${choice:-2}" in
      1) choice="erase" ;;
      2)
        printf '   Selection received: exit without changes.\n\n' > /dev/tty
        existing_install_action="abort"
        return
        ;;
      *) fail "invalid existing-directory selection" ;;
    esac
  fi

  {
    printf '\n   %bDESTRUCTIVE ACTION SELECTED%b\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}"
    printf '   Nothing has been deleted yet.\n'
    printf '   Type ERASE and press Enter to permanently remove this installation and its data.\n'
    printf '   Confirmation input follows on the next line:\n\n'
  } > /dev/tty
  if ! IFS= read -r choice < /dev/tty; then
    fail "the terminal closed before destructive confirmation was received; no data was removed"
  fi
  printf '\n' > /dev/tty
  [[ "${choice}" == "ERASE" ]] || fail "clean reinstall cancelled; no data was removed"
  existing_install_action="erase"
}

clean_existing_install() {
  local resolved_target
  resolved_target="$(realpath -m -- "${ORCASYNAPSE_INSTALL_DIR}")"
  [[ "${resolved_target}" == "${ORCASYNAPSE_INSTALL_DIR}" && "${resolved_target}" != "/" ]] \
    || fail "refusing to clean an unresolved or filesystem-root installation path"

  if [[ -f "${ORCASYNAPSE_INSTALL_DIR}/compose.yaml" ]] \
    && command -v docker >/dev/null 2>&1 \
    && docker compose version >/dev/null 2>&1; then
    run_with_progress "Remove existing containers and data volumes" \
      docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" down --remove-orphans --volumes --timeout 30 \
      || fail "Docker could not cleanly remove the existing OrcaSynapse stack"
  fi

  run_with_progress "Remove existing application files and local secrets" \
    rm -rf --one-file-system -- "${resolved_target}" \
    || fail "the existing installation directory could not be removed"
  [[ ! -e "${resolved_target}" ]] || fail "the existing installation directory could not be removed"
  success "Clean-installation boundary verified; new source installation can proceed."
}

# The release the dump is being taken *from*, used to name the file and to tell
# a restoring operator which source tree the schema in it belongs to. The
# completion receipt is the authority because it is written by the run that
# actually finished; the source tree's version constant is the fallback for a
# receipt written before that field existed. Anything else becomes "unknown"
# rather than putting an operator-supplied fragment into a filename.
existing_install_version() {
  local receipt="${ORCASYNAPSE_INSTALL_DIR}/.local/state/install-complete.json"
  local version_file="${ORCASYNAPSE_INSTALL_DIR}/packages/contracts/src/version.ts"
  local version=""
  if [[ -r "${receipt}" ]]; then
    version="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "${receipt}" | head -n 1)"
  fi
  if [[ -z "${version}" && -r "${version_file}" ]]; then
    version="$(sed -nE 's/.*ORCASYNAPSE_VERSION = "([^"]+)".*/\1/p' "${version_file}" | head -n 1)"
  fi
  version="${version//[^A-Za-z0-9._-]/}"
  printf '%s' "${version:-unknown}"
}

# Which role and database to dump, read out of the Compose secret rather than
# assumed. The database URL is a file mounted into the containers and never an
# environment variable on the host, so this file is the only place those names
# exist outside PostgreSQL itself.
#
# The password in that URL is deliberately not parsed: passing it to
# `docker compose exec -e PGPASSWORD=` would publish the database password to
# every `ps` on the host for the length of the dump. The postgres container
# already has its own copy at /run/secrets/postgres_password, which is where the
# dump command below reads it.
#
# Returns non-zero instead of calling fail: this runs inside a command
# substitution, where fail's exit would end only the subshell and leave the
# caller running with an empty answer.
database_identity_from_secret() {
  local secret="${ORCASYNAPSE_INSTALL_DIR}/.local/secrets/orcasynapse_database_url"
  local url remainder authority user database
  [[ -s "${secret}" ]] || return 1
  url="$(<"${secret}")"
  url="${url//[[:space:]]/}"
  [[ "${url}" == *"://"* ]] || return 1
  remainder="${url#*://}"
  # Credentials are stripped before the path is read. A password may legally
  # contain a slash, and taking the path first would then cut the URL inside the
  # password and dump a database that does not exist. The host is taken after
  # the *last* @ and the role before the *first* one, so a password containing
  # either character still leaves both ends correct.
  authority="${remainder##*@}"
  user="${remainder%%@*}"
  user="${user%%:*}"
  [[ "${authority}" == */* ]] || return 1
  database="${authority#*/}"
  database="${database%%\?*}"
  [[ "${user}" =~ ^[A-Za-z0-9_-]+$ && "${database}" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  printf '%s %s' "${user}" "${database}"
}

# pg_dump runs inside the postgres container rather than on the host: the
# database listens only on Compose's internal `data` network, the host has no
# postgres client of its own, and the credential is a container-mounted secret.
#
# Kept as a function so run_with_progress can drive it -- that helper redirects
# its command's stdout into a log file, so the dump has to own the redirection
# to its target rather than write to stdout.
run_database_dump() {
  local target="$1" db_user="$2" db_name="$3"
  # --clean --if-exists --no-owner: the dump has to be restorable *over* the
  # database it came from, which is the only restore that matters here, and
  # restorable by a role with a different name into a scratch database, which is
  # how an operator inspects one before committing to it.
  docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
    sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec pg_dump --username="$1" --dbname="$2" --no-password --clean --if-exists --no-owner' \
    orcasynapse-pg-dump "${db_user}" "${db_name}" \
    | gzip -9 > "${target}"
}

# pg_isready over TCP rather than the socket, for the reason compose.yaml's
# healthcheck states: the official entrypoint runs its initdb-phase server with
# listen_addresses='', so the socket answers while the port still refuses, and a
# dump started in that window fails against a database that is about to be fine.
wait_for_database() {
  local db_user="$1" db_name="$2" deadline=$((SECONDS + 120))
  until docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
      pg_isready -h 127.0.0.1 -U "${db_user}" -d "${db_name}" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}

# Three dumps kept, by modification time rather than by name. The name carries
# the release it was taken from, and release names do not sort chronologically:
# v5.10.0 sorts before v5.9.0, so a lexical pruner would delete the newest dump
# on the first two-digit minor version -- the release most likely to need it.
prune_database_backups() {
  local backups_dir="$1" path
  local -a stale=()
  while IFS= read -r path; do
    # `if` rather than `[[ … ]] && stale+=(…)`: a false test is a failing
    # command, and as the last statement in a loop body it trips errexit.
    if [[ -n "${path}" ]]; then stale+=("${path}"); fi
  done < <(find "${backups_dir}" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -k1,1rn -k2,2r | tail -n +4 | cut -d' ' -f2-)
  (( ${#stale[@]} > 0 )) || return 0
  rm -f -- "${stale[@]}"
  info "Kept the three most recent database dumps; removed ${#stale[@]} older one(s)."
}

# The pointer a restore starts from, so finding the dump is never a matter of
# guessing at a filename. It records the commit the dump was taken from as well
# as the one being installed, because restoring the data is only half of going
# back -- the other half is reinstalling that commit's source.
#
# Written under .local/state, which the upgrade copies into the new tree, so it
# survives the source swap that is about to happen.
record_database_backup() {
  local path="$1" version="$2" bytes="$3" target_commit="$4"
  local receipt="${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-database-backup.json"
  local from_commit="" escaped_path
  if [[ -r "${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit" ]]; then
    from_commit="$(<"${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit")"
  fi
  escaped_path="${path//\\/\\\\}"
  escaped_path="${escaped_path//\"/\\\"}"
  install -d -m 0700 "${ORCASYNAPSE_INSTALL_DIR}/.local/state"
  printf '{"path":"%s","version":"%s","bytes":%s,"createdAt":"%s","fromCommit":"%s","toCommit":"%s"}\n' \
    "${escaped_path}" "${version}" "${bytes}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${from_commit}" "${target_commit}" > "${receipt}"
  chmod 0600 "${receipt}"
}

# The schema as one value, so "did the migrations actually move anything" is a
# question with an answer instead of an assumption.
#
# Column level, not table level: the migration that cannot be undone is the one
# that adds a column and backfills it, and a digest of table names alone would
# call that no change at all. Ordered inside string_agg rather than by an ORDER
# BY on the subquery, because aggregate input order is only guaranteed when the
# aggregate itself is told to sort.
#
# Read inside the container for the same two reasons the dump is: the database
# listens only on Compose's internal `data` network, and its password is a
# container-mounted secret that must never appear in the host's process list.
#
# Returns non-zero rather than calling fail -- it runs inside a command
# substitution, where fail would end only the subshell.
database_schema_fingerprint() {
  local db_user="$1" db_name="$2" value=""
  value="$(docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
    sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --username="$1" --dbname="$2" --no-password -tAc "$3"' \
    orcasynapse-pg-fingerprint "${db_user}" "${db_name}" \
    "select coalesce(md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, column_name)), 'empty-schema') from information_schema.columns where table_schema = 'public'" \
    </dev/null 2>/dev/null)" || return 1
  value="${value//[[:space:]]/}"
  [[ -n "${value}" ]] || return 1
  printf '%s' "${value}"
}

# Restores the pre-upgrade dump over the database it was taken from.
#
# The password is read inside the container, never passed in; --clean
# --if-exists in the dump means this does not need an empty database; and
# ON_ERROR_STOP=1 is the difference between a restore and a psql run that
# reports success after skipping every statement it could not apply.
restore_database_from_dump() {
  local dump="$1" db_user="$2" db_name="$3"
  gzip -cd -- "${dump}" \
    | docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
        sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql --username="$1" --dbname="$2" --no-password -v ON_ERROR_STOP=1 -q' \
        orcasynapse-pg-restore "${db_user}" "${db_name}" >/dev/null
}

# The retained tree goes back where the installation lives.
#
# The failed tree is moved aside first and removed only once the old one is in
# place, so the window in which the installation directory does not exist is one
# rename long -- and for that window `backup_dir` is set, which is what makes the
# EXIT handler's own restore the safety net for a failure in the next line.
#
# The failed run's installer log is carried across before its tree goes. An
# upgrade that put itself back has, by definition, removed the evidence of why
# it failed; that log is the only place the reason survives.
restore_retained_source_backup() {
  local install_parent install_name failed_dir diagnostics stamp
  [[ -n "${upgrade_backup_dir}" && -d "${upgrade_backup_dir}" ]] || return 1
  install_parent="$(dirname -- "${ORCASYNAPSE_INSTALL_DIR}")"
  install_name="$(basename -- "${ORCASYNAPSE_INSTALL_DIR}")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  failed_dir="${install_parent}/.${install_name}.failed.$$"
  [[ ! -e "${failed_dir}" ]] || rm -rf --one-file-system -- "${failed_dir}"
  if [[ -e "${ORCASYNAPSE_INSTALL_DIR}" ]]; then
    mv -- "${ORCASYNAPSE_INSTALL_DIR}" "${failed_dir}" || return 1
  fi
  backup_dir="${upgrade_backup_dir}"
  mv -- "${upgrade_backup_dir}" "${ORCASYNAPSE_INSTALL_DIR}" || return 1
  backup_dir=""
  upgrade_backup_dir=""
  if [[ -d "${failed_dir}/.local/state" ]]; then
    diagnostics="${ORCASYNAPSE_INSTALL_DIR}/.local/state/failed-upgrade-${stamp}"
    install -d -m 0700 "${diagnostics}"
    # Guarded by the -d above and tolerant of an empty match: an unmatched glob
    # expands to itself, and a cp that fails on it must not end the rollback
    # that is already most of the way through putting the machine back.
    cp -a -- "${failed_dir}/.local/state/"*.log "${diagnostics}/" 2>/dev/null || true
  fi
  [[ ! -d "${failed_dir}" ]] || rm -rf --one-file-system -- "${failed_dir}"
  return 0
}

# Discarded, not kept: a retained tree per upgrade would accumulate a full copy
# of the source for every release the machine ever took.
discard_retained_source_backup() {
  [[ -n "${upgrade_backup_dir}" ]] || return 0
  [[ ! -d "${upgrade_backup_dir}" ]] || rm -rf --one-file-system -- "${upgrade_backup_dir}"
  upgrade_backup_dir=""
}

# What happened, on disk, in the restored tree.
#
# This is the third self-referential trap answered: when the update agent drives
# an upgrade there is no terminal to read, and if the rollback was needed there
# may be no dashboard either. Whatever else fails, the reason has to be findable
# by a human who logged in afterwards and found the machine on its old version.
record_upgrade_rollback() {
  local outcome="$1" reason="$2" database_restored="$3" handoff_status="$4"
  local receipt="${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-upgrade-rollback.json"
  local escaped_reason="${reason//\\/\\\\}"
  escaped_reason="${escaped_reason//\"/\\\"}"
  # Only into an installation directory that already exists. A rollback that
  # failed between its two renames leaves that path deliberately absent, and the
  # EXIT handler's restore is a `mv` that requires it to stay that way -- so
  # creating it here to hold a record would block the last line of defence with
  # a note explaining why it was needed.
  [[ -d "${ORCASYNAPSE_INSTALL_DIR}" ]] || return 0
  install -d -m 0700 "${ORCASYNAPSE_INSTALL_DIR}/.local/state"
  printf '{"outcome":"%s","reason":"%s","databaseRestored":%s,"handoffStatus":%s,"fromVersion":"%s","fromCommit":"%s","toCommit":"%s","databaseBackup":"%s","at":"%s"}\n' \
    "${outcome}" "${escaped_reason}" "${database_restored}" "${handoff_status}" \
    "${upgrade_from_version}" "${upgrade_from_commit}" "${upgrade_to_commit}" \
    "${database_backup_path}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${receipt}"
  chmod 0600 "${receipt}"
}

# Whether the forward-only migrations moved the schema between the dump and now.
#
# This is the gate on the destructive half of the rollback, and it exists because
# the most likely upgrade failure by far is an image build that never reached the
# database at all. Restoring a dump unconditionally would throw away every write
# taken during the minutes that build ran -- on a deployment whose data was never
# in danger. Two fingerprints answer it: same means the migrations did not run,
# and the old code will find the database exactly as it left it.
#
# What this deliberately does not catch: a migration that changes only data and
# no column. Nothing about the schema moves for one of those, so the source is
# restored and the data is not. That is stated in docs/DATABASE_RESTORE_RUNBOOK.md
# rather than papered over, and ORCASYNAPSE_UPGRADE_RESTORE_DATABASE=always is
# the escape for a release known to carry one.
upgrade_needs_database_restore() {
  local now=""
  case "${ORCASYNAPSE_UPGRADE_RESTORE_DATABASE:-auto}" in
    always) info "A database restore was requested unconditionally."; return 0 ;;
    never)  warning "ORCASYNAPSE_UPGRADE_RESTORE_DATABASE=never: the database will not be restored."; return 1 ;;
  esac
  [[ -n "${upgrade_schema_fingerprint}" ]] || return 1
  now="$(database_schema_fingerprint "${upgrade_database_user}" "${upgrade_database_name}" || printf '')"
  if [[ -z "${now}" ]]; then
    # Unreadable is not the same as unchanged. The database could not be asked,
    # so the safe answer is the one that puts the dump back.
    warning "The database schema could not be read after the failure, so the pre-upgrade dump will be restored."
    return 0
  fi
  [[ "${now}" != "${upgrade_schema_fingerprint}" ]]
}

# The whole point of increment 4: an upgrade that failed after the swap puts the
# machine back on the release it came from, without a shell.
#
# Order is deliberate. The database goes first, while the failed tree -- and so
# the compose file whose containers are actually running -- is still in place.
# The source follows, and only then is the restored tree's own installer re-run,
# because the images the failed upgrade built carry the new code under the same
# tags: restoring source files alone would leave the previous release's
# compose.yaml starting the next release's images.
roll_back_failed_upgrade() {
  local handoff_status="$1"
  local database_restored=false outcome="rolled-back" reason="the upgrade failed after the source tree was replaced"
  local restore_status=0

  ui_panel_begin "${UI_RED}" "THE UPGRADE FAILED -- RESTORING THE PREVIOUS RELEASE" "="
  ui_panel_kv 'Failed at' "the host installer handoff (exit ${handoff_status})"
  ui_panel_kv 'Restoring' "${upgrade_from_version:-the previous release} (${upgrade_from_commit:0:12})"
  ui_panel_kv 'Source backup' "${upgrade_backup_dir:-none retained}"
  ui_panel_kv 'Database dump' "${database_backup_path:-none taken}"
  ui_panel_end "${UI_RED}" "="

  if [[ -n "${database_backup_path}" && -f "${database_backup_path}" \
    && -n "${upgrade_database_user}" && -n "${upgrade_database_name}" ]] \
    && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if upgrade_needs_database_restore; then
      # Everything that writes is stopped first, for the reason the runbook
      # gives: an api or worker still running would write during the restore.
      # Tolerant of services this deployment does not define -- the failure of
      # `stop` on a name that is not in the compose file is not a reason to
      # abandon a rollback.
      docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" stop api worker web \
        >/dev/null 2>&1 || true
      docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" up -d --no-build postgres \
        >/dev/null 2>&1 || true
      if run_with_progress "Wait for PostgreSQL before restoring" \
          wait_for_database "${upgrade_database_user}" "${upgrade_database_name}" \
        && run_with_progress "Restore ${upgrade_database_name} from the pre-upgrade dump" \
          restore_database_from_dump "${database_backup_path}" "${upgrade_database_user}" "${upgrade_database_name}"; then
        database_restored=true
        success "The database was restored from ${database_backup_path}."
      else
        outcome="database-restore-failed"
        reason="the forward-only migrations had run and the pre-upgrade dump could not be restored over them"
        warning "The database could not be restored automatically; the dump is still at ${database_backup_path}."
      fi
    else
      info "The schema is unchanged since the dump, so the database is left alone and no writes are discarded."
    fi
  else
    info "No usable pre-upgrade dump, so only the source tree is restored."
  fi

  if restore_retained_source_backup; then
    success "The previous release's source tree is back at ${ORCASYNAPSE_INSTALL_DIR}."
  else
    outcome="source-restore-failed"
    reason="the retained pre-upgrade source tree could not be moved back into place"
    warning "The pre-upgrade source tree could not be restored automatically."
  fi
  # Written before the restart is attempted, so the reason survives even if the
  # restart is what hangs or is what the operator interrupts.
  upgrade_rollback_outcome="${outcome}"
  record_upgrade_rollback "${outcome}" "${reason}" "${database_restored}" "${handoff_status}"

  if [[ "${outcome}" == "source-restore-failed" ]]; then
    return 1
  fi

  info "Bringing the deployment back up on ${upgrade_from_version:-the previous release}."
  set +e
  bash "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
  restore_status=$?
  set -e
  if (( restore_status != 0 )); then
    outcome="restored-but-not-running"
    reason="the previous release was put back but its installer exited ${restore_status}, so the deployment is not serving"
    upgrade_rollback_outcome="${outcome}"
    record_upgrade_rollback "${outcome}" "${reason}" "${database_restored}" "${handoff_status}"
  fi

  ui_panel_begin "${UI_AMBER}" "ROLLED BACK TO THE PREVIOUS RELEASE" "="
  ui_panel_kv 'Outcome' "${outcome}"
  ui_panel_kv 'Release' "${upgrade_from_version:-unknown} (${upgrade_from_commit:0:12})"
  ui_panel_kv 'Database restored' "${database_restored}"
  ui_panel_kv 'Dump' "${database_backup_path:-none}"
  ui_panel_kv 'Record' "${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-upgrade-rollback.json"
  ui_panel_kv 'Restore guide' "${ORCASYNAPSE_INSTALL_DIR}/docs/DATABASE_RESTORE_RUNBOOK.md"
  ui_panel_end "${UI_AMBER}" "="
  [[ "${outcome}" == "rolled-back" ]]
}

# The gate this whole path exists for: the four migrations under
# packages/database/drizzle/migrations are forward-only and have no down step,
# so an upgrade that fails after they run leaves a new schema under old code
# with no way back. Every exit from here is therefore either a dump on disk, a
# stated reason why there is no database to dump, or a failure that stops the
# upgrade before a single file has been staged.
back_up_database_before_upgrade() {
  local target_commit="$1"
  local secret="${ORCASYNAPSE_INSTALL_DIR}/.local/secrets/orcasynapse_database_url"
  local backups_dir="${ORCASYNAPSE_INSTALL_DIR}/.local/state/backups"
  local identity db_user db_name version stamp target partial trailer bytes

  # No database URL means this installation never provisioned a database, so the
  # migrations will build the schema from empty and there is nothing to lose.
  if [[ ! -s "${secret}" ]]; then
    warning "This installation has no database secret, so it has no database to preserve; continuing without a pre-upgrade dump."
    return 0
  fi
  # No Docker client at all means no container ever created a database on this
  # host. A Docker client with an unreachable daemon is a different situation
  # entirely, and not a safe one: the host installer this script hands off to
  # starts Docker itself and then migrates, so the volume is still on disk and
  # the migration would still reach it.
  if ! command -v docker >/dev/null 2>&1; then
    warning "Docker is not installed on this host, so there is no database to preserve; continuing without a pre-upgrade dump."
    return 0
  fi
  docker info >/dev/null 2>&1 \
    || fail "the Docker daemon is not reachable, so the database cannot be backed up before the forward-only migrations run; start Docker (systemctl start docker) and run this installer again"
  docker compose version >/dev/null 2>&1 \
    || fail "Docker Compose v2 is required to back up the database before upgrading"

  identity="$(database_identity_from_secret)" \
    || fail "the protected database URL secret is not a connection URL this installer can dump; restore the complete protected secret set before upgrading"
  db_user="${identity%% *}"
  db_name="${identity##* }"

  # A stopped stack still has its data volume, and the host installer would
  # start it and migrate it, so "not running" is a reason to start PostgreSQL
  # rather than a reason to skip the dump. Only postgres is started, and the
  # handoff starts the whole stack a few minutes later regardless.
  #
  # Reachability is the question, so reachability is what is asked -- rather
  # than `compose ps`, whose answer depends on which of `-q`, `-a` and
  # `--status` the installed Compose understands.
  if ! docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" exec -T postgres \
      pg_isready -h 127.0.0.1 -U "${db_user}" -d "${db_name}" >/dev/null 2>&1; then
    run_with_progress "Start PostgreSQL for the pre-upgrade backup" \
      docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" up -d --no-build postgres \
      || fail "PostgreSQL could not be started to take the pre-upgrade database dump; nothing has been changed"
  fi
  run_with_progress "Wait for PostgreSQL to accept connections" wait_for_database "${db_user}" "${db_name}" \
    || fail "PostgreSQL did not accept connections within two minutes, so the pre-upgrade database dump could not be taken; nothing has been changed"

  version="$(existing_install_version)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  # 0700, alongside .local/secrets: a dump is the entire application database in
  # plain SQL, which is every secret the database holds and every customer row.
  #
  # Under .local, so upgrade_source_tree carries it into the new tree with the
  # rest of the protected state. That copy is why retention is three and not
  # thirty: every upgrade briefly holds two copies of everything kept here.
  install -d -m 0700 "${backups_dir}"
  target="${backups_dir}/${version}-${stamp}.sql.gz"
  partial="${target}.partial"
  rm -f -- "${partial}"

  # Written under a .partial name and renamed only once proven complete.
  # Retention and every restore procedure treat a *.sql.gz as usable, and a
  # truncated dump that looks usable is worse than no dump at all.
  run_with_progress "Back up ${db_name} before migrating" \
    run_database_dump "${partial}" "${db_user}" "${db_name}" \
    || { rm -f -- "${partial}"; fail "the pre-upgrade database dump failed; nothing has been changed. These migrations cannot be undone, so an upgrade that cannot be reversed must not begin: correct the reported error and run this installer again"; }

  # Three questions, because a dump can fail in three ways that all leave a file
  # behind and all report success: an unreadable archive, a readable archive
  # holding nothing, and a readable archive holding a stream pg_dump abandoned
  # partway. Only the trailer answers the third, because pg_dump writes it last.
  #
  # Note what is deliberately *not* checked: the size of the gzip file. gzip
  # writes a valid twenty-byte archive for an empty input, so a dump that
  # produced not one row still passes `test -s` -- a check that reads like a
  # guard and can never fire.
  if ! gzip -t -- "${partial}" 2>/dev/null; then
    rm -f -- "${partial}"
    fail "the pre-upgrade database dump is not a readable gzip archive; nothing has been changed and the upgrade was not started"
  fi
  # One decompression pass answers both remaining questions. Read through a
  # command substitution rather than piped into grep: grep -q exits on its first
  # match, the writer ahead of it dies on the broken pipe, and under
  # `set -o pipefail` a successful match would then report failure.
  trailer="$(gzip -cd -- "${partial}" | tail -c 4096 || true)"
  if [[ -z "${trailer}" ]]; then
    rm -f -- "${partial}"
    fail "the pre-upgrade database dump is empty -- PostgreSQL returned no data; nothing has been changed and the upgrade was not started"
  fi
  if [[ "${trailer}" != *"PostgreSQL database dump complete"* ]]; then
    rm -f -- "${partial}"
    fail "the pre-upgrade database dump is incomplete -- pg_dump did not write its end marker; nothing has been changed and the upgrade was not started"
  fi

  mv -- "${partial}" "${target}"
  chmod 0600 "${target}"
  database_backup_path="${target}"
  # Held for the rollback, which runs after the swap has replaced the tree these
  # were read from. The fingerprint is taken here, immediately after the dump, so
  # that it describes the same schema the dump holds -- the pair is what lets a
  # failed upgrade answer "did the migrations actually move anything" rather than
  # assume they did and destroy writes that happened while the images built.
  upgrade_database_user="${db_user}"
  upgrade_database_name="${db_name}"
  upgrade_from_version="${version}"
  upgrade_schema_fingerprint="$(database_schema_fingerprint "${db_user}" "${db_name}" || printf '')"
  [[ -n "${upgrade_schema_fingerprint}" ]] \
    || fail "the database schema could not be fingerprinted before the upgrade, so a failed upgrade could not tell whether the forward-only migrations had run; nothing has been changed"
  # Exported for the host installer and for the update agent that will drive
  # this path without an operator at a terminal.
  export ORCASYNAPSE_DATABASE_BACKUP_PATH="${target}"
  bytes="$(stat -c '%s' "${target}" 2>/dev/null || printf '0')"
  record_database_backup "${target}" "${version}" "${bytes}" "${target_commit}"
  prune_database_backups "${backups_dir}"
  success "Database dump written to ${target} ($(format_transfer_bytes "${bytes}"))."
}

upgrade_source_tree() {
  local install_parent install_name
  install_parent="$(dirname -- "${ORCASYNAPSE_INSTALL_DIR}")"
  install_name="$(basename -- "${ORCASYNAPSE_INSTALL_DIR}")"

  if [[ -e "${ORCASYNAPSE_INSTALL_DIR}/.local" ]]; then
    [[ -d "${ORCASYNAPSE_INSTALL_DIR}/.local" && ! -L "${ORCASYNAPSE_INSTALL_DIR}/.local" ]] \
      || fail "the existing protected local-state path is not a regular directory"
    cp -a -- "${ORCASYNAPSE_INSTALL_DIR}/.local" "${staging_dir}/.local"
  fi

  if [[ -r "${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit" ]]; then
    upgrade_from_commit="$(<"${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit")"
  fi
  # `|| printf ''` because existing_install_version reads through `sed | head`,
  # and under pipefail a successful read whose head closes first is reported as a
  # failure -- which errexit would turn into an abort one line before the swap.
  if [[ -z "${upgrade_from_version}" ]]; then
    upgrade_from_version="$(existing_install_version || printf '')"
  fi

  backup_dir="${install_parent}/.${install_name}.backup.$$"
  [[ ! -e "${backup_dir}" ]] || fail "temporary source-backup path already exists: ${backup_dir}"
  mv -- "${ORCASYNAPSE_INSTALL_DIR}" "${backup_dir}"
  mv -- "${staging_dir}" "${ORCASYNAPSE_INSTALL_DIR}"
  staging_dir=""
  # The two lines that used to be here deleted this backup and cleared the
  # variable, which is what left the restore window exactly one rename wide.
  # Ownership is handed over instead: `backup_dir` still means "restore me if the
  # installation directory is missing", which is only true between the renames
  # above, and `upgrade_backup_dir` means "the previous release, kept until this
  # upgrade is known to be healthy".
  #
  # ORCASYNAPSE_UPGRADE_ROLLBACK=off restores the old behaviour exactly, for the
  # operator at a terminal who wants the failed state left in place to look at.
  if [[ "${ORCASYNAPSE_UPGRADE_ROLLBACK:-on}" == "off" ]]; then
    rm -rf --one-file-system -- "${backup_dir}"
    backup_dir=""
    warning "ORCASYNAPSE_UPGRADE_ROLLBACK=off: a failed upgrade will not restore the previous release."
  else
    upgrade_backup_dir="${backup_dir}"
    backup_dir=""
  fi
  success "Application source updated; PostgreSQL volumes and protected local secrets were preserved."
}

install_source_tree() {
  local commit="$1" source_dir="$2" action="" verified=0
  local marker="${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit"

  if [[ -e "${ORCASYNAPSE_INSTALL_DIR}" || -L "${ORCASYNAPSE_INSTALL_DIR}" ]]; then
    if existing_install_is_verified; then
      verified=1
      if [[ "$(<"${marker}")" == "${commit}" ]]; then
        success "The same verified source is already installed; existing data and secrets will be preserved."
        export ORCASYNAPSE_BOOTSTRAP_BRANDED=1
        exec bash "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
      fi
    fi

    choose_existing_install_action "${verified}" "${commit}"
    action="${existing_install_action}"
    case "${action}" in
      abort) fail "installation cancelled; no changes were made" ;;
      erase)
        warning "Destructive confirmation accepted; starting the clean reinstall."
        clean_existing_install
        ;;
      upgrade)
        upgrade_to_commit="${commit}"
        # Before anything is staged, copied or moved. The dump is the only way
        # back from a forward-only migration, so an upgrade that cannot produce
        # one must not start -- at this point failing costs the operator
        # nothing, because the installation is still entirely untouched.
        back_up_database_before_upgrade "${commit}"
        ;;
      *) fail "existing-installation action could not be resolved" ;;
    esac
  fi

  stage_source_tree "${commit}" "${source_dir}"
  if [[ "${action}" == "upgrade" ]]; then
    upgrade_source_tree
    return
  fi

  mv -- "${staging_dir}" "${ORCASYNAPSE_INSTALL_DIR}"
  staging_dir=""
}

main() {
  # Before the banner and before any network call: a mistyped scheme should cost
  # a line of output, not a download and a build.
  orcasynapse_take_public_scheme_flag "$@"
  if (( ${#ORCASYNAPSE_REMAINING_ARGS[@]} > 0 )); then
    fail "unrecognised argument '${ORCASYNAPSE_REMAINING_ARGS[0]}'; this bootstrap takes only --public-scheme http|https"
  fi

  banner
  step 1 4 "Preflight checks"
  require_root
  install_bootstrap_dependencies
  validate_inputs
  success "Host and installation settings are valid."

  local commit archive source_dir
  step 2 4 "Resolve a reproducible release"
  commit="$(resolve_commit)"
  success "GitHub ref '${ORCASYNAPSE_REF}' resolves to ${commit}."
  temporary_root="$(mktemp -d /tmp/orcasynapse-install.XXXXXX)"
  archive="${temporary_root}/source.tar.gz"
  source_dir="${temporary_root}/source"
  install -d -m 0700 "${source_dir}"

  step 3 4 "Download and verify OrcaSynapse"
  download_release_source "${commit}" "${archive}"
  tar -xzf "${archive}" --strip-components=1 -C "${source_dir}"
  [[ -f "${source_dir}/compose.yaml" && -r "${source_dir}/scripts/install-orcasynapse.sh" ]] \
    || fail "the downloaded commit is not an intact OrcaSynapse release source tree"

  install_source_tree "${commit}" "${source_dir}"
  step 4 4 "Provision the control plane"
  success "Verified source installed at ${ORCASYNAPSE_INSTALL_DIR}."
  info "Handing off to the host installer. Builds can take several minutes."
  export ORCASYNAPSE_BOOTSTRAP_BRANDED=1
  # An upgrade is supervised rather than exec'd. `exec` replaces this process,
  # and with it the EXIT handler holding the only pointer to the dump and the
  # only pointer to the retained source tree -- so the one run that most needs
  # both, a handoff that fails after the migrations have already altered the
  # schema, would be the one run unable to reach either. Nothing else changes:
  # exported variables cross a child exactly as they cross an exec.
  #
  # A fresh install still execs. It has no backup to hold and nothing to roll
  # back to, so there is no reason to keep a second process alive for it.
  if [[ -n "${upgrade_backup_dir}" || -n "${database_backup_path}" ]]; then
    local handoff_status=0
    set +e
    bash "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
    handoff_status=$?
    set -e
    if (( handoff_status == 0 )); then
      # Only here, with the handoff's own readiness wait already satisfied, is
      # the previous release safe to throw away.
      discard_retained_source_backup
      return 0
    fi
    if [[ -z "${upgrade_backup_dir}" ]]; then
      # Nothing was retained -- ORCASYNAPSE_UPGRADE_ROLLBACK=off, or this was
      # not an upgrade at all. The EXIT handler's dump panel is the whole of the
      # recovery story, exactly as it was before increment 4.
      fail "the host installer exited ${handoff_status}; the previous release was not restored"
    fi
    if roll_back_failed_upgrade "${handoff_status}"; then
      fail "the upgrade failed (host installer exit ${handoff_status}) and this deployment was restored to ${upgrade_from_version:-the previous release}"
    fi
    fail "the upgrade failed (host installer exit ${handoff_status}) and the rollback did not complete; read ${ORCASYNAPSE_INSTALL_DIR}/.local/state/last-upgrade-rollback.json"
  fi
  exec bash "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
}

if [[ "${ORCASYNAPSE_INSTALLER_LIBRARY_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
