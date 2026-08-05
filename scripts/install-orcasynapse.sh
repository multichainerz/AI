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

UI_BANNER_TAGLINE="PRIVATE AI CONTROL PLANE  /  VM1 PROVISIONING"
UI_BANNER_ACTIVITY="Establishing secure installation context"
TOTAL_STEPS=7

# Restore the cursor if an animated section is interrupted, and close the log.
trap 'ui_show_cursor; ui_log "install finished status=$?"' EXIT

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "run this release-bundle installer as root (for example: sudo ./scripts/install-orcasynapse.sh)"
  fi
}

install_host_dependencies() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
    && command -v openssl >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    return
  fi

  [[ -r /etc/os-release ]] || fail "automatic dependency installation supports Debian and Ubuntu; install Docker Compose v2, OpenSSL, and curl first"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) fail "automatic dependency installation supports Debian and Ubuntu; install Docker Compose v2, OpenSSL, and curl first" ;;
  esac

  run_with_progress "Refresh operating-system packages" apt-get update \
    || fail "could not refresh operating-system packages"
  run_with_progress "Install Docker and security dependencies" env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y ca-certificates curl openssl docker.io \
    || fail "could not install Docker and security dependencies"
  if ! run_with_progress "Install Docker Compose v2" apt-get install -y docker-compose-v2; then
    run_with_progress "Install Docker Compose plugin" apt-get install -y docker-compose-plugin \
      || fail "could not install Docker Compose v2"
  fi
  run_with_progress "Enable the Docker service" systemctl enable --now docker \
    || fail "could not enable the Docker service"
}

validate_inputs() {
  [[ -f "${ORCASYNAPSE_ROOT}/compose.yaml" ]] || fail "compose.yaml is missing; run this script from an intact OrcaSynapse release bundle"
  [[ "${ORCASYNAPSE_HTTP_PORT}" =~ ^[0-9]+$ ]] && (( ORCASYNAPSE_HTTP_PORT >= 1 && ORCASYNAPSE_HTTP_PORT <= 65535 )) \
    || fail "ORCASYNAPSE_HTTP_PORT must be an integer from 1 through 65535"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
}

secret_file() {
  printf '%s/%s' "${ORCASYNAPSE_SECRET_DIR}" "$1"
}

all_secrets_exist() {
  local name
  for name in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
    [[ -f "$(secret_file "${name}")" && ! -L "$(secret_file "${name}")" && -s "$(secret_file "${name}")" ]] || return 1
  done
}

any_secret_exists() {
  local name
  for name in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
    [[ -e "$(secret_file "${name}")" ]] && return 0
  done
  return 1
}

write_secret() {
  local name="$1"
  local value="$2"
  ( set -o noclobber; printf '%s' "${value}" > "$(secret_file "${name}")" ) \
    || fail "refusing to replace existing secret '${name}'"
  chmod 0600 "$(secret_file "${name}")"
}

protect_secret_files() {
  local name path
  install -d -o root -g root -m 0700 "${ORCASYNAPSE_SECRET_DIR}"

  path="$(secret_file postgres_password)"
  [[ -f "${path}" && ! -L "${path}" ]] || fail "the PostgreSQL secret is not a protected regular file"
  chown root:root "${path}"
  chmod 0600 "${path}"

  for name in orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
    path="$(secret_file "${name}")"
    [[ -f "${path}" && ! -L "${path}" ]] || fail "application secret '${name}' is not a protected regular file"
    # node:24-bookworm-slim defines the unprivileged node group as GID 1000.
    # The root-only parent directory keeps these files inaccessible to host
    # users, while this group assignment makes the individual Docker secret
    # mounts readable by the non-root API, worker, and migration processes.
    chown "root:${ORCASYNAPSE_APPLICATION_SECRET_GID}" "${path}"
    chmod 0640 "${path}"
  done
}

generate_secrets() {
  any_secret_exists && fail "bootstrap material is incomplete or already exists; restore the complete protected secret set instead of regenerating over it"
  install -d -m 0700 "${ORCASYNAPSE_SECRET_DIR}"

  local postgres_password master_key installation_key
  postgres_password="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
  master_key="$(openssl rand -base64 32 | tr -d '\n')"
  installation_key="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"

  write_secret postgres_password "${postgres_password}"
  write_secret orcasynapse_database_url "postgresql://orcasynapse:${postgres_password}@postgres:5432/orcasynapse"
  write_secret orcasynapse_master_key "${master_key}"
  write_secret orcasynapse_installation_key "${installation_key}"
}

migrate_legacy_installation_secret() {
  local legacy_key legacy_expiry
  legacy_key="$(secret_file orcasynapse_bootstrap_token)"
  legacy_expiry="$(secret_file orcasynapse_installation_claim_expires_at)"
  if [[ ! -s "$(secret_file orcasynapse_installation_key)" && -s "${legacy_key}" ]]; then
    mv -- "${legacy_key}" "$(secret_file orcasynapse_installation_key)"
    chmod 0600 "$(secret_file orcasynapse_installation_key)"
    rm -f -- "${legacy_expiry}"
    success "Migrated the prior bootstrap credential to the permanent Installation Key."
  fi
}

seed_embedding_model() {
  # Pull the approved embedding weights into the shared model cache now, rather
  # than on the first upload.
  #
  # Two reasons this is not optional. An air-gapped installation has no way to
  # fetch them later, and the code has always assumed they were "seeded at
  # install time"; and a cold first upload otherwise downloads ~2 GB inside an
  # HTTP request, which outlives any sane proxy timeout.
  #
  # Non-fatal: an installation that cannot reach the model host is still usable
  # for everything except retrieval, and saying so beats refusing to install.
  # Imported by built path, not by package name: `node -e` resolves from
  # "[eval1]" rather than a file in the workspace, so the bare specifier
  # "@orcasynapse/knowledge" is not found even though the worker's own entry
  # point imports it happily.
  if docker compose run --rm --no-deps \
       -e ORCASYNAPSE_MODEL_CACHE_DIR=/var/lib/orcasynapse/models \
       worker node -e '
         const { LocalBgeM3Embedder } = await import("/app/packages/knowledge/dist/index.js");
         await new LocalBgeM3Embedder().embed(["installation warm-up"]);
       ' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

start_stack() {
  if run_with_progress "Start PostgreSQL and application services" docker compose up -d --no-build; then
    return
  fi

  warning "The application stack did not reach its expected start state."
  printf '\n%b--- Service status ---%b\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  docker compose ps -a >&2 || true
  printf '\n%b--- Database migration diagnostics ---%b\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  docker compose logs --no-color --tail 160 migrate >&2 || true
  printf '%b--- End diagnostics ---%b\n\n' "${UI_AMBER}${UI_BOLD}" "${UI_RESET}" >&2
  fail "startup stopped safely; no data was deleted. After correcting the reported issue, rerun this installer or reproduce the migration with: cd '${ORCASYNAPSE_ROOT}' && docker compose run --rm migrate"
}

wait_for_orcasynapse() {
  local deadline=$((SECONDS + 300))
  until curl --fail --silent --show-error "http://127.0.0.1:${ORCASYNAPSE_HTTP_PORT}/readyz" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      docker compose --project-directory "${ORCASYNAPSE_ROOT}" ps >&2 || true
      docker compose --project-directory "${ORCASYNAPSE_ROOT}" logs --no-color --tail 120 api >&2 || true
      fail "OrcaSynapse did not become ready within five minutes; inspect 'docker compose logs'"
    fi
    sleep 2
  done
}

# The postgres service moved from postgres:17-alpine (musl) to
# pgvector/pgvector:pg17 (glibc). Locale collation differs between the two
# libcs, so text btree indexes built under the old image can be mis-ordered
# under the new one. Reindex once for data volumes that predate the switch,
# then record completion so subsequent runs skip it.
reindex_after_libc_migration() {
  local volume_preexisted="$1"
  local state_dir="${ORCASYNAPSE_ROOT}/.local/state"
  local marker="${state_dir}/postgres-libc-reindexed"
  [[ -f "${marker}" ]] && return 0
  if (( volume_preexisted )); then
    run_with_progress "Reindex PostgreSQL after the base-image migration" \
      docker compose exec -T postgres reindexdb --username orcasynapse --dbname orcasynapse --quiet \
      || fail "could not reindex PostgreSQL after the base-image migration"
  fi
  install -d -m 0700 "${state_dir}"
  : > "${marker}"
  chmod 0600 "${marker}"
}

preflight_checks() {
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not running; start it with: systemctl start docker"

  local stack_owns_port=0
  if [[ -n "$(docker compose ps -q 2>/dev/null || true)" ]]; then
    stack_owns_port=1
    info "An existing OrcaSynapse stack is running and will be updated in place."
  fi
  if (( ! stack_owns_port )) && command -v ss >/dev/null 2>&1 \
    && [[ -n "$(ss -ltnH "sport = :${ORCASYNAPSE_HTTP_PORT}" 2>/dev/null || true)" ]]; then
    fail "TCP port ${ORCASYNAPSE_HTTP_PORT} is already in use; stop the conflicting service or set ORCASYNAPSE_HTTP_PORT"
  fi

  local free_root_gib free_docker_gib
  free_root_gib="$(df -Pk "${ORCASYNAPSE_ROOT}" 2>/dev/null | awk 'NR==2 {print int($4/1048576)}' || true)"
  free_docker_gib="$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2 {print int($4/1048576)}' || true)"
  free_docker_gib="${free_docker_gib:-${free_root_gib:-0}}"
  if [[ -n "${free_root_gib}" ]] && (( free_root_gib < 5 )); then
    fail "only ${free_root_gib} GiB free under ${ORCASYNAPSE_ROOT}; at least 5 GiB is required"
  fi
  if (( free_docker_gib < 5 )); then
    fail "only ${free_docker_gib} GiB free under /var/lib/docker; at least 5 GiB is required for images and the database volume"
  fi
  if [[ -n "${free_root_gib}" ]] && (( free_root_gib < 10 )); then
    warning "less than 10 GiB free under ${ORCASYNAPSE_ROOT}; plan for growth before production use"
  fi

  local memory_kib
  memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
  if (( memory_kib > 0 && memory_kib < 4194304 )); then
    warning "this host has less than 4 GiB of memory; the control plane may be slow under load"
  fi

  if all_secrets_exist; then
    info "Protected secrets are present; existing installation state will be preserved."
  else
    info "No protected secrets found; this run bootstraps a new installation."
  fi
  success "Preflight checks passed."
}

# A machine-readable completion record for operators and support tooling.
write_completion_marker() {
  local version="$1" commit="$2" completed_at
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  install -d -m 0700 "${ORCASYNAPSE_ROOT}/.local/state"
  printf '{"version":"%s","commit":"%s","completedAt":"%s"}\n' \
    "${version}" "${commit}" "${completed_at}" \
    > "${ORCASYNAPSE_ROOT}/.local/state/install-complete.json"
  chmod 0600 "${ORCASYNAPSE_ROOT}/.local/state/install-complete.json"
}

provision_local_administrator() {
  local temporary_password result
  temporary_password="$(openssl rand -base64 24 | tr -d '\n=' | tr '+/' '-_')"
  result="$(printf '%s' "${temporary_password}" \
    | docker compose --project-directory "${ORCASYNAPSE_ROOT}" exec -T api \
      node apps/api/dist/auth/provision-local-admin.js --username admin --display-name 'Local Administrator')" \
    || fail "local administrator provisioning failed"
  if [[ "${result}" == *'"created":true'* ]]; then
    ui_panel_begin "${UI_BLUE}" "INITIAL LOCAL ADMINISTRATOR" "-"
    ui_panel_kv 'Username' 'admin'
    ui_panel_kv 'Temporary password' "${temporary_password}"
    ui_panel_end "${UI_BLUE}" "-"
    warning "Store this password until first login; it must be changed immediately."
  else
    success "The existing local administrator account was preserved."
  fi
}

main() {
  local release_version source_commit=""
  release_version="$(installer_release_version)"
  if [[ -r "${ORCASYNAPSE_ROOT}/.orcasynapse-source-commit" ]]; then
    source_commit="$(<"${ORCASYNAPSE_ROOT}/.orcasynapse-source-commit")"
  fi
  UI_BANNER_META="Release ${release_version}${source_commit:+  /  source ${source_commit:0:12}}"

  if [[ "${ORCASYNAPSE_BOOTSTRAP_BRANDED:-0}" != "1" ]]; then
    banner
  else
    printf '\n%b  CONTROL PLANE PROVISIONING%b\n' "${UI_BLUE}${UI_BOLD}" "${UI_RESET}"
    printf '%b\n' "${UI_DIM}  ----------------------------------------------------------------------${UI_RESET}"
    if [[ -n "${UI_BANNER_META}" ]]; then
      printf '%b\n' "${UI_DIM}  ${UI_BANNER_META}${UI_RESET}"
    fi
  fi

  step 1 "${TOTAL_STEPS}" "Validate the host"
  require_root
  install -d -m 0700 "${ORCASYNAPSE_ROOT}/.local/state"
  UI_LOG_FILE="${ORCASYNAPSE_ROOT}/.local/state/install-$(date -u +%Y%m%dT%H%M%SZ).log"
  : > "${UI_LOG_FILE}"
  chmod 0600 "${UI_LOG_FILE}"
  ui_log "installer release=${release_version} commit=${source_commit:-none}"
  install_host_dependencies
  validate_inputs
  success "Docker Compose and host dependencies are ready."
  cd "${ORCASYNAPSE_ROOT}"
  migrate_legacy_installation_secret

  step 2 "${TOTAL_STEPS}" "Preflight the host for this release"
  preflight_checks

  step 3 "${TOTAL_STEPS}" "Build the pinned release"
  run_with_progress "Build verified application images" docker compose build \
    || fail "application image build failed"

  step 4 "${TOTAL_STEPS}" "Seed the local embedding model"
  if run_with_progress "Download approved embedding weights" seed_embedding_model; then
    success "Embedding weights are cached locally; retrieval works without internet access."
  else
    warning "The embedding model could not be downloaded now."
    info "Knowledge upload and retrieval stay unavailable until this host can reach the model source once."
  fi

  step 5 "${TOTAL_STEPS}" "Protect installation secrets"
  if all_secrets_exist; then
    success "Existing bootstrap material found and preserved."
  else
    generate_secrets
    success "Database and recovery secrets generated."
  fi
  protect_secret_files
  success "Secrets are host-protected and readable only by their intended container identities."

  step 6 "${TOTAL_STEPS}" "Migrate PostgreSQL and start services"
  local postgres_volume_preexisted=0
  if docker volume inspect orcasynapse_postgres_data >/dev/null 2>&1; then
    postgres_volume_preexisted=1
  fi
  start_stack
  run_with_progress "Wait for control-plane readiness" wait_for_orcasynapse \
    || fail "control-plane readiness checks failed"
  reindex_after_libc_migration "${postgres_volume_preexisted}"

  step 7 "${TOTAL_STEPS}" "Provision administrator access"
  provision_local_administrator

  local host_ip installation_key
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-127.0.0.1}"
  installation_key="$(<"$(secret_file orcasynapse_installation_key)")"

  ui_panel_begin "${UI_GREEN}" "ORCASYNAPSE IS READY"
  ui_panel_kv 'Dashboard' "http://${host_ip}:${ORCASYNAPSE_HTTP_PORT}/"
  ui_panel_kv 'Release' "${release_version}${source_commit:+ (${source_commit:0:12})}"
  ui_panel_line 'Offline recovery Installation Key'
  ui_panel_line "${installation_key}"
  ui_panel_end "${UI_GREEN}"
  warning "Store the Installation Key in your organization password vault before closing this terminal."
  info "It is for offline local-account recovery, does not expire, and is not the routine dashboard login."
  info "Export and verify the encrypted recovery kit before production activation."
  write_completion_marker "${release_version}" "${source_commit:-unknown}"
  printf '\n%b  NEXT%b  Open the dashboard, change the temporary password, then connect AI Inference.\n' \
    "${UI_CYAN}${UI_BOLD}" "${UI_RESET}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
