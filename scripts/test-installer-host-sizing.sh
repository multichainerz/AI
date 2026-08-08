#!/usr/bin/env bash
# Exercises the VM1 installer's host-sizing preflight.
#
# The disk and memory preflights were the only ones a host was measured
# against, so an undersized machine learned its CPU count was a problem from a
# failed `docker compose up` rather than from the installer. This proves the CPU
# preflight exists, fires below the documented floor, and -- the assertion that
# makes the other two mean anything -- goes quiet above it.
#
# The host count is simulated by shadowing `nproc` with a shell function rather
# than by adding a test-only override to the installer: a knob that only tests
# use proves the knob works, not the check.
#
# It also asserts when the sizing report happens, not only that it happens.
# deploy/BOOTSTRAP.md promises an operator that an undersized host hears about
# it before the installer installs anything, and a check that is correct but
# runs after apt-get has installed and enabled Docker does not keep that
# promise. That is a property of main()'s call order, so main() is run with its
# host-modifying steps replaced by recorders and the recorded order is asserted.
#
# Needs a reachable Docker daemon, because the checks that remain in
# preflight_checks after the sizing split are exercised for real -- a check that
# is defined but never called is the failure this is guarding against.
set -Eeuo pipefail

export TERM=dumb
export NO_COLOR=1

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
failures=0

pass() { printf '  [PASS] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }

docker info >/dev/null 2>&1 || { echo "this test needs a reachable Docker daemon" >&2; exit 2; }

# Set before sourcing: the installer resolves ORCASYNAPSE_HTTP_PORT at load
# time, and preflight_checks refuses a port something else already holds. This
# test is about CPUs, so it picks a port nothing is expected to be on.
export ORCASYNAPSE_HTTP_PORT="${ORCASYNAPSE_HOST_SIZING_TEST_PORT:-8397}"

# shellcheck source=install-orcasynapse.sh
. "${ROOT}/scripts/install-orcasynapse.sh"
# Deliberately after the source. install-orcasynapse.sh installs its own EXIT
# trap at load time, which silently replaces any trap set before it -- the exact
# way a test can lose its assertions without saying so.
trap 'ui_show_cursor' EXIT
cd "${ROOT}"

# Runs a command with the host CPU count faked. Both stream and status are
# handed back merged, because warning() writes to stderr and success() does not.
simulate_cpus() {
  local requested="$1"
  shift
  (
    nproc() { printf '%s\n' "${requested}"; }
    getconf() { printf '%s\n' "${requested}"; }
    "$@"
  ) 2>&1
}

printf '\n=== the installer reads a host CPU count ===\n'
if [[ "$(host_cpu_count)" == "$(nproc)" ]]; then
  pass "host_cpu_count agrees with nproc ($(nproc))"
else
  bad "host_cpu_count returned '$(host_cpu_count)', nproc says '$(nproc)'"
fi

printf '\n=== the documented floor is a real floor ===\n'
# Defaulted rather than read bare: under `set -u` an unset constant would abort
# the run, and a test that dies is a test that reports nothing.
declared_minimum="${ORCASYNAPSE_MINIMUM_VCPUS:-0}"
if [[ "${declared_minimum}" =~ ^[0-9]+$ ]] && (( declared_minimum >= 2 )); then
  pass "the declared minimum is ${declared_minimum} vCPU"
else
  bad "ORCASYNAPSE_MINIMUM_VCPUS is '${ORCASYNAPSE_MINIMUM_VCPUS:-unset}', which cannot warn anyone"
  declared_minimum=2
fi
undersized=$((declared_minimum - 1))
generous=$((declared_minimum + 4))

printf '\n=== the CPU check fires below the floor and is quiet above it ===\n'
below="$(simulate_cpus "${undersized}" check_cpu_capacity || true)"
if [[ "${below}" == *"${undersized} vCPU"* && "${below}" == *"${declared_minimum}"* ]]; then
  pass "a ${undersized} vCPU host is told its count and the expected minimum"
else
  bad "a ${undersized} vCPU host was told: '${below}'"
fi
above="$(simulate_cpus "${generous}" check_cpu_capacity || true)"
if [[ -z "${above}" ]]; then
  pass "a ${generous} vCPU host hears nothing"
else
  bad "a ${generous} vCPU host was warned anyway: '${above}'"
fi

printf '\n=== the grouped sizing check actually reaches it ===\n'
# check_host_sizing is what main() calls; check_cpu_capacity being correct is
# worth nothing if the function the installer runs does not reach it.
sizing_status=0
sizing_output="$(simulate_cpus "${undersized}" check_host_sizing)" || sizing_status=$?
if (( sizing_status != 0 )); then
  bad "check_host_sizing exited ${sizing_status} on this host: ${sizing_output}"
elif [[ "${sizing_output}" == *"${undersized} vCPU"* ]]; then
  pass "the warning is reached through the sizing check the installer runs first"
else
  bad "check_host_sizing passed without mentioning the CPU count: ${sizing_output}"
fi
sizing_status=0
sizing_output="$(simulate_cpus "${generous}" check_host_sizing)" || sizing_status=$?
# The status is read here as well as above: silence from a function that does
# not exist is not the silence this is trying to observe.
if (( sizing_status != 0 )); then
  bad "check_host_sizing exited ${sizing_status} on a ${generous} vCPU host: ${sizing_output}"
elif [[ "${sizing_output}" == *vCPU* ]]; then
  bad "check_host_sizing warned a ${generous} vCPU host about its CPUs: ${sizing_output}"
else
  pass "an adequately sized host clears the sizing check without a CPU warning"
fi

printf '\n=== the Docker-dependent preflight still completes ===\n'
# Splitting sizing out of preflight_checks must not have taken the rest of it
# with it: this host is adequately sized, so the preflight is expected to pass.
preflight_status=0
preflight_output="$(preflight_checks 2>&1)" || preflight_status=$?
if (( preflight_status != 0 )); then
  bad "preflight_checks exited ${preflight_status} on this host: ${preflight_output}"
else
  pass "preflight_checks completes on an adequately sized host"
fi

# Position of a recorded call, or 0 for "never recorded". Positions rather than
# a whole-file pattern, because the assertion is about which call came first,
# not merely that both appear.
trace_index() {
  local file="$1" needle="$2" index=1 line
  while IFS= read -r line; do
    if [[ "${line}" == "${needle}" ]]; then
      printf '%d' "${index}"
      return 0
    fi
    index=$((index + 1))
  done <"${file}"
  printf '0'
}

# Runs main() for real with every host-modifying step replaced by a recorder
# that appends its name to $1, and prints main's merged output. Reading main()
# cannot establish call order; only running it can.
trace_main() {
  local trace="$1"
  shift
  (
    # A scratch root keeps main()'s state directory and install log out of the
    # working tree. installer_release_version reports "unknown" when its version
    # file is absent, so a bare directory is enough.
    ORCASYNAPSE_ROOT="$(mktemp -d)"
    ORCASYNAPSE_BOOTSTRAP_BRANDED=1
    record() { printf '%s\n' "$1" >>"${trace}"; }
    require_root() { record require_root; }
    install_host_dependencies() { record install_host_dependencies; }
    validate_inputs() { record validate_inputs; }
    migrate_legacy_installation_secret() { record migrate_legacy_installation_secret; }
    # Ends the run at the first step that needs a built release; everything
    # these sections assert about has happened by the time it is reached.
    preflight_checks() { record preflight_checks; exit 0; }
    "$@"
  ) 2>&1 || true
}

printf '\n=== sizing is reported before the host is modified ===\n'
# deploy/BOOTSTRAP.md tells an operator that an undersized host hears about it
# before the installer installs anything, and that is the promise that decides
# whether a 3 GiB VPS is left with Docker installed and enabled after a hard
# abort.
trace_file="$(mktemp)"
# check_host_sizing is recorded rather than run here: this section is about
# where it sits in the sequence, and the sections above already establish that
# it reports. The next section runs the real one. The shadow is installed by a
# wrapper rather than by trace_main so that the next section can still reach the
# real function -- and it resolves `record` from trace_main's subshell at call
# time, which is how shell function lookup works.
main_with_recorded_sizing() {
  check_host_sizing() { record check_host_sizing; }
  main
}
trace_main "${trace_file}" main_with_recorded_sizing >/dev/null
sizing_at="$(trace_index "${trace_file}" check_host_sizing)"
dependencies_at="$(trace_index "${trace_file}" install_host_dependencies)"
legacy_at="$(trace_index "${trace_file}" migrate_legacy_installation_secret)"
recorded="$(tr '\n' ' ' <"${trace_file}")"
rm -f -- "${trace_file}"

# Checked before the ordering claim: a trace that recorded nothing would satisfy
# "sizing came first" vacuously, which is an instrument that cannot fail.
if (( dependencies_at == 0 || legacy_at == 0 )); then
  bad "main() never reached dependency installation in this trace, so it proves no ordering: [${recorded}]"
elif (( sizing_at == 0 )); then
  bad "main() never reached a host-sizing check: [${recorded}]"
elif (( sizing_at < dependencies_at && sizing_at < legacy_at )); then
  pass "sizing is measured before dependency installation and secret migration: [${recorded}]"
else
  bad "main() modifies the host before it reports sizing: [${recorded}]"
fi

printf '\n=== a host below the disk floor is refused before Docker is installed ===\n'
# The concrete case the Host sizing paragraph is written for: a small VPS with
# 3 GiB free, where the disk shortfall is a hard failure rather than a warning.
# Ordering alone would not settle it -- a check that runs first and then lets
# the run continue leaves the same operator with docker.io installed and the
# daemon enabled -- so this runs the real check_host_sizing against a faked
# filesystem and asserts that dependency installation is never reached.
#
# df is shadowed rather than a small filesystem being created, because creating
# one needs root and a loop device, which is a heavier dependency than this
# assertion is worth. Field 4 is what the installer's awk reads: 3145728 KiB.
simulate_small_disk() {
  (
    nproc() { printf '1\n'; }
    getconf() { printf '1\n'; }
    df() {
      printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\n'
      printf '/dev/simulated 52428800 49283072 3145728 95%% /\n'
    }
    "$@"
  )
}
disk_trace="$(mktemp)"
disk_output="$(trace_main "${disk_trace}" simulate_small_disk main)"
disk_dependencies_at="$(trace_index "${disk_trace}" install_host_dependencies)"
disk_recorded="$(tr '\n' ' ' <"${disk_trace}")"
disk_require_root_at="$(trace_index "${disk_trace}" require_root)"
rm -f -- "${disk_trace}"

if (( disk_require_root_at == 0 )); then
  bad "main() never started in this trace, so reaching nothing proves nothing: [${disk_recorded}]"
elif [[ "${disk_output}" != *"at least 5 GiB is required"* ]]; then
  bad "a 3 GiB host was not told the disk requirement: ${disk_output}"
elif (( disk_dependencies_at != 0 )); then
  bad "a 3 GiB host had dependencies installed before it was refused: [${disk_recorded}]"
else
  pass "a 3 GiB host is refused with nothing installed: [${disk_recorded}]"
fi

printf '\n=== a small /var is measured even though Docker is not installed yet ===\n'
# The layout the check above cannot see. On the standard CIS/LVM split, /var is
# its own volume and the bundle sits on a roomy root. Because sizing now runs
# ahead of the apt install, /var/lib/docker does not exist, and measuring that
# path directly reports nothing -- the first version then fell back to the
# bundle's filesystem and passed a host whose 4 GiB /var the image build was
# about to fill.
#
# Unlike the scenario above, this df answers per path. That is the whole point:
# a stub returning one number for every argument cannot tell a check that reads
# the right filesystem from one that reads the wrong one, so deleting the
# /var measurement outright would leave that scenario green.
simulate_split_var() {
  (
    nproc() { printf '8\n'; }
    getconf() { printf '8\n'; }
    df() {
      local target="${*: -1}"
      printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\n'
      case "${target}" in
        /var|/var/*) printf '/dev/var 4194304 100000 4194304 3%% /var\n' ;;
        *)           printf '/dev/root 52428800 1048576 52428800 5%% /\n' ;;
      esac
    }
    "$@"
  )
}
split_output="$(simulate_split_var check_host_sizing 2>&1 || true)"
if [[ "${split_output}" == *"Docker's data root lands"* ]]; then
  pass "a 4 GiB /var is refused on a host whose bundle filesystem is roomy"
else
  bad "the /var volume Docker will fill was never measured: ${split_output:-<silence>}"
fi
# The instrument has to be able to go quiet, or the assertion above is worthless.
simulate_roomy_var() {
  (
    nproc() { printf '8\n'; }
    getconf() { printf '8\n'; }
    df() {
      printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\n'
      printf '/dev/root 52428800 1048576 52428800 5%% /\n'
    }
    "$@"
  )
}
roomy_output="$(simulate_roomy_var check_host_sizing 2>&1 || true)"
if [[ "${roomy_output}" == *"at least 5 GiB is required"* ]]; then
  bad "a host with room everywhere was still refused: ${roomy_output}"
else
  pass "a host with room on both filesystems passes"
fi

printf '\n'
if (( failures > 0 )); then
  printf 'Installer host-sizing preflight FAILED with %d problem(s).\n' "${failures}" >&2
  exit 1
fi
printf 'Installer host-sizing preflight verified.\n'
