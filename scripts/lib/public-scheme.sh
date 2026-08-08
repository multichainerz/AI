# shellcheck shell=bash
# The operator's declaration of the scheme browsers really reach OrcaSynapse
# with, and the single place that decides it.
#
# Why this is not simply an environment variable. The bundled proxy listens on
# plain HTTP and cannot see the TLS a customer-approved terminator provides in
# front of it, so the scheme has to be declared rather than observed, and that
# declaration is the only thing that puts Secure on the administrator and
# enterprise session cookies. But every command deploy/BOOTSTRAP.md prints is a
# sudo command, and stock sudoers is `Defaults env_reset`: an exported
# ORCASYNAPSE_PUBLIC_SCHEME is dropped on the way in. Measured, with a script
# file rather than an inline expansion which the calling shell would resolve
# before sudo ever saw it:
#
#   ORCASYNAPSE_PUBLIC_SCHEME=https sudo ./show.sh   -> UNSET
#   cat show.sh | ORCASYNAPSE_PUBLIC_SCHEME=https sudo bash -> UNSET
#   sudo env ORCASYNAPSE_PUBLIC_SCHEME=https ./show.sh    -> https
#
# So the declaration travels as a command-line flag, which sudo cannot strip,
# and is recorded in the root-only state directory the installer already owns.
# Recording it is what stops a later run from quietly re-deriving http:
# rotate-installation-key.sh force-recreates the web container, and before this
# existed that recreation silently removed Secure from every session cookie of
# an install that had been correct -- at break-glass time, which is the worst
# possible moment to lose a security property without being told.
#
# The recorded value is an operator declaration, not a secret. It is one of two
# words, it is safe in an install log and in the completion marker, and it must
# never be written into .local/secrets, where the installer's own guards treat
# every file as protected material.
#
# Requires ORCASYNAPSE_ROOT and the installer UI library (for fail/warning/info
# and success) to be in scope already.

ORCASYNAPSE_PUBLIC_SCHEME_STATE="${ORCASYNAPSE_ROOT}/.local/state/public-scheme"

# Where the value in force came from: flag, environment, recorded, or empty for
# "nobody ever said". Captured at load time, before any flag parsing, because
# only an environment variable that was already set counts as a declaration --
# the scripts default the variable themselves and that default must not be
# mistaken for one.
if [[ -n "${ORCASYNAPSE_PUBLIC_SCHEME:-}" ]]; then
  ORCASYNAPSE_PUBLIC_SCHEME_DECLARED="environment"
else
  ORCASYNAPSE_PUBLIC_SCHEME_DECLARED=""
fi
# What a previous run recorded, filled in by orcasynapse_resolve_public_scheme.
ORCASYNAPSE_PUBLIC_SCHEME_RECORDED=""

orcasynapse_validate_public_scheme() {
  [[ "${1:-}" == "http" || "${1:-}" == "https" ]]
}

# Takes --public-scheme out of an argument list and leaves everything else in
# ORCASYNAPSE_REMAINING_ARGS for the caller's own parser.
#
# Anything the proxy does not recognise as https is rendered as http, so a value
# like "HTTPS" or a misspelling would leave the operator believing the cookies
# are Secure when they are not. Refuse it here rather than accept it and mean
# something else. An unrecognised flag is refused by the callers for the same
# reason: silently ignoring --public-scheam is the failure this whole file
# exists to remove.
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
    orcasynapse_validate_public_scheme "${value}" \
      || fail "--public-scheme must be http or https, not '${value}'"
    ORCASYNAPSE_PUBLIC_SCHEME="${value}"
    ORCASYNAPSE_PUBLIC_SCHEME_DECLARED="flag"
    export ORCASYNAPSE_PUBLIC_SCHEME
  done
}

# Settles the scheme in force: the flag, then an environment declaration (which
# only arrives through `sudo env` or a run without sudo at all), then whatever a
# previous run recorded, then http. http last and never overriding a recording
# is the whole point -- it is the safe default for an undeclared install and the
# wrong answer for a declared one.
orcasynapse_resolve_public_scheme() {
  # Damage is noted here and judged below, because what a corrupt recording
  # means depends entirely on whether anything else answers the question. A
  # truncated write or a half-restored backup leaves bytes that are neither
  # word; validating unconditionally made that two-byte file refuse every run
  # including the break-glass rotation, while the refusal named --public-scheme
  # as the cure and the flag was parsed after the refusal had already fired.
  local damaged=0
  if [[ -f "${ORCASYNAPSE_PUBLIC_SCHEME_STATE}" ]]; then
    ORCASYNAPSE_PUBLIC_SCHEME_RECORDED="$(<"${ORCASYNAPSE_PUBLIC_SCHEME_STATE}")"
    ORCASYNAPSE_PUBLIC_SCHEME_RECORDED="${ORCASYNAPSE_PUBLIC_SCHEME_RECORDED//[$'\r\n\t ']/}"
    if ! orcasynapse_validate_public_scheme "${ORCASYNAPSE_PUBLIC_SCHEME_RECORDED}"; then
      damaged=1
      # Cleared so the change notice below compares against a real previous
      # declaration rather than against the damage.
      ORCASYNAPSE_PUBLIC_SCHEME_RECORDED=""
    fi
  fi

  case "${ORCASYNAPSE_PUBLIC_SCHEME_DECLARED}" in
    flag|environment)
      orcasynapse_validate_public_scheme "${ORCASYNAPSE_PUBLIC_SCHEME:-}" \
        || fail "ORCASYNAPSE_PUBLIC_SCHEME must be http or https, not '${ORCASYNAPSE_PUBLIC_SCHEME:-}'"
      # An explicit declaration answers the question the recording was there to
      # answer, so the damage is repairable rather than fatal: persist replaces
      # it below. Said out loud, because a file that decides a security property
      # should not be found broken and quietly rewritten.
      (( damaged == 0 )) \
        || warning "The recorded public scheme in ${ORCASYNAPSE_PUBLIC_SCHEME_STATE} was unreadable; the declaration on this command replaces it."
      ;;
    *)
      # Nothing declared, so the recording was the only answer and it is gone.
      # A file nobody can read as http or https is not evidence of http, and
      # assuming http here is exactly the silent downgrade this file prevents.
      (( damaged == 0 )) \
        || fail "the recorded public scheme in ${ORCASYNAPSE_PUBLIC_SCHEME_STATE} is neither http nor https; re-declare it with --public-scheme http or --public-scheme https"
      if [[ -n "${ORCASYNAPSE_PUBLIC_SCHEME_RECORDED}" ]]; then
        ORCASYNAPSE_PUBLIC_SCHEME="${ORCASYNAPSE_PUBLIC_SCHEME_RECORDED}"
        ORCASYNAPSE_PUBLIC_SCHEME_DECLARED="recorded"
      else
        ORCASYNAPSE_PUBLIC_SCHEME="http"
      fi
      ;;
  esac
  export ORCASYNAPSE_PUBLIC_SCHEME
  # Logged where it is settled rather than where it is reported, so a run that
  # aborts later still leaves the answer in the artifact support receives. Two
  # words of operator configuration, never a credential.
  ui_log "public-scheme=${ORCASYNAPSE_PUBLIC_SCHEME} source=${ORCASYNAPSE_PUBLIC_SCHEME_DECLARED:-default}"
}

# Records an explicit declaration so later runs -- a re-install, a restart, and
# above all the break-glass rotation -- read it back instead of re-deriving the
# default. A run that fell through to http records nothing: writing "http" there
# would turn "nobody has decided" into "somebody chose plain HTTP", and would
# silence the warning that is the only thing telling an operator their cookies
# are not Secure.
orcasynapse_persist_public_scheme() {
  case "${ORCASYNAPSE_PUBLIC_SCHEME_DECLARED}" in
    flag|environment) ;;
    *) return 0 ;;
  esac
  if [[ -n "${ORCASYNAPSE_PUBLIC_SCHEME_RECORDED}" \
     && "${ORCASYNAPSE_PUBLIC_SCHEME_RECORDED}" != "${ORCASYNAPSE_PUBLIC_SCHEME}" ]]; then
    warning "The declared public scheme changes from ${ORCASYNAPSE_PUBLIC_SCHEME_RECORDED} to ${ORCASYNAPSE_PUBLIC_SCHEME} for this installation."
  fi
  install -d -m 0700 "$(dirname -- "${ORCASYNAPSE_PUBLIC_SCHEME_STATE}")"
  printf '%s\n' "${ORCASYNAPSE_PUBLIC_SCHEME}" > "${ORCASYNAPSE_PUBLIC_SCHEME_STATE}"
  chmod 0600 "${ORCASYNAPSE_PUBLIC_SCHEME_STATE}"
  ORCASYNAPSE_PUBLIC_SCHEME_RECORDED="${ORCASYNAPSE_PUBLIC_SCHEME}"
}

# Says out loud what the session cookies will and will not carry. Silence is
# what made the original defect invisible: an install and a rotation both
# completed with a green summary while the cookies lost Secure.
orcasynapse_report_public_scheme() {
  if [[ "${ORCASYNAPSE_PUBLIC_SCHEME}" == "https" ]]; then
    success "Public scheme is https: administrator and enterprise session cookies carry Secure."
    return 0
  fi
  warning "Public scheme is http: administrator and enterprise session cookies are not Secure."
  info "Where TLS terminates at an upstream proxy, re-run with --public-scheme https to declare it."
}
