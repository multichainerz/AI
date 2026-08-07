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
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${ROOT}"

DIST="apps/web/dist"
if [[ ! -d "${DIST}/assets" ]]; then
  echo "building the dashboard first (no ${DIST}/assets)" >&2
  pnpm --filter @orcasynapse/web build >/dev/null
fi

failures=0
report() {
  echo "  [FAIL] $1" >&2
  failures=$((failures + 1))
}

# 1. Runtime stylesheet injection. A library that builds a <style> element or
#    edits a sheet at runtime is blocked by style-src 'self'.
injection="$(grep -oE "createElement\((\"|')style(\"|')\)|insertRule\(|adoptedStyleSheets|setAttribute\((\"|')style(\"|')" \
  "${DIST}"/assets/*.js 2>/dev/null || true)"
if [[ -n "${injection}" ]]; then
  report "the bundle injects or edits a stylesheet at runtime:"
  printf '%s\n' "${injection}" | sort -u | head -5 >&2
fi

# 2. Inline style attributes in the served HTML shell.
if grep -qE '[[:space:]]style="' "${DIST}/index.html" 2>/dev/null; then
  report "index.html carries an inline style attribute"
fi

# 3. Every asset URL must be same-origin. A CDN font or image is refused by
#    font-src / img-src 'self', and the dev server would never say so.
external="$(grep -ohE "url\([^)]*\)" "${DIST}"/assets/*.css 2>/dev/null \
  | grep -E "url\((\"|')?(https?:)?//" || true)"
if [[ -n "${external}" ]]; then
  report "the stylesheet references an off-origin URL:"
  printf '%s\n' "${external}" | sort -u | head -5 >&2
fi

# 4. The fonts the stylesheet names must actually be in the image. A missing
#    one does not fail the build -- the page just silently renders in something
#    else, which is how @font-face went fourteen releases without a file.
while IFS= read -r font; do
  [[ -f "${DIST}/${font#/}" ]] || report "styles reference a missing font file: ${font}"
done < <(grep -ohE "url\(/[^)]*\.(woff2?|ttf|otf)\)" "${DIST}"/assets/*.css 2>/dev/null \
  | sed -E "s/^url\(//; s/\)$//" | sort -u)

if [[ "${failures}" -gt 0 ]]; then
  echo "CSP closure check failed with ${failures} problem(s)." >&2
  exit 1
fi
echo "CSP closure check passed (no runtime style injection, no off-origin assets, fonts present)."
