/**
 * The chat transport, held to the two things it owes the socket it opened.
 *
 * `api.test.ts` covers that a split SSE stream parses. This covers what happens
 * when it does not: the reader is the only handle on an open request, and a
 * frame this build cannot read is a routine consequence of a rolling deploy
 * with a tab left open, not a reason to abandon the connection.
 *
 * Both cases are about connection count rather than about text. A browser
 * allows roughly six concurrent HTTP/1.1 requests per origin, and the view
 * reconnects on the same controller — so a request left open is a socket the
 * whole application never gets back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatEvents } from "./api.js";

afterEach(() => vi.restoreAllMocks());

const CONVERSATION = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const MESSAGE = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";

const frame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;

const delta = (cursor: string, text: string) => frame({
  type: "delta",
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  cursor,
  delta: text,
});

/** A stream that reports whether anything ever cancelled it. */
function sseResponse(frames: string[], { close = true } = {}) {
  const encoder = new TextEncoder();
  const cancelled = { value: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
    cancel() {
      cancelled.value = true;
    },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }));
  return cancelled;
}

describe("streamChatEvents", () => {
  it("cancels the reader when the read loop is abandoned", async () => {
    /*
     * The loop used to unwind straight out of `getReader()` with no cleanup: no
     * cancel, no abort, so the request stayed open, the server's
     * `request.raw.once("close")` never fired, and its subscription kept
     * polling. The view then reconnected on the same controller and added
     * another one, unbounded.
     *
     * The source deliberately never closes, so a reader that is not cancelled
     * leaves `cancelled` false — which is exactly the leaked request.
     */
    const cancelled = sseResponse([delta("1", "Hi")], { close: false });

    await expect(streamChatEvents(
      CONVERSATION,
      MESSAGE,
      null,
      () => { throw new Error("the reducer refused this event"); },
      new AbortController().signal,
    )).rejects.toThrow("the reducer refused this event");

    expect(cancelled.value).toBe(true);
  });

  it("skips a frame it cannot read rather than dropping the run", async () => {
    /*
     * Version skew, which is a rolling deploy with a tab left open: a `type`
     * this build has never heard of, or a `state.status` outside the enum it
     * was compiled with. Throwing on that abandoned the reader *and* lost every
     * frame after it; the run kept going on the server with nothing reading it.
     *
     * `activity` is deliberately an open string, so new runtime event types
     * were already safe. New frame types were not.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sseResponse([
      delta("1", "Before"),
      frame({ type: "telemetry_window", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "2", window: 8 }),
      delta("3", "After"),
    ]);
    const seen: string[] = [];

    await streamChatEvents(CONVERSATION, MESSAGE, null, (event) => seen.push(event.type), new AbortController().signal);

    expect(seen).toEqual(["delta", "delta"]);
    // Skipped is not swallowed: this tab is provably behind the control plane,
    // and nothing else in the client can say so.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("chat stream frame");
    expect(warn.mock.calls[0]?.join(" ")).toContain("telemetry_window");
  });

  it("still reports a transport error the server named", async () => {
    // `stream_error` is the server saying the connection gave out, not the run.
    // Skipping unreadable frames must not have made this one of them.
    sseResponse([frame({
      type: "stream_error",
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      cursor: null,
      error: "The event subscription closed.",
    })]);

    await expect(streamChatEvents(CONVERSATION, MESSAGE, null, () => undefined, new AbortController().signal))
      .rejects.toThrow("The event subscription closed.");
  });
});
