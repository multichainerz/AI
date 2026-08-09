import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Paces streamed run events so a fast run reads as writing rather than as
 * flicker.
 *
 * Hermes can emit deltas far faster than a screen refreshes. Applying each one
 * the instant it lands means several React renders inside a single frame, none
 * of which anybody sees, and the one that does get painted arrives as a jump of
 * a whole sentence. Holding deltas for a frame and releasing a share of the
 * backlog per tick spends the same total time producing text that moves.
 *
 * The rule that decides how much to release is exported on its own, because a
 * hook that only runs against a real animation frame is a hook whose pacing
 * cannot be tested -- and pacing is the entire point of this file.
 */

/**
 * How much of the backlog leaves per frame, as a divisor.
 *
 * Releasing a *share* rather than a fixed count is what makes the speed track
 * the run: a slow answer drains almost as fast as it arrives, a fast one builds
 * a queue that then empties faster. A fixed count would either stall behind a
 * burst or strobe on a trickle.
 */
export const PACED_STREAM_DIVISOR = 6;

/**
 * The backlog past which pacing stops helping and starts lagging.
 *
 * A queue this deep is not a fast run, it is a reconnect replaying everything
 * the reader missed. Dribbling that out a sixth at a time would animate history
 * for several seconds while the live run carries on behind it, so the whole
 * backlog goes at once and pacing resumes from empty.
 */
export const PACED_STREAM_BURST_THRESHOLD = 120;

/**
 * How many queued frames to release on this tick.
 *
 * Whole frames only, always. Never a slice of one: the server resumes a stream
 * exclusively from the last cursor the client acknowledged, so a delta applied
 * halfway is a delta the server believes was never delivered -- and the resumed
 * stream sends it again, duplicating the half already on screen.
 */
export function framesToRelease(queued: number): number {
  if (queued <= 0) return 0;
  if (queued > PACED_STREAM_BURST_THRESHOLD) return queued;
  return Math.max(1, Math.ceil(queued / PACED_STREAM_DIVISOR));
}

/** The only field the pacer reads; the caller owns the rest of the event. */
interface PacedEvent {
  readonly type: string;
}

/**
 * The event kind that is safe to hold back.
 *
 * Everything else -- a state change, an approval, a completion, a failure --
 * either blocks the run or ends it, and holding one of those for a frame while
 * the text it belongs to is still queued shows the reader a finished turn with
 * missing words. Those flush the queue and apply immediately.
 */
const PACED_EVENT_TYPE = "delta";

export interface PacedStream<E extends PacedEvent> {
  /** Queue a delta, or flush and apply anything else at once. */
  push: (event: E) => void;
  /**
   * Apply every queued frame synchronously, now.
   *
   * Must be called before the stream is re-read from the server -- on reconnect
   * and on stream end -- and before abort or unmount. A reconnect re-reads the
   * cursor the *server* recorded, so anything still sitting in this queue is
   * text the client has been told it already has and will never be sent again.
   */
  flush: () => void;
}

export function usePacedStream<E extends PacedEvent>(
  apply: (events: readonly E[]) => void,
): PacedStream<E> {
  /*
   * The applier is read through a ref so `push` and `flush` stay referentially
   * stable: they are captured by a long-lived stream subscription that is set
   * up once per conversation, and a new identity each render would either tear
   * that subscription down mid-run or leave it calling a stale closure.
   */
  const applyEvents = useRef(apply);
  useEffect(() => {
    applyEvents.current = apply;
  });

  const queue = useRef<E[]>([]);
  const frame = useRef<number | null>(null);

  const paced = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";

  const drain = useCallback((count: number) => {
    if (count <= 0) return;
    const released = queue.current.splice(0, count);
    if (released.length > 0) applyEvents.current(released);
  }, []);

  const flush = useCallback(() => {
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    drain(queue.current.length);
  }, [drain]);

  const pump = useCallback(() => {
    // No animation frames to schedule against -- a non-visual test environment,
    // or server rendering. Pacing is a presentation nicety; dropping text is
    // not, so fall back to applying immediately.
    if (!paced) {
      drain(queue.current.length);
      return;
    }
    if (frame.current !== null) return;
    const step = () => {
      frame.current = null;
      drain(framesToRelease(queue.current.length));
      if (queue.current.length > 0) frame.current = window.requestAnimationFrame(step);
    };
    frame.current = window.requestAnimationFrame(step);
  }, [drain, paced]);

  const push = useCallback((event: E) => {
    if (event.type === PACED_EVENT_TYPE) {
      queue.current.push(event);
      pump();
      return;
    }
    // Order is the contract: whatever text was already queued belongs before
    // the event that ends or blocks the turn.
    flush();
    applyEvents.current([event]);
  }, [flush, pump]);

  /*
   * Cancelling the pending frame is not enough: whatever it was going to apply
   * is still queued, and cancelling alone drops it.
   *
   * This hook's contract says queued frames survive to unmount, so it has to
   * honour that itself rather than rely on a caller happening to register a
   * later cleanup that flushes. The one caller does today, which is the only
   * reason the omission was invisible -- and effect cleanups run in order of
   * registration, so that is an ordering nobody declared and any edit can
   * silently reverse.
   */
  useEffect(() => () => {
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    drain(queue.current.length);
  }, [drain]);

  return useMemo(() => ({ push, flush }), [push, flush]);
}
