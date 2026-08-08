import { describe, expect, it, vi } from "vitest";
import { streamChatCompletion } from "./chat-completion.js";

/**
 * Streaming is what makes the call possible at all on a tunnelled route: the
 * pilot returned 524 after 125s non-streaming and 200 after 400s streamed. That
 * only helps if the frames are reassembled correctly, and SSE arrives split at
 * arbitrary byte boundaries — so that is what these cover.
 */

const connection = {
  id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
  kind: "INFERENCE" as const,
  baseUrl: "https://inference.internal/",
  configuration: {},
  secrets: { apiKey: "k".repeat(40) },
};

function streaming(chunks: string[], status = 200) {
  return vi.fn(async () => new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status },
  ));
}

const frame = (delta: object) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, ...delta }] })}\n\n`;

/** The same frame with CRLF separators, which SSE permits and proxies produce. */
const crlfFrame = (delta: object) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, ...delta }] })}\r\n\r\n`;

function request(fetcher: typeof fetch) {
  return {
    connection,
    model: "qwen3.6-27b",
    system: "You extract facts.",
    user: "USER: I work in Jakarta.",
    maximumTokens: 2_400,
    timeoutMs: 30_000,
    fetcher,
  };
}

describe("streamChatCompletion", () => {
  it("reassembles the answer from its deltas", async () => {
    const result = await streamChatCompletion(request(streaming([
      frame({ delta: { content: '[{"fact": ' } }),
      frame({ delta: { content: '"The user works in Jakarta."' } }),
      frame({ delta: { content: "}]" } }),
      frame({ delta: {}, finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]) as never));

    expect(result).toEqual({
      content: '[{"fact": "The user works in Jakarta."}]',
      finishReason: "stop",
      succeeded: true,
    });
  });

  it("reassembles an answer whose frames are separated by CRLF", async () => {
    // SSE permits CRLF separators and normalizing proxies produce them.
    // Splitting on "\n\n" alone never closes a frame, so the buffer grew for the
    // whole request and only the FIRST data: line was recovered at done — and
    // it was still reported as succeeded, so the distiller silently wrote memory
    // derived from a fragment of the model's answer. The sibling parser in this
    // same package already splits on /\r?\n\r?\n/.
    const result = await streamChatCompletion(request(streaming([
      crlfFrame({ delta: { content: "hello " } }),
      crlfFrame({ delta: { content: "world" } }),
      crlfFrame({ delta: {}, finish_reason: "stop" }),
      "data: [DONE]\r\n\r\n",
    ]) as never));

    expect(result).toEqual({ content: "hello world", finishReason: "stop", succeeded: true });
  });

  it("reassembles frames split across chunk boundaries", async () => {
    // A frame arriving in three network reads is the normal case, not an edge
    // one; a parser that assumed whole frames would drop most of the answer.
    const whole = frame({ delta: { content: "hello" } }) + frame({ delta: { content: " world" } });
    const result = await streamChatCompletion(request(streaming([
      whole.slice(0, 17), whole.slice(17, 40), whole.slice(40),
    ]) as never));

    expect(result.content).toBe("hello world");
  });

  it("keeps the answer when the stream ends without a blank line", async () => {
    // vLLM does not always send a trailing separator, and discarding the last
    // frame would silently truncate every answer.
    const result = await streamChatCompletion(request(streaming([
      frame({ delta: { content: "kept" } }).trimEnd(),
    ]) as never));

    expect(result.content).toBe("kept");
  });

  it("accumulates the answer and not the model's working", async () => {
    // A reasoning model streams reasoning_content too. It is the thinking, not
    // the answer, and storing it would put the model's scratchpad in memory.
    const result = await streamChatCompletion(request(streaming([
      frame({ delta: { reasoning_content: "Let me think about this..." } }),
      frame({ delta: { content: "[]" } }),
      frame({ delta: {}, finish_reason: "stop" }),
    ]) as never));

    expect(result.content).toBe("[]");
  });

  it("reports the budget running out, with whatever arrived", async () => {
    const result = await streamChatCompletion(request(streaming([
      frame({ delta: { content: "partial" } }),
      frame({ delta: {}, finish_reason: "length" }),
    ]) as never));

    expect(result).toMatchObject({ content: "partial", finishReason: "length", succeeded: true });
  });

  it("survives a frame that is not JSON", async () => {
    // A keep-alive comment or a truncated frame must not discard what came
    // before it.
    const result = await streamChatCompletion(request(streaming([
      ": keep-alive\n\n",
      frame({ delta: { content: "good" } }),
      "data: {not json\n\n",
    ]) as never));

    expect(result).toMatchObject({ content: "good", succeeded: true });
  });

  it("fails rather than returning nothing when the route rejects the call", async () => {
    const result = await streamChatCompletion(request(
      vi.fn(async () => new Response("upstream down", { status: 502 })) as never,
    ));
    expect(result).toEqual({ content: "", finishReason: null, succeeded: false });
  });

  it("asks for a stream, at the endpoint the route actually exposes", async () => {
    const fetcher = streaming([frame({ delta: { content: "[]" } })]);
    await streamChatCompletion(request(fetcher as never));

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    // The configured base URL carries a trailing slash on the pilot; a double
    // slash is a 404 on vLLM.
    expect(url).toBe("https://inference.internal/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true, temperature: 0, max_tokens: 2_400, model: "qwen3.6-27b",
    });
    expect((init.headers as Record<string, string>).authorization).toContain("Bearer");
  });
});
