#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_GITHUB_REPOSITORY="${ORCASYNAPSE_GITHUB_REPOSITORY:-multichainerz/AI}"
ORCASYNAPSE_REF="${ORCASYNAPSE_REF:-main}"
ORCASYNAPSE_INSTALL_DIR="${ORCASYNAPSE_INSTALL_DIR:-/opt/orcasynapse}"
ORCASYNAPSE_ARCHIVE_SHA256="${ORCASYNAPSE_ARCHIVE_SHA256:-}"

temporary_root=""
staging_dir=""
backup_dir=""

if [[ -t 1 && "${TERM:-dumb}" != "dumb" ]]; then
  UI_INTERACTIVE=1
else
  UI_INTERACTIVE=0
fi

if (( UI_INTERACTIVE )) && [[ -z "${NO_COLOR:-}" ]]; then
  UI_BOLD=$'\033[1m'
  UI_DIM=$'\033[2m'
  UI_BLUE=$'\033[38;5;75m'
  UI_CYAN=$'\033[38;5;80m'
  UI_GREEN=$'\033[38;5;78m'
  UI_AMBER=$'\033[38;5;214m'
  UI_RED=$'\033[38;5;203m'
  UI_RESET=$'\033[0m'
else
  UI_BOLD=""
  UI_DIM=""
  UI_BLUE=""
  UI_CYAN=""
  UI_GREEN=""
  UI_AMBER=""
  UI_RED=""
  UI_RESET=""
fi

ui_pause() {
  (( UI_INTERACTIVE )) && sleep "${1:-0.08}"
  return 0
}

banner() {
  printf '%b' "${UI_BLUE}${UI_BOLD}"
  cat <<'EOF'

     ____                _____
    / __ \___________ _ / ___/__  ______  ____ _____  ________
   / / / / ___/ ___/  '/\__ \/ / / / __ \/ __ `/ __ \/ ___/ _ \
  / /_/ / /  / /__/ /| |__/ / /_/ / / / / /_/ / /_/ (__  )  __/
  \____/_/   \___/_/ |_/____/\__, /_/ /_/\__,_/ .___/____/\___/
                             /____/            /_/

EOF
  printf '%b\n' "${UI_RESET}${UI_DIM}  PRIVATE AI CONTROL PLANE  /  SECURE HOST BOOTSTRAP${UI_RESET}"
  printf '%b\n' "${UI_DIM}  ----------------------------------------------------------------------${UI_RESET}"
  if (( UI_INTERACTIVE )); then
    local dots
    printf '  Initializing verified installation'
    for dots in 1 2 3; do
      printf '%b.%b' "${UI_CYAN}" "${UI_RESET}"
      ui_pause 0.12
    done
    printf ' %bREADY%b\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}"
  fi
}

step() {
  local current="$1" total="$2" label="$3" width=28 filled empty progress remainder
  filled=$((current * width / total))
  empty=$((width - filled))
  printf -v progress '%*s' "${filled}" ''
  printf -v remainder '%*s' "${empty}" ''
  progress="${progress// /#}"
  remainder="${remainder// /.}"
  printf '\n%b  STEP %02d OF %02d%b  %b%s%b\n' \
    "${UI_CYAN}${UI_BOLD}" "${current}" "${total}" "${UI_RESET}" "${UI_BOLD}" "${label}" "${UI_RESET}"
  printf '  %b[%s%s]%b %3d%%\n' "${UI_BLUE}" "${progress}" "${remainder}" "${UI_RESET}" "$((current * 100 / total))"
}

info() {
  printf '      %b>%b %s\n' "${UI_BLUE}" "${UI_RESET}" "$1"
}

success() {
  printf '  %b[ OK ]%b %s\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}" "$1"
}

warning() {
  printf '  %b[WARN]%b %s\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" "$1" >&2
}

run_with_spinner() {
  local label="$1"
  shift
  if (( ! UI_INTERACTIVE )); then
    info "${label}"
    "$@"
    success "${label}"
    return
  fi

  local log_file pid status=0 frame_index=0 started elapsed
  local frames=('|' '/' '-' '\')
  log_file="$(mktemp /tmp/orcasynapse-command.XXXXXX)"
  started="${SECONDS}"
  "$@" >"${log_file}" 2>&1 &
  pid=$!
  printf '\033[?25l'
  while kill -0 "${pid}" 2>/dev/null; do
    elapsed=$((SECONDS - started))
    printf '\r  %b[%s]%b %-48s %4ss' "${UI_CYAN}${UI_BOLD}" "${frames[frame_index]}" "${UI_RESET}" "${label}" "${elapsed}"
    frame_index=$(((frame_index + 1) % ${#frames[@]}))
    sleep 0.12
  done
  if wait "${pid}"; then status=0; else status=$?; fi
  printf '\r\033[2K\033[?25h'
  if (( status == 0 )); then
    rm -f -- "${log_file}"
    success "${label}"
    return 0
  fi

  printf '  %b[FAIL]%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "${label}" >&2
  tail -n 120 "${log_file}" >&2 || true
  rm -f -- "${log_file}"
  return "${status}"
}

fail() {
  printf '\n%bERROR%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "$1" >&2
  exit 1
}

cleanup() {
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
}
trap cleanup EXIT

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "run this installer as root (for example: sudo bash install.sh)"
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

  run_with_spinner "Refresh operating-system packages" apt-get update \
    || fail "could not refresh operating-system packages"
  run_with_spinner "Install bootstrap dependencies" env DEBIAN_FRONTEND=noninteractive \
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
  run_with_spinner "Download immutable source ${commit:0:12}" \
    curl --fail --silent --show-error --location --retry 3 --max-time 300 \
    "https://codeload.github.com/${ORCASYNAPSE_GITHUB_REPOSITORY}/tar.gz/${commit}" \
    --output "${archive}" \
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

choose_existing_install_action() {
  local verified="$1" requested_commit="$2"
  local configured_action="${ORCASYNAPSE_EXISTING_INSTALL_ACTION:-}" choice=""

  if [[ -n "${configured_action}" ]]; then
    case "${configured_action}" in
      upgrade)
        [[ "${verified}" == "1" ]] || fail "cannot upgrade an unverified directory; use an empty path or explicitly choose erase"
        printf 'upgrade'
        return
        ;;
      erase)
        [[ "${ORCASYNAPSE_CONFIRM_ERASE:-}" == "ERASE" ]] \
          || fail "automated erase requires ORCASYNAPSE_CONFIRM_ERASE=ERASE"
        printf 'erase'
        return
        ;;
      abort)
        printf 'abort'
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
    if [[ "${verified}" == "1" ]]; then
      printf '   Installed: %.12s\n' "$(<"${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit")"
      printf '   Requested: %.12s\n\n' "${requested_commit}"
      printf '   %b1%b  Update application source; preserve PostgreSQL and secrets %b[recommended]%b\n' \
        "${UI_CYAN}${UI_BOLD}" "${UI_RESET}" "${UI_GREEN}" "${UI_RESET}"
      printf '   %b2%b  Clean reinstall; permanently erase containers, volumes, accounts, and secrets\n' \
        "${UI_RED}${UI_BOLD}" "${UI_RESET}"
      printf '   %b3%b  Exit without changes\n' "${UI_DIM}" "${UI_RESET}"
      printf '\n   Select an action [1]: '
    else
      printf '   This directory is not a verified OrcaSynapse source tree.\n\n'
      printf '   %b1%b  Clean the directory and install from scratch\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}"
      printf '   %b2%b  Exit without changes\n' "${UI_DIM}" "${UI_RESET}"
      printf '\n   Select an action [2]: '
    fi
  } > /dev/tty

  IFS= read -r choice < /dev/tty
  if [[ "${verified}" == "1" ]]; then
    case "${choice:-1}" in
      1) printf 'upgrade'; return ;;
      2) choice="erase" ;;
      3) printf 'abort'; return ;;
      *) fail "invalid existing-installation selection" ;;
    esac
  else
    case "${choice:-2}" in
      1) choice="erase" ;;
      2) printf 'abort'; return ;;
      *) fail "invalid existing-directory selection" ;;
    esac
  fi

  printf '\n   %bDESTRUCTIVE ACTION%b\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" > /dev/tty
  printf '   Type ERASE to permanently remove this installation and its data: ' > /dev/tty
  IFS= read -r choice < /dev/tty
  printf '\n' > /dev/tty
  [[ "${choice}" == "ERASE" ]] || fail "clean reinstall cancelled; no data was removed"
  printf 'erase'
}

clean_existing_install() {
  local resolved_target
  resolved_target="$(realpath -m -- "${ORCASYNAPSE_INSTALL_DIR}")"
  [[ "${resolved_target}" == "${ORCASYNAPSE_INSTALL_DIR}" && "${resolved_target}" != "/" ]] \
    || fail "refusing to clean an unresolved or filesystem-root installation path"

  if [[ -f "${ORCASYNAPSE_INSTALL_DIR}/compose.yaml" ]] \
    && command -v docker >/dev/null 2>&1 \
    && docker compose version >/dev/null 2>&1; then
    run_with_spinner "Remove existing containers and data volumes" \
      docker compose --project-directory "${ORCASYNAPSE_INSTALL_DIR}" down --remove-orphans --volumes \
      || fail "Docker could not cleanly remove the existing OrcaSynapse stack"
  fi

  rm -rf --one-file-system -- "${resolved_target}"
  [[ ! -e "${resolved_target}" ]] || fail "the existing installation directory could not be removed"
  success "Existing application files, local secrets, and managed data volumes were removed."
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

  backup_dir="${install_parent}/.${install_name}.backup.$$"
  [[ ! -e "${backup_dir}" ]] || fail "temporary source-backup path already exists: ${backup_dir}"
  mv -- "${ORCASYNAPSE_INSTALL_DIR}" "${backup_dir}"
  mv -- "${staging_dir}" "${ORCASYNAPSE_INSTALL_DIR}"
  staging_dir=""
  rm -rf --one-file-system -- "${backup_dir}"
  backup_dir=""
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

    action="$(choose_existing_install_action "${verified}" "${commit}")"
    case "${action}" in
      abort) fail "installation cancelled; no changes were made" ;;
      erase) clean_existing_install ;;
      upgrade) ;;
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
  exec bash "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
}

if [[ "${ORCASYNAPSE_INSTALLER_LIBRARY_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
