export interface LiteLLMInputMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LiteLLMStreamInput {
  baseUrl: string;
  chatPath: string;
  apiKey?: string | undefined;
  model: string;
  messages: LiteLLMInputMessage[];
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  user: string;
  guardrails: string[];
}

export interface LiteLLMStreamResult {
  content: string;
  finishReason: string | null;
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export class LiteLLMRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LiteLLMRequestError";
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
  const deltaRecord =
    choice.delta && typeof choice.delta === "object"
      ? (choice.delta as Record<string, unknown>)
      : {};
  const usage =
    record.usage && typeof record.usage === "object"
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

export class LiteLLMClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async stream(
    input: LiteLLMStreamInput,
    signal: AbortSignal,
    onDelta: (delta: string) => void,
  ): Promise<LiteLLMStreamResult> {
    let endpoint: URL;
    try {
      endpoint = new URL(input.chatPath, `${input.baseUrl.replace(/\/+$/, "")}/`);
    } catch {
      throw new LiteLLMRequestError("INVALID_ENDPOINT", "The LiteLLM endpoint is invalid.");
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
          ...(input.guardrails.length > 0 ? { guardrails: input.guardrails } : {}),
        }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeoutSignal.aborted) {
        throw new LiteLLMRequestError(
          "INFERENCE_TIMEOUT",
          `LiteLLM did not complete the response within ${input.timeoutMs} ms.`,
        );
      }
      throw new LiteLLMRequestError("INFERENCE_UNREACHABLE", "LiteLLM could not be reached.");
    }

    if (!response.ok) {
      const code = response.status === 400 && input.guardrails.length > 0
        ? "GUARDRAIL_REJECTED"
        : response.status === 401 || response.status === 403
          ? "INFERENCE_AUTHENTICATION_FAILED"
          : response.status === 429
            ? "INFERENCE_RATE_LIMITED"
            : "INFERENCE_REJECTED";
      throw new LiteLLMRequestError(
        code,
        response.status === 400 && input.guardrails.length > 0
          ? "LiteLLM rejected the guarded request. Review guardrail violation and assignment telemetry."
          : response.status === 429
            ? "LiteLLM is currently at its request limit."
            : response.status === 401 || response.status === 403
              ? "LiteLLM rejected the configured credential."
              : `LiteLLM rejected the request with status ${response.status}.`,
      );
    }
    if (!response.body) {
      throw new LiteLLMRequestError("INFERENCE_EMPTY_STREAM", "LiteLLM returned no response stream.");
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

    const consumeLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        throw new LiteLLMRequestError(
          "INFERENCE_INVALID_STREAM",
          "LiteLLM returned a malformed streaming response.",
        );
      }
      const chunk = parseChunk(parsed);
      if (chunk.delta) {
        content += chunk.delta;
        if (content.length > 1_000_000) {
          throw new LiteLLMRequestError(
            "INFERENCE_RESPONSE_TOO_LARGE",
            "The model response exceeded AIHub's safety limit.",
          );
        }
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
        throw new LiteLLMRequestError(
          "INFERENCE_TIMEOUT",
          `LiteLLM did not complete the response within ${input.timeoutMs} ms.`,
        );
      }
      if (error instanceof LiteLLMRequestError) throw error;
      throw new LiteLLMRequestError(
        "INFERENCE_STREAM_INTERRUPTED",
        "The LiteLLM response stream ended unexpectedly.",
      );
    }
    if (buffer) consumeLine(buffer);
    if (!content) {
      throw new LiteLLMRequestError(
        "INFERENCE_EMPTY_RESPONSE",
        "LiteLLM completed without returning assistant content.",
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
