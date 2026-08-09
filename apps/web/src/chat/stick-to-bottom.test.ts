import { describe, expect, it } from "vitest";
import { shouldStickToBottom, STICK_TO_BOTTOM_SLACK } from "./stick-to-bottom.js";

/** A transcript taller than its viewport, scrolled `fromBottom` pixels up. */
const scrolledUp = (fromBottom: number) => ({
  scrollHeight: 4_000,
  clientHeight: 800,
  scrollTop: 4_000 - 800 - fromBottom,
});

describe("shouldStickToBottom", () => {
  it("follows a reader who is at the bottom", () => {
    expect(shouldStickToBottom(scrolledUp(0))).toBe(true);
  });

  it("stops following a reader who has scrolled up to re-read something", () => {
    /*
     * The defect this replaces: the transcript scrolled on every message change,
     * which during a streaming turn is several times a second. Scrolling up
     * yanked the view back down before the sentence could be read.
     */
    expect(shouldStickToBottom(scrolledUp(400))).toBe(false);
    expect(shouldStickToBottom(scrolledUp(2_000))).toBe(false);
  });

  it("treats a few pixels off the bottom as still at the bottom", () => {
    // Fractional scroll metrics rarely land exactly on the bottom, and a nudge
    // of the wheel is not a request to stop following.
    expect(shouldStickToBottom(scrolledUp(1))).toBe(true);
    expect(shouldStickToBottom(scrolledUp(STICK_TO_BOTTOM_SLACK))).toBe(true);
    expect(shouldStickToBottom(scrolledUp(STICK_TO_BOTTOM_SLACK + 1))).toBe(false);
  });

  it("follows when the transcript is shorter than its viewport", () => {
    // Nothing to scroll: a fresh conversation must still pin, or the first
    // answer never follows.
    expect(shouldStickToBottom({ scrollHeight: 300, clientHeight: 800, scrollTop: 0 })).toBe(true);
  });

  it("follows when every metric is zero", () => {
    /*
     * jsdom's answer for an unlaid-out element, and the reason this rule lives
     * in a pure function at all: a component test only ever sees this case, so
     * it cannot tell a working rule from a missing one. Pinning here keeps the
     * existing render tests meaningful rather than accidentally green.
     */
    expect(shouldStickToBottom({ scrollHeight: 0, clientHeight: 0, scrollTop: 0 })).toBe(true);
  });
});
