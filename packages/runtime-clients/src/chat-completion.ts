import type { RuntimeConnection } from "./connection-resolver.js";

/**
 * One chat completion against the configured inference route, streamed.
 *
 * Streaming is not a performance choice here, it is what makes the call
 * possible at all on some transports. A Cloudflare quick tunnel kills any
 * request whose origin takes longer than about 100 seconds, and a 27B reasoning
 * model asked for a couple of thousand tokens routinely takes longer than that.
 * Measured on the pilot: the same prompt returned `524` after 125s
 * non-streaming, and `200` after 400s streamed, because each chunk resets the
 * idle timer.
 *
 * Both callers that need this — memory distillation and forget-matching — live
 * in different apps, so it belongs here rather than being written twice with
 * two sets of parsing bugs.
 */

export interface ChatCompletionRequest {
  connection: RuntimeConnection;
  model: string;
  system: string;
  user: string;
  maximumTokens: number;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

export interface ChatCompletionResult {
  /** Empty when the model answered with nothing, which is never a success. */
  content: string;
  /** "length" means the budget ran out before an answer, not that none exists. */
  finishReason: string | null;
  /** False when the route could not be reached or answered unusably. */
  succeeded: boolean;
}

const FAILED: ChatCompletionResult = { content: "", finishReason: null, succeeded: false };

/**
 * Reads one SSE frame's JSON payload.
 *
 * Returns undefined for the terminator and for anything unparseable: a stream
 * that ends mid-frame must not discard the content already accumulated.
 */
function payloadOf(frame: string): Record<string, unknown> | undefined {
  const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
  if (!line) return undefined;
  const body = line.slice(5).trim();
  if (body.length === 0 || body === "[DONE]") return undefined;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function streamChatCompletion(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const fetcher = request.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetcher(
      `${request.connection.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(request.connection.secrets.apiKey
            ? { authorization: `Bearer ${request.connection.secrets.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: 0,
          max_tokens: request.maximumTokens,
          stream: true,
        }),
      },
    );
    if (!response.ok || !response.body) return FAILED;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; keep the trailing partial.
      //
      // CRLF counts. SSE permits it and normalizing proxies emit it, and
      // splitting on "\n\n" alone never closed a frame: the buffer grew for the
      // whole request and only the first `data:` line was recovered at the end,
      // still reported as a success. The distiller then wrote memory derived
      // from a fragment of the answer. The Hermes parser in this same package
      // has always used this pattern.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = payloadOf(frame);
        if (!payload) continue;
        const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0];
        if (!choice) continue;
        const delta = choice.delta as Record<string, unknown> | undefined;
        // Only `content` is accumulated. A reasoning model also streams
        // `reasoning_content`, which is its working and not its answer.
        if (typeof delta?.content === "string") content += delta.content;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      }
    }
    const trailing = payloadOf(buffer);
    if (trailing) {
      const choice = (trailing.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string") content += delta.content;
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    }

    return { content, finishReason, succeeded: true };
  } catch {
    return FAILED;
  } finally {
    clearTimeout(timer);
  }
}
