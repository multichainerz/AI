import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { InferenceGatewayError } from "./inference-gateway.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function gatewayApp(chatResult?: () => { response: Response; maxResponseBytes: number; stream: boolean }) {
  const gateway = {
    models: vi.fn(async (token: string | undefined) => {
      if (token !== "runtime-key") throw new InferenceGatewayError("UNAUTHORIZED", "Invalid runtime key.");
      return { object: "list", data: [{ id: "hermes-agent", object: "model", owned_by: "orcasynapse" }] };
    }),
    chat: vi.fn(async (token: string | undefined) => {
      if (token !== "runtime-key") throw new InferenceGatewayError("UNAUTHORIZED", "Invalid runtime key.");
      return chatResult?.() ?? {
        response: new Response(JSON.stringify({ id: "chatcmpl-1", choices: [] }), { headers: { "content-type": "application/json" } }),
        maxResponseBytes: 65_536,
        stream: false,
      };
    }),
  };
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", inferenceGateway: gateway as never } });
  apps.push(app);
  return { app, gateway };
}

/** An upstream SSE stream of `count` token frames, in the OpenAI wire shape. */
function tokenFrames(count: number): Response {
  const frames = Array.from({ length: count }, (_, index) => `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: `tok${index} ` }, finish_reason: null }],
  })}\n\n`);
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("internal inference gateway routes", () => {
  it("requires the node-scoped bearer credential", async () => {
    const { app } = await gatewayApp();
    const response = await app.inject({ method: "GET", url: "/internal/v1/models" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { type: "unauthorized" } });
  });

  it("proxies a bounded OpenAI-compatible request without exposing the inference server", async () => {
    const { app, gateway } = await gatewayApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/chat/completions",
      headers: { authorization: "Bearer runtime-key" },
      payload: { model: "caller-choice", messages: [{ role: "user", content: "hello" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "chatcmpl-1" });
    expect(gateway.chat).toHaveBeenCalledWith("runtime-key", expect.objectContaining({ messages: [{ role: "user", content: "hello" }] }), expect.any(AbortSignal));
  });

  it("says so on the wire when it stops a stream at its byte limit", async () => {
    // The limit is enforced after the headers are flushed, so throwing simply
    // ended the body: no `[DONE]`, no error frame, and a caller holding a
    // truncated answer with nothing to distinguish it from a complete one.
    const { app } = await gatewayApp(() => ({
      response: tokenFrames(200),
      maxResponseBytes: 1_000,
      stream: true,
    }));

    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/chat/completions",
      headers: { authorization: "Bearer runtime-key" },
      payload: { model: "caller-choice", messages: [{ role: "user", content: "write at length" }], stream: true },
    });

    // Some content got through, and then the caller was told why it stopped.
    expect(response.payload).toContain("tok0");
    expect(response.payload).toContain("orcasynapse_response_limit");
    const frames = response.payload.split("\n\n").filter(Boolean);
    expect(JSON.parse(frames.at(-2)!.slice("data: ".length))).toMatchObject({
      error: { type: "response_limit_exceeded" },
    });
    expect(frames.at(-1)).toBe("data: [DONE]");
  });

  it("rejects unknown provider fields at the boundary", async () => {
    const { app, gateway } = await gatewayApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/chat/completions",
      headers: { authorization: "Bearer runtime-key" },
      payload: { messages: [{ role: "user", content: "hello" }], direct_vllm_override: true },
    });
    expect(response.statusCode).toBe(400);
    expect(gateway.chat).not.toHaveBeenCalled();
  });

  it("accepts a round-tripped reasoning trace and strips it before forwarding", async () => {
    /*
     * The second turn of every conversation against a reasoning model: Hermes
     * echoes the assistant message exactly as the model returned it,
     * reasoning trace included. The old strict allowlist failed that request
     * with a version-skew message — a total outage of turns two onward, per
     * conversation, while the node reported ONLINE. The trace is accepted so
     * history round-trips, and stripped because the upstreams that produce
     * reasoning reject it coming back.
     */
    const { app, gateway } = await gatewayApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/chat/completions",
      headers: { authorization: "Bearer runtime-key" },
      payload: {
        model: "caller-choice",
        messages: [
          { role: "user", content: "what" },
          { role: "assistant", content: "an answer", reasoning_content: "chain of thought", reasoning: "same, OpenRouter spelling" },
          { role: "user", content: "and then?" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    // The mock's declared signature carries only the token; the body is read
    // back through unknown because the assertion is about the wire shape.
    const forwarded = (gateway.chat.mock.calls.at(-1) as unknown as [unknown, { messages: Array<Record<string, unknown>> }])[1];
    expect(forwarded.messages).toHaveLength(3);
    expect(forwarded.messages[1]).toEqual({ role: "assistant", content: "an answer" });
    expect(JSON.stringify(forwarded)).not.toContain("chain of thought");
  });
});
