import { describe, expect, it, vi } from "vitest";
import { InferenceRequestError, OpenAICompatibleInferenceClient } from "./inference-client.js";

const input = {
  baseUrl: "https://vllm.orcasynapse.internal",
  chatPath: "/v1/chat/completions",
  apiKey: "write-only-key",
  model: "laguna-primary",
  messages: [{ role: "user" as const, content: "Hello" }],
  maxOutputTokens: 1024,
  temperature: 0.2,
  timeoutMs: 30_000,
  user: "pseudonymous-user",
};

describe("OpenAI-compatible inference streaming client", () => {
  it("parses split SSE chunks and usage without sending proxy-specific fields", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"req-1","choices":[{"delta":{"content":"Hel"}}]}\n'));
        controller.enqueue(encoder.encode('\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetcher = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer write-only-key");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({
        model: "laguna-primary",
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(request).not.toHaveProperty("guardrails");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const deltas: string[] = [];

    const result = await new OpenAICompatibleInferenceClient(fetcher as typeof fetch).stream(
      input,
      new AbortController().signal,
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result).toMatchObject({
      content: "Hello",
      finishReason: "stop",
      providerRequestId: "req-1",
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
  });

  it("sanitizes upstream authentication failures", async () => {
    const fetcher = vi.fn(async () => new Response("credential details", { status: 401 }));
    await expect(
      new OpenAICompatibleInferenceClient(fetcher as typeof fetch).stream(
        input,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InferenceRequestError>>({
        code: "INFERENCE_AUTHENTICATION_FAILED",
        message: "The inference server rejected the configured credential.",
      }),
    );
  });

  it("reports a sanitized upstream rejection", async () => {
    const fetcher = vi.fn(async () => new Response("server internals", { status: 400 }));
    await expect(
      new OpenAICompatibleInferenceClient(fetcher as typeof fetch).stream(
        input,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<InferenceRequestError>>({
      code: "INFERENCE_REJECTED",
      message: "The inference server rejected the request with status 400.",
    }));
  });
});
