import { describe, expect, it, vi } from "vitest";
import { LiteLLMClient, LiteLLMRequestError } from "./litellm-client.js";

const input = {
  baseUrl: "https://litellm.mpm.internal",
  chatPath: "/v1/chat/completions",
  apiKey: "write-only-key",
  model: "laguna-primary",
  messages: [{ role: "user" as const, content: "Hello" }],
  maxOutputTokens: 1024,
  temperature: 0.2,
  timeoutMs: 30_000,
  user: "pseudonymous-user",
};

describe("LiteLLM streaming client", () => {
  it("parses split OpenAI-compatible SSE chunks and usage", async () => {
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
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "laguna-primary",
        stream: true,
        stream_options: { include_usage: true },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const deltas: string[] = [];

    const result = await new LiteLLMClient(fetcher as typeof fetch).stream(
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
      new LiteLLMClient(fetcher as typeof fetch).stream(
        input,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LiteLLMRequestError>>({
        code: "INFERENCE_AUTHENTICATION_FAILED",
        message: "LiteLLM rejected the configured credential.",
      }),
    );
  });
});
