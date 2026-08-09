/**
 * @vitest-environment jsdom
 *
 * The pacing loop, driven by a frame clock this file controls.
 *
 * `framesToRelease` pins how much leaves per tick. What it cannot pin is the
 * part that loses text: whether a frame is ever released in pieces, whether a
 * flush actually drains, and whether an event that ends the turn can overtake
 * the words that belong before it. Those are properties of the queue, so they
 * are tested against the queue.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePacedStream } from "./use-paced-stream.js";

interface Frame {
  type: string;
  text?: string;
}

let pending: Array<() => void> = [];

/** Runs whatever the pacer scheduled for the next frame, and nothing more. */
const nextFrame = () => {
  const due = pending;
  pending = [];
  for (const run of due) run();
};

beforeEach(() => {
  pending = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    pending.push(callback);
    return pending.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    pending = [];
  });
});

afterEach(() => vi.unstubAllGlobals());

function pacer() {
  const applied: Frame[][] = [];
  const { result, unmount } = renderHook(() =>
    usePacedStream<Frame>((events) => applied.push([...events])));
  return { applied, stream: () => result.current, unmount };
}

const delta = (text: string): Frame => ({ type: "delta", text });

describe("usePacedStream", () => {
  it("holds deltas for a frame rather than applying each on arrival", () => {
    /*
     * The defect: Hermes emits faster than the screen refreshes, so applying on
     * arrival spends several renders inside one frame and paints the survivor
     * as a jump of a whole sentence.
     */
    const { applied, stream } = pacer();

    stream().push(delta("a"));
    stream().push(delta("b"));

    expect(applied).toEqual([]);
  });

  it("releases whole frames, never a slice of one", () => {
    /*
     * The trap this exists for: the server resumes exclusively from the cursor
     * the client acknowledged, so a delta applied halfway is one the server
     * believes was never delivered -- and it is re-sent in full, duplicating
     * the half already on screen. Every applied item must be an object that was
     * pushed, by identity.
     */
    const { applied, stream } = pacer();
    const pushed = ["a", "b", "c", "d", "e", "f", "g"].map(delta);

    for (const frame of pushed) stream().push(frame);
    nextFrame();
    nextFrame();
    nextFrame();

    const released = applied.flat();
    expect(released.length).toBeGreaterThan(0);
    for (const frame of released) expect(pushed).toContain(frame);
    expect(released).toEqual(pushed.slice(0, released.length));
  });

  it("drains synchronously on flush, so a reconnect loses no text", () => {
    /*
     * A reconnect re-reads the cursor the *server* recorded. Anything still in
     * this queue when that happens is text the client has been told it holds,
     * and it will never be sent again.
     */
    const { applied, stream } = pacer();
    const pushed = ["a", "b", "c"].map(delta);
    for (const frame of pushed) stream().push(frame);

    stream().flush();

    expect(applied.flat()).toEqual(pushed);
    // Synchronously: no frame has run, and none is left scheduled to.
    expect(pending).toEqual([]);
  });

  it("applies a turn-ending event only after the words that precede it", () => {
    // A completion that overtakes queued deltas shows a finished answer with
    // missing text, and nothing later puts the missing text back.
    const { applied, stream } = pacer();
    const words = ["a", "b"].map(delta);
    const completed: Frame = { type: "completed" };

    for (const frame of words) stream().push(frame);
    stream().push(completed);

    expect(applied.flat()).toEqual([...words, completed]);
  });

  it("keeps draining across frames until the queue is empty", () => {
    // One tick releases a share, not the lot; a loop that stops after the first
    // tick strands the rest of the answer with no second chance to release it.
    const { applied, stream } = pacer();
    const pushed = Array.from({ length: 20 }, (_, index) => delta(String(index)));
    for (const frame of pushed) stream().push(frame);

    for (let tick = 0; tick < 12 && pending.length > 0; tick += 1) nextFrame();

    expect(applied.flat()).toEqual(pushed);
  });

  it("keeps push and flush stable, so a live subscription is never torn down", () => {
    // Both are captured once by a subscription that lives for the whole run.
    const { stream } = pacer();
    const first = stream();

    stream().push(delta("a"));

    expect(stream().push).toBe(first.push);
    expect(stream().flush).toBe(first.flush);
  });
});
