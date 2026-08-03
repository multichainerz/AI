import type { PrismaRuntimeConnectionResolver, RuntimeConnection } from "./connection-resolver.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 64 * 1024;

export type HermesSafeRunEventType =
  | "RUN_STARTED"
  | "MESSAGE_DELTA"
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "SUBAGENT_STARTED"
  | "SUBAGENT_COMPLETED"
  | "APPROVAL_REQUIRED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_CANCELLED";

export interface HermesSafeRunEvent {
  sourceEventId: string | null;
  type: HermesSafeRunEventType;
  delta: string | null;
  preview: string | null;
  errorCode: string | null;
  summary: string | null;
  status: string | null;
  toolName: string | null;
  childSessionId: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  approvalExternalId: string | null;
  approvalCommand: string | null;
  approvalChoices: Array<"ALLOW_ONCE" | "DENY">;
  occurredAt: Date;
}

const SAFE_EVENT_TYPES = new Map<string, HermesSafeRunEventType>([
  ["run.start", "RUN_STARTED"],
  ["run.started", "RUN_STARTED"],
  ["message.delta", "MESSAGE_DELTA"],
  ["tool.start", "TOOL_STARTED"],
  ["tool.started", "TOOL_STARTED"],
  ["hermes.tool.progress", "TOOL_STARTED"],
  ["tool.complete", "TOOL_COMPLETED"],
  ["tool.completed", "TOOL_COMPLETED"],
  ["subagent.start", "SUBAGENT_STARTED"],
  ["subagent.complete", "SUBAGENT_COMPLETED"],
  ["approval.required", "APPROVAL_REQUIRED"],
  ["run.approval_required", "APPROVAL_REQUIRED"],
  ["approval.request", "APPROVAL_REQUIRED"],
  ["run.complete", "RUN_COMPLETED"],
  ["run.completed", "RUN_COMPLETED"],
  ["run.failed", "RUN_FAILED"],
  ["run.cancelled", "RUN_CANCELLED"],
]);

function safeEventText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return sanitized ? sanitized.slice(0, maximum) : null;
}

function safeDelta(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const sanitized = value.replace(/[\u0000\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return sanitized.length === 0 ? null : sanitized.slice(0, 64_000);
}

function safeNonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeNonnegativeInteger(value: unknown): number | null {
  const number = safeNonnegativeNumber(value);
  return number === null ? null : Math.floor(number);
}

function safeApprovalChoices(value: unknown): Array<"ALLOW_ONCE" | "DENY"> {
  if (!Array.isArray(value)) return ["ALLOW_ONCE", "DENY"];
  const normalized = new Set(value.flatMap((choice) => {
    if (typeof choice !== "string") return [];
    const name = choice.trim().toLowerCase();
    if (name === "once" || name === "allow_once" || name === "approve") return ["ALLOW_ONCE" as const];
    if (name === "deny" || name === "denied") return ["DENY" as const];
    return [];
  }));
  if (!normalized.has("DENY")) normalized.add("DENY");
  return [...normalized];
}

function safeRunEvent(eventName: string, sourceEventId: string | null, data: unknown): HermesSafeRunEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const dataEvent = typeof value.event === "string" ? value.event : eventName;
  const type = SAFE_EVENT_TYPES.get(dataEvent.toLowerCase());
  if (!type) return null;
  const usage = value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
    ? value.usage as Record<string, unknown>
    : {};
  const rawTime = value.timestamp ?? value.occurred_at;
  const parsedTime = typeof rawTime === "number"
    ? new Date(rawTime > 10_000_000_000 ? rawTime : rawTime * 1_000)
    : typeof rawTime === "string" ? new Date(rawTime) : new Date();
  const durationMs = safeNonnegativeInteger(value.duration_ms) ?? (() => {
    const seconds = safeNonnegativeNumber(value.duration ?? value.duration_seconds);
    return seconds === null ? null : Math.round(seconds * 1_000);
  })();
  return {
    sourceEventId: safeEventText(sourceEventId ?? value.event_id ?? value.id, 255),
    type,
    delta: type === "MESSAGE_DELTA" ? safeDelta(value.delta) : null,
    preview: safeEventText(value.preview, 1_000),
    errorCode: safeEventText(value.error_code, 80),
    summary: safeEventText(value.summary ?? value.preview ?? value.goal ?? value.task, 1_000),
    status: safeEventText(value.status, 80),
    toolName: safeEventText(value.tool ?? value.tool_name ?? value.name, 160),
    childSessionId: safeEventText(value.child_session_id ?? value.subagent_id ?? value.task_id, 255),
    durationMs,
    inputTokens: safeNonnegativeInteger(value.input_tokens ?? usage.input_tokens),
    outputTokens: safeNonnegativeInteger(value.output_tokens ?? usage.output_tokens),
    reasoningTokens: safeNonnegativeInteger(value.reasoning_tokens ?? usage.reasoning_tokens),
    costUsd: safeNonnegativeNumber(value.cost_usd ?? usage.cost_usd),
    approvalExternalId: type === "APPROVAL_REQUIRED"
      ? safeEventText(value.approval_id ?? value.request_id ?? value.id, 255)
      : null,
    approvalCommand: type === "APPROVAL_REQUIRED" ? safeEventText(value.command, 1_000) : null,
    approvalChoices: type === "APPROVAL_REQUIRED" ? safeApprovalChoices(value.choices) : [],
    occurredAt: Number.isNaN(parsedTime.getTime()) ? new Date() : parsedTime,
  };
}

function stringSetting(connection: RuntimeConnection, name: string, fallback: string): string {
  const value = connection.configuration[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberSetting(connection: RuntimeConnection, name: string, fallback: number): number {
  const value = connection.configuration[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function endpoint(connection: RuntimeConnection, path: string): URL {
  const base = new URL(connection.baseUrl);
  const url = new URL(path, `${connection.baseUrl.replace(/\/+$/, "")}/`);
  if (url.origin !== base.origin) throw new Error("Hermes request paths must remain on the configured origin.");
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Hermes response is too large.");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Hermes response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (size === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Hermes returned invalid JSON.");
  }
}

export interface HermesRunSubmission {
  input: string;
  instructions: string;
  sessionId: string;
  idempotencyKey: string;
  modelAlias: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  memorySessionKey: string;
  governedMcp?: {
    authorization: string;
    expiresAt: Date;
  };
}

export interface HermesRunState {
  id: string;
  status: string;
  output: string | null;
  error: string | null;
  modelAlias: string | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
}

export class HermesClient {
  constructor(
    private readonly resolver: PrismaRuntimeConnectionResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async assertZeroToolBoundary(): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    await this.assertZeroToolBoundaryFor(connection);
  }

  private async assertZeroToolBoundaryFor(connection: RuntimeConnection): Promise<void> {
    const { toolsets } = await this.assertBaseBoundary(connection);
    for (const toolset of toolsets) {
      if (toolset.enabled) {
        throw new Error("Hermes has an enabled toolset; OrcaSynapse requires a zero-tool boundary for this run.");
      }
    }
  }

  async assertGovernedToolBoundary(): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    await this.assertGovernedToolBoundaryFor(connection);
  }

  private async assertGovernedToolBoundaryFor(connection: RuntimeConnection): Promise<void> {
    const { capabilities, toolsets } = await this.assertBaseBoundary(connection);
    const features = capabilities.features as Record<string, unknown>;
    const runtime = capabilities.runtime as Record<string, unknown>;
    if (
      features.private_run_context !== "orcasynapse_mcp_headers_v1" ||
      runtime.private_context_redacted !== true ||
      runtime.private_context_prompt_visible !== false
    ) {
      throw new Error("Hermes does not advertise OrcaSynapse's private, redacted per-run MCP handoff contract.");
    }
    const governedMcpUrl = stringSetting(connection, "governedMcpUrl", "");
    const governedToolsetName = stringSetting(connection, "governedToolsetName", "orcasynapse-governed-tools");
    const gatewayToken = connection.secrets.mcpGatewayToken;
    if (!governedMcpUrl || !gatewayToken?.startsWith("orcasynapse_mcp_")) {
      throw new Error("Hermes governed MCP endpoint or gateway credential is not configured.");
    }
    const enabled = toolsets.filter((toolset) => toolset.enabled);
    if (enabled.length !== 1 || enabled[0]?.name !== governedToolsetName) {
      throw new Error("Hermes must enable exactly the configured OrcaSynapse governed toolset and no other toolset.");
    }
    await this.assertGovernedGateway(connection, governedMcpUrl, gatewayToken);
  }

  private async assertBaseBoundary(connection: RuntimeConnection): Promise<{
    capabilities: Record<string, unknown>;
    toolsets: Array<{ name: string; enabled: boolean }>;
  }> {
    const capabilitiesPath = stringSetting(connection, "capabilitiesPath", "/v1/capabilities");
    const capabilities = await this.request(connection, endpoint(connection, capabilitiesPath), { method: "GET" });
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      throw new Error("Hermes capability discovery returned an invalid response.");
    }
    const value = capabilities as Record<string, unknown>;
    const auth = value.auth && typeof value.auth === "object" ? value.auth as Record<string, unknown> : {};
    const features = value.features && typeof value.features === "object" ? value.features as Record<string, unknown> : {};
    const runtime = value.runtime && typeof value.runtime === "object" ? value.runtime as Record<string, unknown> : {};
    if (
      value.platform !== "hermes-agent" || auth.required !== true ||
      features.run_submission !== true || features.run_status !== true || features.run_events_sse !== true || features.run_stop !== true
    ) {
      throw new Error("Hermes does not expose the required authenticated Runs API boundary.");
    }
    if (
      Object.keys(runtime).length > 0 &&
      (runtime.mode !== "server_agent" || runtime.tool_execution !== "server" || runtime.split_runtime !== false)
    ) {
      throw new Error("Hermes reports an incompatible runtime execution boundary.");
    }

    const toolsetsPath = stringSetting(connection, "toolsetsPath", "/v1/toolsets");
    const toolsetResponse = await this.request(connection, endpoint(connection, toolsetsPath), { method: "GET" });
    const toolsetValues = Array.isArray(toolsetResponse)
      ? toolsetResponse
      : toolsetResponse && typeof toolsetResponse === "object" && !Array.isArray(toolsetResponse) &&
          (toolsetResponse as Record<string, unknown>).platform === "api_server" &&
          Array.isArray((toolsetResponse as Record<string, unknown>).data)
        ? (toolsetResponse as { data: unknown[] }).data
        : null;
    if (!toolsetValues) throw new Error("Hermes toolset discovery returned an invalid API-server response.");
    const toolsets = toolsetValues.map((toolset) => {
      if (
        !toolset || typeof toolset !== "object" || Array.isArray(toolset) ||
        typeof (toolset as { name?: unknown }).name !== "string" ||
        typeof (toolset as { enabled?: unknown }).enabled !== "boolean"
      ) {
        throw new Error("Hermes toolset discovery contained an unrecognized entry; OrcaSynapse denies execution fail-closed.");
      }
      return toolset as { name: string; enabled: boolean };
    });
    return { capabilities: value, toolsets };
  }

  async start(input: HermesRunSubmission): Promise<string> {
    const connection = await this.resolver.resolveOne("HERMES");
    if (input.governedMcp) await this.assertGovernedToolBoundaryFor(connection);
    else await this.assertZeroToolBoundaryFor(connection);
    const runsPath = stringSetting(connection, "runsPath", "/v1/runs");
    const privateContext = input.governedMcp
      ? this.privateMcpContext(connection, input.governedMcp)
      : undefined;
    const body = await this.request(connection, endpoint(connection, runsPath), {
      method: "POST",
      body: JSON.stringify({
        input: input.input,
        instructions: input.instructions,
        session_id: input.sessionId,
        model: input.modelAlias,
        conversation_history: input.conversationHistory,
        ...(privateContext ? { private_context: privateContext } : {}),
      }),
      headers: {
        "idempotency-key": input.idempotencyKey,
        "x-hermes-session-key": input.memorySessionKey,
      },
    });
    const id = body && typeof body === "object" && typeof (body as { run_id?: unknown }).run_id === "string"
      ? (body as { run_id: string }).run_id
      : null;
    if (!id || id.length > 255) throw new Error("Hermes did not return a valid run ID.");
    return id;
  }

  private privateMcpContext(
    connection: RuntimeConnection,
    governedMcp: NonNullable<HermesRunSubmission["governedMcp"]>,
  ): Record<string, unknown> {
    const url = stringSetting(connection, "governedMcpUrl", "");
    const toolset = stringSetting(connection, "governedToolsetName", "orcasynapse-governed-tools");
    const gatewayToken = connection.secrets.mcpGatewayToken;
    if (!url || !gatewayToken?.startsWith("orcasynapse_mcp_")) {
      throw new Error("Hermes governed MCP endpoint or gateway credential is not configured.");
    }
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error("Hermes governed MCP endpoint is invalid.");
    }
    return {
      protocol: "orcasynapse_mcp_headers_v1",
      expires_at: governedMcp.expiresAt.toISOString(),
      mcp: {
        name: toolset,
        url: parsedUrl.toString(),
        headers: {
          authorization: `Bearer ${gatewayToken}`,
          "orcasynapse-run-authorization": governedMcp.authorization,
        },
      },
    };
  }

  private async assertGovernedGateway(
    connection: RuntimeConnection,
    url: string,
    gatewayToken: string,
  ): Promise<void> {
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error("Hermes governed MCP endpoint is invalid.");
    }
    const timeoutMs = Math.min(30_000, Math.max(1_000, numberSetting(connection, "timeoutMs", 8_000)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(parsedUrl, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "orcasynapse-hermes-preflight",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "orcasynapse-hermes-preflight", version: "1" },
          },
        }),
      });
      const body = await boundedJson(response);
      if (!response.ok) throw new Error("OrcaSynapse governed MCP gateway rejected the configured Hermes credential.");
      const result = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).result
        : null;
      const serverInfo = result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>).serverInfo
        : null;
      if (
        !serverInfo || typeof serverInfo !== "object" || Array.isArray(serverInfo) ||
        (serverInfo as Record<string, unknown>).name !== "orcasynapse-governed-tools"
      ) {
        throw new Error("Configured governed MCP endpoint is not the OrcaSynapse tool gateway.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async status(runId: string): Promise<HermesRunState> {
    const connection = await this.resolver.resolveOne("HERMES");
    const runsPath = stringSetting(connection, "runsPath", "/v1/runs").replace(/\/+$/, "");
    const body = await this.request(connection, endpoint(connection, `${runsPath}/${encodeURIComponent(runId)}`), {
      method: "GET",
    });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Hermes run status is invalid.");
    const value = body as Record<string, unknown>;
    const usage = value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
      ? value.usage as Record<string, unknown>
      : {};
    const id = typeof value.run_id === "string" ? value.run_id : runId;
    if (id !== runId || typeof value.status !== "string") throw new Error("Hermes run status did not match the requested run.");
    return {
      id,
      status: value.status.toLowerCase(),
      output: typeof value.output === "string" ? value.output.slice(0, 2_000_000) : null,
      error: typeof value.error === "string" ? value.error.slice(0, 500) : null,
      modelAlias: safeEventText(value.model, 200),
      sessionId: safeEventText(value.session_id, 200),
      inputTokens: safeNonnegativeInteger(value.input_tokens ?? usage.input_tokens),
      outputTokens: safeNonnegativeInteger(value.output_tokens ?? usage.output_tokens),
      reasoningTokens: safeNonnegativeInteger(value.reasoning_tokens ?? usage.reasoning_tokens),
      totalTokens: safeNonnegativeInteger(value.total_tokens ?? usage.total_tokens),
      finishReason: safeEventText(value.finish_reason, 120),
    };
  }

  async decideApproval(runId: string, choice: "once" | "deny"): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    const runsPath = stringSetting(connection, "runsPath", "/v1/runs").replace(/\/+$/, "");
    await this.request(connection, endpoint(connection, `${runsPath}/${encodeURIComponent(runId)}/approval`), {
      method: "POST",
      body: JSON.stringify({ choice }),
    });
  }

  async stop(runId: string): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    const runsPath = stringSetting(connection, "runsPath", "/v1/runs").replace(/\/+$/, "");
    await this.request(connection, endpoint(connection, `${runsPath}/${encodeURIComponent(runId)}/stop`), {
      method: "POST",
      body: "{}",
    });
  }

  async events(
    runId: string,
    onEvent: (event: HermesSafeRunEvent) => Promise<void> | void,
    signal: AbortSignal,
    lastEventId?: string,
  ): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    const runsPath = stringSetting(connection, "runsPath", "/v1/runs").replace(/\/+$/, "");
    const response = await this.fetcher(endpoint(connection, `${runsPath}/${encodeURIComponent(runId)}/events`), {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        accept: "text/event-stream",
        ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
    });
    if (!response.ok) throw new Error(`Hermes rejected the event stream with status ${response.status}.`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      throw new Error("Hermes returned an invalid run event stream content type.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Hermes returned an empty run event stream.");
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingDelta = "";
    let pendingDeltaEvent: HermesSafeRunEvent | null = null;
    let lastDeltaFlushAt = Date.now();
    const flushDelta = async () => {
      if (!pendingDeltaEvent || pendingDelta.length === 0) return;
      await onEvent({ ...pendingDeltaEvent, delta: pendingDelta });
      pendingDelta = "";
      pendingDeltaEvent = null;
      lastDeltaFlushAt = Date.now();
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_EVENT_BYTES) {
          throw new Error("Hermes emitted an oversized run event.");
        }
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary || boundary.index === undefined) break;
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          let eventName = "message";
          let sourceEventId: string | null = null;
          const dataLines: string[] = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("id:")) sourceEventId = line.slice(3).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          let data: unknown;
          try {
            data = JSON.parse(dataLines.join("\n")) as unknown;
          } catch {
            continue;
          }
          const event = safeRunEvent(eventName, sourceEventId, data);
          if (!event) continue;
          if (event.type === "MESSAGE_DELTA" && event.delta) {
            pendingDeltaEvent = event;
            pendingDelta += event.delta;
            if (pendingDelta.length >= 1_024 || Date.now() - lastDeltaFlushAt >= 100) {
              await flushDelta();
            }
            continue;
          }
          await flushDelta();
          await onEvent(event);
        }
      }
      await flushDelta();
    } finally {
      reader.releaseLock();
    }
  }

  async pollIntervalMs(): Promise<number> {
    const connection = await this.resolver.resolveOne("HERMES");
    return Math.min(10_000, Math.max(500, numberSetting(connection, "runPollIntervalMs", 1_000)));
  }

  private async request(connection: RuntimeConnection, url: URL, init: RequestInit): Promise<unknown> {
    const timeoutMs = Math.min(30_000, Math.max(1_000, numberSetting(connection, "timeoutMs", 8_000)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
          ...init.headers,
        },
      });
      const body = await boundedJson(response);
      if (!response.ok) {
        const detail = body && typeof body === "object" && !Array.isArray(body)
          ? safeEventText((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error, 300)
          : null;
        throw new Error(`Hermes rejected the request with status ${response.status}${detail ? `: ${detail}` : ""}.`);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}
