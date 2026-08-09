/**
 * Operator preferences about the shell itself, persisted across sessions.
 *
 * The rail's width was decided by which view was open: Chat collapsed it and
 * every other screen expanded it, so it moved under the operator on every
 * navigation and could not be set deliberately. It is a preference, so it is
 * stored like one.
 *
 * Unlike `theme.ts` this writes no attribute of its own. The collapsed class
 * belongs to the shell element React already renders, so the value is read once
 * as initial state rather than applied to `<html>` before paint -- there is no
 * flash to prevent, because nothing is painted before React mounts.
 *
 * Collapsed is the non-default and the only value ever written, so a stale or
 * tampered entry degrades to the full rail rather than to something unusable.
 */

const RAIL_STORAGE_KEY = "orcasynapse.rail";

export function storedRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) === "collapsed";
  } catch {
    // Storage can be denied (private windows, hardened profiles). The shell has
    // to render regardless, and the readable default is the labelled rail.
    return false;
  }
}

export function persistRailCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) {
      window.localStorage.setItem(RAIL_STORAGE_KEY, "collapsed");
    } else {
      window.localStorage.removeItem(RAIL_STORAGE_KEY);
    }
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}
