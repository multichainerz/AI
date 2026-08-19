#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ORCASYNAPSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HTTP_PORT:-8080}"
ORCASYNAPSE_SECRET_DIR="${ORCASYNAPSE_ROOT}/.local/secrets"
# Where the update agent is fetched from later, carried so that a fork or a
# mirror installs an agent that updates from the same place this came from.
ORCASYNAPSE_GITHUB_REPOSITORY="${ORCASYNAPSE_GITHUB_REPOSITORY:-multichainerz/AI}"
# The first host units VM1 has ever had. Named through variables with production
# defaults so the smoke test can install and remove its own copy on a host that
# may be running a real deployment -- the whole code path runs either way, which
# is the difference between a containment seam and a skipped branch.
ORCASYNAPSE_UPDATE_UNIT="${ORCASYNAPSE_UPDATE_UNIT:-orcasynapse-update}"
ORCASYNAPSE_UPDATE_AGENT_DIR="${ORCASYNAPSE_UPDATE_AGENT_DIR:-/usr/local/lib/orcasynapse}"
ORCASYNAPSE_APPLICATION_SECRET_GID=1000
# The host floor deploy/BOOTSTRAP.md documents, kept here so the preflight and
# the document cannot drift apart.
ORCASYNAPSE_MINIMUM_VCPUS=2
export ORCASYNAPSE_HTTP_PORT

# shellcheck source=lib/installer-ui.sh
. "${ORCASYNAPSE_ROOT}/scripts/lib/installer-ui.sh"
# The scheme browsers really reach OrcaSynapse with -- declared on the command
# line, recorded under .local/state, and never defaulted over a recording.
# Sourced after the UI library because it reports through fail/warning/info.
# shellcheck source=lib/public-scheme.sh
. "${ORCASYNAPSE_ROOT}/scripts/lib/public-scheme.sh"
# The host address the proxy publishes on -- declared, recorded and reported the
# same way and for the same reason. compose.yaml is the only other reader.
# shellcheck source=lib/http-bind.sh
. "${ORCASYNAPSE_ROOT}/scripts/lib/http-bind.sh"

UI_BANNER_TAGLINE="PRIVATE AI CONTROL PLANE  /  VM1 PROVISIONING"
UI_BANNER_ACTIVITY="Establishing secure installation context"
TOTAL_STEPS=6

# Restore the cursor if an animated section is interrupted, and close the log.
#
# $? is captured first: ui_show_cursor returns 0, so reading $? after it logged
# "status=0" for every run including failed ones -- and this log is the artifact
# an operator sends when an install goes wrong.
trap 'orcasynapse_exit_status=$?; ui_show_cursor; ui_log "install finished status=${orcasynapse_exit_status}"' EXIT

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
  # Anything the proxy does not recognise as https is treated as http, so a
  # value like "HTTPS://" or a misspelling would leave the operator believing
  # the session cookies are Secure when they are not. The flag and the recorded
  # value are each checked where they are read; this is the last gate before the
  # value is handed to Compose.
  orcasynapse_validate_public_scheme "${ORCASYNAPSE_PUBLIC_SCHEME:-}" \
    || fail "the public scheme must be http or https, not '${ORCASYNAPSE_PUBLIC_SCHEME:-unset}'"
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


# The host CPU count, or 0 when it cannot be determined. getconf is the fallback
# for a minimal image without coreutils, and 0 means "unknown" -- better to say
# nothing than to invent a number and warn an adequately sized host about it.
host_cpu_count() {
  local count=""
  count="$(nproc 2>/dev/null || true)"
  [[ "${count}" =~ ^[0-9]+$ ]] || count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  [[ "${count}" =~ ^[0-9]+$ ]] || count=0
  printf '%d' "${count}"
}

# Says the CPU count out loud before the install rather than after it.
#
# This deployment used to encode its CPU expectation as a per-service `cpus:`
# ceiling in compose.yaml, which the Docker daemon validates against the host
# and refuses when it is exceeded -- so an undersized host learned its size from
# a failed `docker compose up` with the stack half-created. compose.yaml now
# weights CPU instead of capping it, so nothing here can refuse to start, and
# this warning is what remains: the floor is still real, and an operator under
# it should hear it from the installer rather than from a slow dashboard.
check_cpu_capacity() {
  local cpu_count
  cpu_count="$(host_cpu_count)"
  if (( cpu_count > 0 && cpu_count < ORCASYNAPSE_MINIMUM_VCPUS )); then
    warning "this host has ${cpu_count} vCPU; OrcaSynapse expects at least ${ORCASYNAPSE_MINIMUM_VCPUS}"
  fi
}

# Disk, memory and CPU -- the three figures deploy/BOOTSTRAP.md states as the
# host floor, and the only preflight work that needs nothing installed first.
#
# Kept apart from preflight_checks and called ahead of install_host_dependencies
# because the disk shortfall is a hard failure: grouped with the Docker-dependent
# checks it aborted an undersized host only after apt-get had installed docker.io
# and systemctl had enabled the daemon, so the operator was told the machine was
# too small by a run that had already changed it. Nothing here reads Docker.
#
# The daemon's data root, or the nearest ancestor that exists yet. Running ahead
# of the install means /var/lib/docker has not been created, so `df` on it
# reports nothing; the first version of this fell back to ORCASYNAPSE_ROOT, which
# silently measured a different filesystem. On the ordinary layout where /var is
# its own volume, that let a 4 GiB partition satisfy a 5 GiB requirement -- apt
# then installed Docker and the image build filled /var and died half created,
# which is the failure the check exists to prevent. Walking up lands on /var/lib,
# or /var, or / -- whichever holds the mount the data root will be created under.
docker_data_root_probe() {
  local path="/var/lib/docker"
  while [[ ! -e "${path}" && "${path}" != "/" ]]; do
    path="$(dirname -- "${path}")"
  done
  printf '%s\n' "${path}"
}

check_host_sizing() {
  local free_root_gib free_docker_gib docker_probe
  docker_probe="$(docker_data_root_probe)"
  free_root_gib="$(df -Pk "${ORCASYNAPSE_ROOT}" 2>/dev/null | awk 'NR==2 {print int($4/1048576)}' || true)"
  free_docker_gib="$(df -Pk "${docker_probe}" 2>/dev/null | awk 'NR==2 {print int($4/1048576)}' || true)"
  free_docker_gib="${free_docker_gib:-0}"
  if [[ -n "${free_root_gib}" ]] && (( free_root_gib < 5 )); then
    fail "only ${free_root_gib} GiB free under ${ORCASYNAPSE_ROOT}; at least 5 GiB is required"
  fi
  if (( free_docker_gib < 5 )); then
    fail "only ${free_docker_gib} GiB free under ${docker_probe}, which is where Docker's data root lands; at least 5 GiB is required for images and the database volume"
  fi
  if [[ -n "${free_root_gib}" ]] && (( free_root_gib < 10 )); then
    warning "less than 10 GiB free under ${ORCASYNAPSE_ROOT}; plan for growth before production use"
  fi

  local memory_kib
  memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
  if (( memory_kib > 0 && memory_kib < 4194304 )); then
    warning "this host has less than 4 GiB of memory; the control plane may be slow under load"
  fi

  check_cpu_capacity
}

# What is left once sizing has been reported: the checks that genuinely require
# a running Docker daemon, and so cannot run before it is installed.
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

  if all_secrets_exist; then
    info "Protected secrets are present; existing installation state will be preserved."
  else
    info "No protected secrets found; this run bootstraps a new installation."
  fi
  success "Preflight checks passed."
}

# A machine-readable completion record for operators and support tooling. The
# public scheme belongs in it: it is a non-secret operator declaration, and an
# audit that has to answer "did this installation issue Secure cookies" should
# not have to reconstruct it from the proxy configuration.
write_completion_marker() {
  local version="$1" commit="$2" completed_at
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  install -d -m 0700 "${ORCASYNAPSE_ROOT}/.local/state"
  printf '{"version":"%s","commit":"%s","completedAt":"%s","publicScheme":"%s"}\n' \
    "${version}" "${commit}" "${completed_at}" "${ORCASYNAPSE_PUBLIC_SCHEME}" \
    > "${ORCASYNAPSE_ROOT}/.local/state/install-complete.json"
  chmod 0600 "${ORCASYNAPSE_ROOT}/.local/state/install-complete.json"
  printf '%s\n' 'hermes-native-v1' > "${ORCASYNAPSE_ROOT}/.local/state/schema-epoch"
  chmod 0600 "${ORCASYNAPSE_ROOT}/.local/state/schema-epoch"
}

# Replaces a managed file by rename rather than by writing through it.
#
# This is not tidiness. During an upgrade driven by the update agent, the file
# installed below is the program executing this installer's grandparent -- and
# bash reads a script incrementally, so writing new bytes into the inode it is
# part-way through executing makes it resume at an offset into different text.
# `install`, `cp` and a plain redirect all write through the existing inode. A
# rename leaves the running process on the old one and every later run on the new
# one, which is the only version of this that is safe to do to yourself.
replace_managed_file() {
  local mode="$1" destination="$2" parent temporary
  parent="$(dirname -- "${destination}")"
  install -d -m 0755 "${parent}"
  temporary="$(mktemp "${parent}/.orcasynapse-write.XXXXXX")" \
    || fail "could not stage a replacement for ${destination}"
  cat > "${temporary}" || fail "could not write ${destination}"
  chmod "${mode}" "${temporary}"
  chown root:root "${temporary}"
  mv -f -- "${temporary}" "${destination}" || fail "could not atomically replace ${destination}"
}

# The host side of in-dashboard updates. VM1 had no units of its own before this;
# these are the first, and they follow the conventions the VM2 installer already
# uses for its three timers.
#
# The agent lives outside ${ORCASYNAPSE_ROOT} because it is running while that
# directory is renamed away. It reads the approved target straight from
# PostgreSQL: the host already has root and the Docker socket, so a poller adds
# no listener and no authenticated surface that did not exist a moment ago.
install_update_agent() {
  local source="${ORCASYNAPSE_ROOT}/scripts/orcasynapse-update-agent.sh"
  local agent="${ORCASYNAPSE_UPDATE_AGENT_DIR}/orcasynapse-update-agent.sh"
  if [[ ! -r "${source}" ]]; then
    warning "This release carries no update agent; in-dashboard updates were not installed."
    return 0
  fi
  if [[ ! -d /run/systemd/system ]]; then
    info "This host does not run systemd, so the update timer was not installed; upgrades stay manual here."
    return 0
  fi
  replace_managed_file 0700 "${agent}" < "${source}"

  replace_managed_file 0644 "/etc/systemd/system/${ORCASYNAPSE_UPDATE_UNIT}.service" <<EOF
[Unit]
Description=OrcaSynapse in-dashboard update agent
Documentation=https://github.com/${ORCASYNAPSE_GITHUB_REPOSITORY}
After=network-online.target docker.service
Wants=network-online.target docker.service
# Proof of ownership, the same marker the VM2 units carry.
X-OrcaSynapse-Managed=true

[Service]
Type=oneshot
User=root
Group=root
Environment=ORCASYNAPSE_INSTALL_DIR=${ORCASYNAPSE_ROOT}
Environment=ORCASYNAPSE_HTTP_PORT=${ORCASYNAPSE_HTTP_PORT}
Environment=ORCASYNAPSE_GITHUB_REPOSITORY=${ORCASYNAPSE_GITHUB_REPOSITORY}
ExecStart=${agent}
# An upgrade is an image build, a migration and a cold start. A default
# TimeoutStartSec would kill this unit part-way through one; the upgrade itself
# survives that -- it runs in a transient scope of its own -- but the health gate
# and the rollback that follow it would not, which is the half that matters.
TimeoutStartSec=3600
# Deliberately not hardened the way the VM2 units are. This service exists to
# replace ${ORCASYNAPSE_ROOT}, drive the Docker socket and rewrite these very
# unit files; ProtectSystem=strict and ReadOnlyPaths would each break one of
# those outright. What confines it is that it listens on nothing, takes no
# input but one row of an approved target, and is reachable only by its timer.
EOF

  replace_managed_file 0644 "/etc/systemd/system/${ORCASYNAPSE_UPDATE_UNIT}.timer" <<EOF
[Unit]
Description=Check for an approved OrcaSynapse release every ten minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
RandomizedDelaySec=60s
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload || fail "systemd could not reload after the update units were written"
  # The timer, and only the timer. `systemctl start ${ORCASYNAPSE_UPDATE_UNIT}`
  # here would kill the agent that is running this installer during an upgrade
  # -- systemd would treat the new job as a restart of the unit whose cgroup the
  # whole upgrade is descended from. Nothing in this installer may ever start or
  # restart that service.
  systemctl enable --now "${ORCASYNAPSE_UPDATE_UNIT}.timer" >/dev/null \
    || fail "the update timer could not be enabled"
}

# The operator CLI, installed from the same release tree the way the update
# agent is, so both are replaced together on every upgrade. It owns no logic:
# it reads state and starts the update unit, which is why installing it is one
# copy and nothing else.
install_operator_cli() {
  local source="${ORCASYNAPSE_ROOT}/scripts/orcasynapse-cli.sh"
  if [[ ! -r "${source}" ]]; then
    warning "This release carries no operator CLI; 'orcasynapse' was not installed."
    return 0
  fi
  replace_managed_file 0755 /usr/local/bin/orcasynapse < "${source}"
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
  # Before the banner: a mistyped declaration must stop here, not after a build.
  # sudo's env_reset drops an exported ORCASYNAPSE_PUBLIC_SCHEME on the way in,
  # so the command line is the only channel every documented invocation has.
  orcasynapse_take_public_scheme_flag "$@"
  orcasynapse_take_http_bind_flag "${ORCASYNAPSE_REMAINING_ARGS[@]+"${ORCASYNAPSE_REMAINING_ARGS[@]}"}"
  if (( ${#ORCASYNAPSE_REMAINING_ARGS[@]} > 0 )); then
    fail "unrecognised argument '${ORCASYNAPSE_REMAINING_ARGS[0]}'; this installer takes only --public-scheme http|https and --http-bind ADDRESS"
  fi

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
  # Settled and recorded before anything is built, so the rest of the run -- and
  # every later run, including the break-glass rotation -- reads one answer.
  # Re-running the installer with no flag on a declared installation must not
  # fall back to the default, which is why resolution consults the recording.
  orcasynapse_resolve_public_scheme
  orcasynapse_persist_public_scheme
  orcasynapse_resolve_http_bind
  orcasynapse_persist_http_bind
  # The port too, so the break-glass rotation reads it back instead of
  # re-defaulting to 8080 and relocating a deployment that had been moved.
  orcasynapse_persist_http_port
  # Before install_host_dependencies, not after: this is the last point at which
  # an undersized host can be turned away without an apt transaction and an
  # enabled Docker service behind it. The log file above is opened first so the
  # abort still reaches the artifact an operator sends to support.
  check_host_sizing
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

  step 4 "${TOTAL_STEPS}" "Protect installation secrets"
  if all_secrets_exist; then
    success "Existing bootstrap material found and preserved."
  else
    generate_secrets
    success "Database and recovery secrets generated."
  fi
  protect_secret_files
  success "Secrets are host-protected and readable only by their intended container identities."

  step 5 "${TOTAL_STEPS}" "Migrate PostgreSQL and start services"
  start_stack
  run_with_progress "Wait for control-plane readiness" wait_for_orcasynapse \
    || fail "control-plane readiness checks failed"
  # After readiness, because the agent it installs is the thing that will drive
  # the next upgrade and there is no point arming it against a deployment that
  # never came up.
  run_with_progress "Install the in-dashboard update agent" install_update_agent \
    || fail "the in-dashboard update agent could not be installed"
  run_with_progress "Install the orcasynapse operator CLI" install_operator_cli \
    || fail "the orcasynapse operator CLI could not be installed"

  step 6 "${TOTAL_STEPS}" "Provision administrator access"
  provision_local_administrator

  local host_ip installation_key
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-127.0.0.1}"
  installation_key="$(<"$(secret_file orcasynapse_installation_key)")"

  ui_complete "ORCASYNAPSE IS READY"
  # "Direct address", not "Dashboard": on an installation that declared https
  # this is the plain-HTTP port behind the TLS terminator, not the address
  # browsers use, and labelling it as the dashboard invites an operator to reach
  # the control plane over cleartext -- where the Secure cookie they just asked
  # for is one the browser will never send back.
  ui_panel_kv 'Direct address' "http://${host_ip}:${ORCASYNAPSE_HTTP_PORT}/"
  ui_panel_kv 'Release' "${release_version}${source_commit:+ (${source_commit:0:12})}"
  ui_panel_kv 'Public scheme' "${ORCASYNAPSE_PUBLIC_SCHEME}"
  ui_panel_kv 'Bound to' "${ORCASYNAPSE_HTTP_BIND}"
  # Printed, never logged: ui_panel_line does not write to UI_LOG_FILE, which
  # is the only reason the key may appear through a UI helper at all.
  ui_panel_line ''
  ui_panel_kv 'Offline recovery key' "${installation_key}"
  printf '\n'
  warning "Store the Installation Key in your organization password vault before closing this terminal."
  info "It is for offline local-account recovery, does not expire, and is not the routine dashboard login."
  info "Export and verify the encrypted recovery kit before production activation."
  # Said out loud rather than left to be inferred from the proxy configuration.
  # An install that terminates TLS upstream but never declared it looks
  # identical to a correct one from here, and that silence is exactly how a
  # deployment reached production with session cookies that were not Secure.
  orcasynapse_report_public_scheme
  orcasynapse_report_http_bind
  write_completion_marker "${release_version}" "${source_commit:-unknown}"
  info "Run 'orcasynapse' any time on this host for status, updates and diagnosis."
  ui_next "Open the dashboard, change the temporary password, then connect AI Inference."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
