import { describe, expect, it } from "vitest";
import { rejectedCompatibilityHints } from "./inference-gateway.js";

/**
 * A chunked 400 whose body is far larger than the 16 KiB the hint reader is
 * allowed to look at, with a counter for how much was actually pulled.
 *
 * `content-length` is deliberately absent, which is the whole point: the
 * declared-length guard reads `Number(null)` as 0, so it never fires on a
 * chunked response.
 */
function chunkedError(totalChunks: number) {
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalChunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return {
    response: new Response(body, { status: 400 }),
    pulledChunks: () => pulled,
  };
}

describe("rejectedCompatibilityHints", () => {
  it("still recognises a hint rejection in a small body", async () => {
    const response = new Response(
      JSON.stringify({ error: "Unrecognized request argument supplied: reasoning_effort" }),
      { status: 400 },
    );

    expect([...await rejectedCompatibilityHints(response)]).toContain("reasoning_effort");
  });

  it("ignores anything that is not a 400", async () => {
    expect((await rejectedCompatibilityHints(new Response("nope", { status: 500 }))).size).toBe(0);
  });

  it("stops reading a chunked error body at the cap instead of draining it", async () => {
    /*
     * The assertion `chunkedError` was written for, and never given.
     *
     * A hostile or merely broken upstream can answer a 400 with an unbounded
     * chunked body and no `content-length`. The declared-length guard above
     * reads `Number(null)` as 0 and waves it through, so the only thing
     * standing between the control plane and that stream is the 16 KiB bound
     * inside `readBounded`. Counting the chunks actually pulled is the only
     * way to observe that the read stopped: the return value is an empty set
     * either way, whether the reader gave up after 16 KiB or swallowed a
     * gigabyte first.
     */
    const oversized = chunkedError(512); // 512 x 64 KiB = 32 MiB if drained

    expect((await rejectedCompatibilityHints(oversized.response)).size).toBe(0);
    // 16 KiB of allowance against 64 KiB chunks: one chunk crosses the bound.
    expect(oversized.pulledChunks()).toBeLessThanOrEqual(2);
  });
});
