import { describe, expect, it } from "vitest";
import {
  framesToRelease,
  PACED_STREAM_BURST_THRESHOLD,
  PACED_STREAM_DIVISOR,
} from "./use-paced-stream.js";

/**
 * The pacing rule, tested apart from the frame loop that drives it.
 *
 * A hook that only ever runs against a real `requestAnimationFrame` is a hook
 * whose pacing cannot be checked: the test environment paints nothing, so every
 * release-rate bug -- releasing one frame per tick, releasing the whole queue,
 * releasing none -- looks identical from the outside. The decision is therefore
 * a pure function of the backlog depth, and this is where it is pinned.
 */
describe("framesToRelease", () => {
  it("releases nothing when nothing is queued", () => {
    expect(framesToRelease(0)).toBe(0);
    // Defensive: a negative depth means the queue was mutated behind the pacer,
    // and splicing a negative count would release the whole backlog.
    expect(framesToRelease(-1)).toBe(0);
  });

  it("always releases at least one frame, so a trickle never stalls", () => {
    /*
     * `ceil(1/6)` is 1, but a floor-based rule would give 0 -- and a queue that
     * releases nothing per tick never drains: the answer stops mid-sentence
     * while the run carries on.
     */
    expect(framesToRelease(1)).toBe(1);
    expect(framesToRelease(5)).toBe(1);
  });

  it("releases a share of the backlog, so speed tracks the run", () => {
    // A fixed count would stall behind a burst and strobe on a trickle. The
    // share is what makes a fast answer drain faster than a slow one.
    expect(framesToRelease(12)).toBe(2);
    expect(framesToRelease(60)).toBe(10);
    expect(framesToRelease(120)).toBe(20);
  });

  it("never releases more than is queued", () => {
    for (const queued of [1, 2, 7, 13, 61, 119, 120, 121, 500]) {
      expect(framesToRelease(queued)).toBeLessThanOrEqual(queued);
    }
  });

  it("abandons pacing once the backlog is a replay rather than a run", () => {
    /*
     * Past the threshold the queue is a reconnect handing back everything the
     * reader missed. A sixth per frame would animate history for seconds while
     * the live run streams in behind it.
     */
    expect(framesToRelease(PACED_STREAM_BURST_THRESHOLD)).toBe(
      Math.ceil(PACED_STREAM_BURST_THRESHOLD / PACED_STREAM_DIVISOR),
    );
    expect(framesToRelease(PACED_STREAM_BURST_THRESHOLD + 1)).toBe(PACED_STREAM_BURST_THRESHOLD + 1);
    expect(framesToRelease(4_000)).toBe(4_000);
  });

  it("counts whole frames only", () => {
    /*
     * The trap this exists for: the server resumes a stream exclusively from
     * the cursor the client acknowledged, so a delta applied halfway is a delta
     * the server believes was never delivered -- and the resumed stream sends it
     * again, duplicating the half already on screen. A fractional release count
     * is the only way that could happen from this side.
     */
    for (const queued of [1, 3, 7, 11, 59, 119, 121]) {
      expect(Number.isInteger(framesToRelease(queued))).toBe(true);
    }
  });
});
