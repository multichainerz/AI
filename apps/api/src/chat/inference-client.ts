export interface InferenceInputMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceStreamInput {
  baseUrl: string;
  chatPath: string;
  apiKey?: string | undefined;
  model: string;
  messages: InferenceInputMessage[];
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  user: string;
  maxResponseCharacters?: number | undefined;
}

export interface InferenceStreamResult {
  content: string;
  finishReason: string | null;
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export class InferenceRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InferenceRequestError";
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseChunk(
  value: unknown,
): {
  delta: string;
  finishReason: string | null;
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
} {
  if (!value || typeof value !== "object") {
    return {
      delta: "",
      finishReason: null,
      providerRequestId: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    };
  }
  const record = value as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  const choice = first && typeof first === "object" ? (first as Record<string, unknown>) : {};
  const deltaRecord = choice.delta && typeof choice.delta === "object"
    ? (choice.delta as Record<string, unknown>)
    : {};
  const usage = record.usage && typeof record.usage === "object"
    ? (record.usage as Record<string, unknown>)
    : {};
  return {
    delta: typeof deltaRecord.content === "string" ? deltaRecord.content : "",
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    providerRequestId: typeof record.id === "string" ? record.id.slice(0, 200) : null,
    inputTokens: numberOrNull(usage.prompt_tokens),
    outputTokens: numberOrNull(usage.completion_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
  };
}

export class OpenAICompatibleInferenceClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async stream(
    input: InferenceStreamInput,
    signal: AbortSignal,
    onDelta: (delta: string) => void,
  ): Promise<InferenceStreamResult> {
    let endpoint: URL;
    try {
      endpoint = new URL(input.chatPath, `${input.baseUrl.replace(/\/+$/, "")}/`);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error("Unsupported inference URL.");
      }
    } catch {
      throw new InferenceRequestError("INVALID_ENDPOINT", "The inference server endpoint is invalid.");
    }

    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        signal: combinedSignal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: input.maxOutputTokens,
          temperature: input.temperature,
          user: input.user,
        }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeoutSignal.aborted) {
        throw new InferenceRequestError(
          "INFERENCE_TIMEOUT",
          `The inference server did not complete the response within ${input.timeoutMs} ms.`,
        );
      }
      throw new InferenceRequestError("INFERENCE_UNREACHABLE", "The inference server could not be reached.");
    }

    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? "INFERENCE_AUTHENTICATION_FAILED"
        : response.status === 429
          ? "INFERENCE_RATE_LIMITED"
          : "INFERENCE_REJECTED";
      throw new InferenceRequestError(
        code,
        response.status === 429
          ? "The inference server is currently at its request limit."
          : response.status === 401 || response.status === 403
            ? "The inference server rejected the configured credential."
            : `The inference server rejected the request with status ${response.status}.`,
      );
    }
    if (!response.body) {
      throw new InferenceRequestError("INFERENCE_EMPTY_STREAM", "The inference server returned no response stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    let providerRequestId = response.headers.get("x-request-id")?.slice(0, 200) ?? null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let totalTokens: number | null = null;
    const maxResponseCharacters = Math.min(1_000_000, Math.max(1_024, input.maxResponseCharacters ?? 1_000_000));

    const consumeLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        throw new InferenceRequestError(
          "INFERENCE_INVALID_STREAM",
          "The inference server returned a malformed streaming response.",
        );
      }
      const chunk = parseChunk(parsed);
      if (chunk.delta) {
        if (content.length + chunk.delta.length > maxResponseCharacters) {
          throw new InferenceRequestError(
            "INFERENCE_RESPONSE_TOO_LARGE",
            "The model response exceeded OrcaSynapse's configured safety limit.",
          );
        }
        content += chunk.delta;
        onDelta(chunk.delta);
      }
      finishReason = chunk.finishReason ?? finishReason;
      providerRequestId = chunk.providerRequestId ?? providerRequestId;
      inputTokens = chunk.inputTokens ?? inputTokens;
      outputTokens = chunk.outputTokens ?? outputTokens;
      totalTokens = chunk.totalTokens ?? totalTokens;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
        if (done) break;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeoutSignal.aborted) {
        throw new InferenceRequestError(
          "INFERENCE_TIMEOUT",
          `The inference server did not complete the response within ${input.timeoutMs} ms.`,
        );
      }
      if (error instanceof InferenceRequestError) throw error;
      throw new InferenceRequestError(
        "INFERENCE_STREAM_INTERRUPTED",
        "The inference server response stream ended unexpectedly.",
      );
    } finally {
      reader.releaseLock();
    }
    if (buffer) consumeLine(buffer);
    if (!content) {
      throw new InferenceRequestError(
        "INFERENCE_EMPTY_RESPONSE",
        "The inference server completed without returning assistant content.",
      );
    }

    return {
      content,
      finishReason,
      providerRequestId,
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }
}
