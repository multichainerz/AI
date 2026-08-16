#!/usr/bin/env bash
# Static guard: the built dashboard must not need anything the container's
# Content-Security-Policy forbids.
#
# deploy/nginx/default.conf serves `style-src 'self'` with no 'unsafe-inline',
# plus `font-src 'self'`, `script-src 'self'` and `connect-src 'self'`. None of
# that is enforced by `pnpm dev`, which sends no CSP header at all -- so a
# violation works perfectly in development and only fails in the built image, on
# the pilot, in front of whoever is looking at it.
#
# That is exactly how Radix was ruled out: its Popper primitives write
# positioning into inline `style` attributes and its Dialog injects a <style>
# element into <head>. This check keeps that decision enforced after everyone
# who remembers making it has moved on.
#
# Everything below section 0 is an *absence* check, and an absence check over an
# empty input passes. That is not hypothetical: deleting every `.js` and `.css`
# under dist/assets while leaving the directory in place, or deleting dist/fonts
# and rewriting every `src:` to `local("Arial")`, both left this script printing
# "passed" -- the second being precisely the regression the font check exists to
# prevent. So section 0 asserts there is something to measure before anything
# asserts what is not in it.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${ROOT}"

DIST="apps/web/dist"
SRC="apps/web/src"
if [[ ! -d "${DIST}/assets" ]]; then
  echo "building the dashboard first (no ${DIST}/assets)" >&2
  pnpm --filter @orcasynapse/web build >/dev/null
fi

failures=0
report() {
  echo "  [FAIL] $1" >&2
  failures=$((failures + 1))
}

# 0. There is something to measure. Each of these is the precondition of a check
#    below, so a missing input is reported as a failure of this script rather
#    than silently satisfying the check that depended on it.
shopt -s nullglob
bundles=("${DIST}"/assets/*.js)
stylesheets=("${DIST}"/assets/*.css)
shopt -u nullglob

if [[ "${#bundles[@]}" -eq 0 ]]; then
  report "${DIST}/assets contains no .js bundle to inspect"
fi
if [[ "${#stylesheets[@]}" -eq 0 ]]; then
  report "${DIST}/assets contains no .css stylesheet to inspect"
fi
if [[ ! -f "${DIST}/index.html" ]]; then
  report "${DIST}/index.html is missing"
fi

# The fonts are self-hosted, so every @font-face must name a file this image
# ships. A rule that resolves to `local(...)` or to nothing at all renders in a
# substitute on every machine that happens to lack the family -- the silent
# failure that let @font-face go fourteen releases without a file.
font_faces=0
font_faces_with_url=0
if [[ "${#stylesheets[@]}" -gt 0 ]]; then
  # `|| true` for the same reason as the line below it, and it was missing here.
  # Zero matches is grep's exit 1, which pipefail promotes to the pipeline's
  # status and errexit turns into an abort -- so the one input this count exists
  # to detect, a stylesheet with no @font-face at all, killed the script two
  # lines before the report that would have named it. The count is still 0 and
  # the check below still fires; the only thing the missing `|| true` changed was
  # whether anyone was told why.
  font_faces="$(grep -ohE "@font-face[[:space:]]*\{[^}]*\}" "${stylesheets[@]}" | wc -l | tr -d '[:space:]' || true)"
  font_faces_with_url="$(grep -ohE "@font-face[[:space:]]*\{[^}]*\}" "${stylesheets[@]}" \
    | grep -cE "url\(" || true)"
fi
if [[ "${font_faces}" -eq 0 ]]; then
  report "the stylesheets declare no @font-face rule at all"
elif [[ "${font_faces_with_url}" -ne "${font_faces}" ]]; then
  report "${font_faces} @font-face rule(s) declared but only ${font_faces_with_url} name a url() file"
fi

# 1. Runtime stylesheet injection. A library that builds a <style> element or
#    edits a sheet at runtime is blocked by style-src 'self'.
if [[ "${#bundles[@]}" -gt 0 ]]; then
  injection="$(grep -oE "createElement\((\"|')style(\"|')\)|insertRule\(|adoptedStyleSheets|setAttribute\((\"|')style(\"|')" \
    "${bundles[@]}" || true)"
  if [[ -n "${injection}" ]]; then
    report "the bundle injects or edits a stylesheet at runtime:"
    printf '%s\n' "${injection}" | sort -u | head -5 >&2
  fi
fi

# 1b. The same rule at the source, because the bundle cannot carry it. React's
#     own Suspense implementation writes `node.style.display` and calls
#     `style.setProperty`, so a grep for CSSOM writes over dist/assets can only
#     ever report React. `setAttribute("style")` above is the one spelling no
#     dependency here uses, which is why it was the only one checked -- and why
#     `document.body.style.overflow = "hidden"` in components/ui/dialog.tsx sat
#     in a shipped bundle with the gate green. The house rule is no inline style
#     writes and no `style={{...}}` in JSX; this is where it is enforced.
# Comment-only lines are dropped, because the rule is worth writing down and the
# places it is written down are the ones that quote the spellings it forbids --
# components/ui/dialog.tsx's own header explains its fix by naming
# `setAttribute("style")`. A write on a line that also carries a trailing
# comment still matches: only lines that *begin* with a comment marker are
# skipped, and a statement never does.
cssom="$(grep -rnE '\.style\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=([^=]|$)|\.style\.(setProperty|cssText)|style=\{\{|setAttribute\(("|'"'"')style' \
  --include='*.ts' --include='*.tsx' "${SRC}" \
  | grep -vE '\.test\.tsx?:' \
  | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(\*|//|/\*)' || true)"
if [[ -n "${cssom}" ]]; then
  report "source writes an inline style instead of a class:"
  printf '%s\n' "${cssom}" | head -5 >&2
fi

# 2. Inline style attributes in the served HTML shell.
if grep -qE '[[:space:]]style="' "${DIST}/index.html" 2>/dev/null; then
  report "index.html carries an inline style attribute"
fi

# 3. Every asset URL must be same-origin. A CDN font or image is refused by
#    font-src / img-src 'self', and the dev server would never say so.
if [[ "${#stylesheets[@]}" -gt 0 ]]; then
  external="$(grep -ohE "url\([^)]*\)" "${stylesheets[@]}" \
    | grep -E "url\((\"|')?(https?:)?//" || true)"
  if [[ -n "${external}" ]]; then
    report "the stylesheet references an off-origin URL:"
    printf '%s\n' "${external}" | sort -u | head -5 >&2
  fi
fi

# 4. The fonts the stylesheet names must actually be in the image. A missing
#    one does not fail the build -- the page just silently renders in something
#    else, which is how @font-face went fourteen releases without a file.
#    Section 0 has already established that every @font-face names one, so an
#    empty list here would itself be a contradiction rather than a pass.
if [[ "${#stylesheets[@]}" -gt 0 ]]; then
  resolved=0
  while IFS= read -r font; do
    [[ -n "${font}" ]] || continue
    resolved=$((resolved + 1))
    [[ -f "${DIST}/${font#/}" ]] || report "styles reference a missing font file: ${font}"
  done < <(grep -ohE "url\(/[^)]*\.(woff2?|ttf|otf)\)" "${stylesheets[@]}" \
    | sed -E "s/^url\(//; s/\)$//" | sort -u)
  if [[ "${resolved}" -eq 0 && "${font_faces}" -gt 0 ]]; then
    report "no @font-face resolves to a same-origin font file under ${DIST}"
  fi
fi

if [[ "${failures}" -gt 0 ]]; then
  echo "CSP closure check failed with ${failures} problem(s)." >&2
  exit 1
fi
echo "CSP closure check passed (${#bundles[@]} bundle(s), ${#stylesheets[@]} stylesheet(s), ${font_faces} @font-face rule(s) resolved, no runtime style injection, no off-origin assets)."
