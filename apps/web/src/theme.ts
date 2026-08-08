/**
 * Theme selection, applied before first render.
 *
 * The attribute lives on <html> so the token overrides in `styles.css` apply to
 * everything, including portals and the scrollbar. This module is imported at
 * the top of `main.tsx` — before React mounts — which is what stands in for an
 * inline <head> script here: `script-src 'self'` forbids the classic pre-paint
 * snippet, and running in the entry module is early enough that no dark frame
 * is ever presented to a light-theme operator.
 *
 * Dark is the default and the absence of the attribute; only "light" is ever
 * written to the DOM or to storage, so a stale or tampered value degrades to
 * dark rather than to a broken half-theme.
 */

const STORAGE_KEY = "orcasynapse.theme";

export type Theme = "dark" | "light";

function storedTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    // Storage can be denied (private windows, hardened profiles); the product
    // must render regardless, so denial simply means the default.
    return "dark";
  }
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  // The browser chrome (mobile address bar, overscroll) should match the page
  // behind it; index.html carries the dark value for the pre-module instant.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#EFF0ED" : "#101014");
  try {
    if (theme === "light") {
      window.localStorage.setItem(STORAGE_KEY, "light");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Not being able to persist the choice is not a reason to refuse it.
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "light" ? "dark" : "light";
  applyTheme(next);
  return next;
}

applyTheme(storedTheme());
