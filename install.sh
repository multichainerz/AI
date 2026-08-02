#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_GITHUB_REPOSITORY="${ORCASYNAPSE_GITHUB_REPOSITORY:-multichainerz/AI}"
ORCASYNAPSE_REF="${ORCASYNAPSE_REF:-main}"
ORCASYNAPSE_INSTALL_DIR="${ORCASYNAPSE_INSTALL_DIR:-/opt/orcasynapse}"
ORCASYNAPSE_ARCHIVE_SHA256="${ORCASYNAPSE_ARCHIVE_SHA256:-}"

temporary_root=""
staging_dir=""

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != "dumb" ]]; then
  UI_BOLD=$'\033[1m'
  UI_DIM=$'\033[2m'
  UI_BLUE=$'\033[38;5;75m'
  UI_CYAN=$'\033[38;5;80m'
  UI_GREEN=$'\033[38;5;78m'
  UI_RED=$'\033[38;5;203m'
  UI_RESET=$'\033[0m'
else
  UI_BOLD=""
  UI_DIM=""
  UI_BLUE=""
  UI_CYAN=""
  UI_GREEN=""
  UI_RED=""
  UI_RESET=""
fi

banner() {
  printf '%b' "${UI_BLUE}${UI_BOLD}"
  cat <<'EOF'

       __
  ____/ /_________ ____
 / __  / ___/ ___/ __ \       ORCASYNAPSE
/ /_/ / /  / /__/ /_/ /       Private AI. Governed locally.
\__,_/_/   \___/\____/

EOF
  printf '%b\n' "${UI_RESET}${UI_DIM}  Secure control-plane bootstrap  |  PostgreSQL  |  Docker Compose${UI_RESET}"
}

step() {
  printf '\n%b[%s/%s]%b %b%s%b\n' \
    "${UI_CYAN}${UI_BOLD}" "$1" "$2" "${UI_RESET}" "${UI_BOLD}" "$3" "${UI_RESET}"
}

info() {
  printf '      %b>%b %s\n' "${UI_BLUE}" "${UI_RESET}" "$1"
}

success() {
  printf '      %bOK%b %s\n' "${UI_GREEN}${UI_BOLD}" "${UI_RESET}" "$1"
}

fail() {
  printf '\n%bERROR%b %s\n' "${UI_RED}${UI_BOLD}" "${UI_RESET}" "$1" >&2
  exit 1
}

cleanup() {
  [[ -z "${temporary_root}" || ! -d "${temporary_root}" ]] || rm -rf -- "${temporary_root}"
  [[ -z "${staging_dir}" || ! -d "${staging_dir}" ]] || rm -rf -- "${staging_dir}"
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

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar coreutils
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
  info "Downloading '${ORCASYNAPSE_REF}' at immutable commit ${commit:0:12}."
  curl --fail --silent --show-error --location --retry 3 --max-time 300 \
    "https://codeload.github.com/${ORCASYNAPSE_GITHUB_REPOSITORY}/tar.gz/${commit}" \
    --output "${archive}"

  local actual_checksum
  actual_checksum="$(sha256sum "${archive}" | awk '{print $1}')"
  if [[ -n "${ORCASYNAPSE_ARCHIVE_SHA256}" && "${actual_checksum,,}" != "${ORCASYNAPSE_ARCHIVE_SHA256,,}" ]]; then
    fail "downloaded archive checksum does not match ORCASYNAPSE_ARCHIVE_SHA256"
  fi
  success "Archive verified (sha256: ${actual_checksum})."
}

install_source_tree() {
  local commit="$1" source_dir="$2"
  local marker="${ORCASYNAPSE_INSTALL_DIR}/.orcasynapse-source-commit"

  if [[ -d "${ORCASYNAPSE_INSTALL_DIR}" ]]; then
    if [[ -r "${marker}" && "$(<"${marker}")" == "${commit}" \
      && -r "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh" ]]; then
      success "The same verified source is already installed; existing data and secrets will be preserved."
      export ORCASYNAPSE_BOOTSTRAP_BRANDED=1
      exec bash "${ORCASYNAPSE_INSTALL_DIR}/scripts/install-orcasynapse.sh"
    fi
    fail "${ORCASYNAPSE_INSTALL_DIR} already exists with different or unverified source; refusing to overwrite application or secret material"
  fi

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

main "$@"
