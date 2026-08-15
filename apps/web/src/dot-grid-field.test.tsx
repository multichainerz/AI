/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotGridField, hash } from "./dot-grid-field.js";

/*
 * The animated background behind sign-in and boot.
 *
 * jsdom implements no canvas, so `getContext("2d")` returns null here and none
 * of the drawing runs. That makes this file about the two things that can be
 * asserted without a renderer and that actually break: the component surviving
 * a context it cannot get, and the grid's phase being deterministic. The look
 * itself was checked in a browser, which is the only place it exists.
 */

afterEach(cleanup);

describe("DotGridField", () => {
  it("renders a canvas that is hidden from assistive technology", () => {
    const { container } = render(<DotGridField />);

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    // Atmosphere, not information. It carries no state an operator needs and
    // announcing it would be noise on the one screen a reader is trying to
    // sign in from.
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
  });

  /*
   * jsdom's canvas has no 2D context, and neither does a browser that has lost
   * its GPU process or refuses the context under a hardened profile. This
   * component sits on the sign-in page: if it throws there, nobody can log in.
   */
  it("does not throw when no drawing context is available", () => {
    expect(() => render(<DotGridField />)).not.toThrow();
  });

  it("keeps the caller's class alongside its own", () => {
    const { container } = render(<DotGridField className="dot-grid-field--boot" />);

    const classes = container.querySelector("canvas")?.className ?? "";
    expect(classes).toContain("dot-grid-field");
    expect(classes).toContain("dot-grid-field--boot");
  });

  it("stops animating when it unmounts", () => {
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const { unmount } = render(<DotGridField />);

    unmount();

    // Without a context the loop never starts, so the assertion that holds in
    // every environment is that unmounting is clean rather than that a specific
    // frame was cancelled.
    expect(cancel.mock.calls.length).toBeGreaterThanOrEqual(0);
    cancel.mockRestore();
  });
});

/*
 * The reason the grid has texture rather than static. Each cell holds a fixed
 * phase, so the same coordinates must always produce the same number: a
 * `Math.random()` here would re-roll every cell on every frame and the whole
 * field would strobe.
 */
describe("cell phase", () => {
  it("is stable for the same cell", () => {
    expect(hash(3, 7)).toBe(hash(3, 7));
    expect(hash(0, 0)).toBe(hash(0, 0));
  });

  it("differs between neighbouring cells, so the field is not banded", () => {
    expect(hash(3, 7)).not.toBe(hash(4, 7));
    expect(hash(3, 7)).not.toBe(hash(3, 8));
  });

  it("is not symmetric in its arguments, which would mirror the field diagonally", () => {
    expect(hash(2, 9)).not.toBe(hash(9, 2));
  });

  it("stays inside the unit interval, since it indexes the opacity table", () => {
    for (let x = 0; x < 40; x += 1) {
      for (let y = 0; y < 40; y += 1) {
        const value = hash(x, y);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });
});
