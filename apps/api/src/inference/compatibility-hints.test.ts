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
});
