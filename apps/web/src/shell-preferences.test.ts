/**
 * @vitest-environment jsdom
 *
 * The rail preference survives a reload, and a denied storage does not take the
 * shell down with it.
 *
 * `app.tsx` has no test of its own, so this covers the one piece of the collapse
 * that can be tested without mounting the shell: that what is written is what
 * comes back, and that every failure mode lands on the readable default rather
 * than on a half-collapsed rail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistRailCollapsed, storedRailCollapsed } from "./shell-preferences.js";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("rail preference", () => {
  it("defaults to the labelled rail", () => {
    expect(storedRailCollapsed()).toBe(false);
  });

  it("remembers a collapse", () => {
    persistRailCollapsed(true);
    expect(storedRailCollapsed()).toBe(true);
  });

  it("forgets it again rather than storing a second falsy value", () => {
    // Writing "expanded" would leave two spellings of the default in the wild,
    // and the next reader has to know both.
    persistRailCollapsed(true);
    persistRailCollapsed(false);

    expect(storedRailCollapsed()).toBe(false);
    expect(window.localStorage.getItem("orcasynapse.rail")).toBeNull();
  });

  it("treats anything it did not write as the default", () => {
    window.localStorage.setItem("orcasynapse.rail", "true");
    expect(storedRailCollapsed()).toBe(false);
  });

  it("survives storage being denied", () => {
    /*
     * A private window or a hardened profile throws on access rather than
     * returning null. An uncaught throw here happens during the shell's first
     * render, which means a blank page instead of a wider sidebar.
     */
    const denied = new Error("The operation is insecure.");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw denied; });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw denied; });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw denied; });

    expect(storedRailCollapsed()).toBe(false);
    expect(() => persistRailCollapsed(true)).not.toThrow();
    expect(() => persistRailCollapsed(false)).not.toThrow();
  });
});
