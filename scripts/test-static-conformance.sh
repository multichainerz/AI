#!/usr/bin/env bash
# Every conformance gate that needs nothing but bash, git and node.
#
# These used to exist only as steps in .github/workflows/verify.yml, which made
# `pnpm verify` -- the four-command script CONTRIBUTING calls "the merge gate"
# and requires green before a release commit -- cover none of them. That gap was
# not theoretical: a release is one commit pushed straight to `main`, so the
# workflow's `pull_request` trigger never fires for it, and the `push` run
# reports after the tag is already public. Whatever these catch, they catch
# after the fact.
#
# What is here is bounded by one rule: it must run on any machine a contributor
# already has. The installer suites that need root, a systemd host or a live
# Docker daemon stay in the workflow and are named in CONTRIBUTING as CI-only,
# because making them a local requirement would just make `pnpm verify`
# unrunnable and leave everybody where they started.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${ROOT}"

failed=0
gate() {
  local label="$1"; shift
  echo "==> ${label}"
  if ! "$@"; then
    echo "  [FAIL] ${label}" >&2
    failed=$((failed + 1))
  fi
}

# Parses every installer script without running one. A syntax error in a file
# an operator pipes into `sudo bash` is not something to discover on their VM.
#
# One invocation per file, because `bash -n FILE ARG...` parses FILE and binds
# everything after it to $1, $2, ... -- it never opens them. The single call this
# replaced therefore parsed install.sh and nothing else, which is why
# scripts/install-agentic-node.sh and scripts/remove-agentic-node.sh -- the two
# the API serves to operators to pipe into `sudo bash`, and the two on the host
# that holds the node identity -- had never been parsed by this gate at all.
# Measured rather than reasoned about: a file whose entire content is
# `if [ ; then` exits 2 when it is the argument to -n, and 0 when it is the
# second word on the same command line.
installers_parse() {
  local problems=0 path
  for path in install.sh scripts/*.sh scripts/lib/*.sh; do
    # An unmatched glob comes through as the literal pattern; skipping it here
    # keeps the failure attributable to the named-file loop below rather than to
    # bash reporting that `scripts/*.sh` does not exist.
    [[ -f "${path}" ]] || continue
    bash -n -- "${path}" || { echo "${path} does not parse" >&2; problems=$((problems + 1)); }
  done
  # The three an operator pipes into `sudo bash` are named as well as globbed.
  # A loop over an empty list succeeds, so a moved or renamed directory would
  # turn this gate green by leaving it nothing to do -- which is the same shape
  # of hole as the one above, one level up.
  for path in install.sh scripts/install-agentic-node.sh scripts/remove-agentic-node.sh; do
    [[ -f "${path}" ]] \
      || { echo "${path} is missing, so nothing here parsed a script operators pipe into sudo bash" >&2; problems=$((problems + 1)); }
  done
  [[ "${problems}" -eq 0 ]]
}
gate "installer scripts parse" installers_parse

# Dockerfile.api bakes the agentic-node scripts into the API image and the API
# hands them to operators who pipe them into `sudo bash`, where a CRLF shebang
# fails execve outright with "'bash\r': No such file or directory". A Linux
# runner clones with core.autocrlf=false, so checking the bytes proves nothing
# about the Windows workstation that would produce them -- the attribute that
# prevents it is what gets asserted.
declared_lf() {
  local problems=0 path
  while IFS= read -r path; do
    git check-attr eol -- "${path}" | grep -qx "${path}: eol: lf" \
      || { echo "${path} is not declared eol=lf in .gitattributes" >&2; problems=$((problems + 1)); }
  done < <(git ls-files '*.sh'; echo scripts/hermes-corpus-reconciler.py; echo scripts/hermes-artifact-publisher.py)
  [[ "${problems}" -eq 0 ]]
}
gate "shell scripts are declared LF" declared_lf

gate "generated brand assets are current" node scripts/sync-doc-brand.mjs --check
gate "installer UI regions match the library" bash scripts/sync-installer-ui.sh --check
gate "Dockerfiles copy everything they run" bash scripts/test-docker-build-closure.sh
gate "release version surfaces agree" bash scripts/test-release-consistency.sh

# The wiring, checked from inside the thing being wired.
#
# Collecting these gates into one script only closes the gap while both callers
# actually call it. Nothing else can notice if `verify` is edited back down to
# four commands, or if the workflow grows a new inline static step that a
# release commit will never run -- which is the exact shape of the hole this
# script exists to fill, and the reason it was open for fourteen releases.
wired() {
  # Resolved through the `verify` chain rather than grepped out of the file: a
  # `verify:static` entry that nothing calls satisfies a whole-file grep while
  # leaving `verify` exactly as vacuous as it was.
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const { scripts = {} } = JSON.parse(readFileSync("package.json", "utf8"));
    const seen = new Set();
    const expand = (name) => {
      if (seen.has(name)) return "";
      seen.add(name);
      const body = scripts[name] ?? "";
      return body.replace(/pnpm (?:run )?([\w:-]+)/g, (whole, target) =>
        Object.hasOwn(scripts, target) ? `${whole} ${expand(target)}` : whole);
    };
    const verify = expand("verify");
    const required = [
      ["scripts/test-static-conformance.sh", "the static conformance gates would be CI-only again, and a release commit never reaches CI before the tag is public"],
      ["scripts/test-database-test-budgets.mjs", "a database suite could ship without the timeout profile and flake under concurrency"],
      ["scripts/test-csp-closure.sh", "the built dashboard could ship a CSP violation the dev server never reports"],
    ];
    const missing = required.filter(([path]) => !verify.includes(path));
    for (const [path, why] of missing) console.error(`pnpm verify does not reach ${path}: ${why}.`);
    process.exit(missing.length === 0 ? 0 : 1);
  ' || return 1
  grep -q 'test-static-conformance\.sh' .github/workflows/verify.yml \
    || { echo ".github/workflows/verify.yml no longer runs scripts/test-static-conformance.sh before install, so the fast static feedback is gone" >&2; return 1; }
}
gate "pnpm verify and CI both run these gates" wired

if [[ "${failed}" -gt 0 ]]; then
  echo "Static conformance failed: ${failed} gate(s)." >&2
  exit 1
fi
echo "Static conformance passed (7 gates)."
