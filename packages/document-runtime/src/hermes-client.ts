import type { PrismaRuntimeConnectionResolver, RuntimeConnection } from "./connection-resolver.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

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
  modelAlias: string;
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
        throw new Error("Hermes has an enabled toolset; AIHub requires a zero-tool boundary for this run.");
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
      features.private_run_context !== "aihub_mcp_headers_v1" ||
      runtime.private_context_redacted !== true ||
      runtime.private_context_prompt_visible !== false
    ) {
      throw new Error("Hermes does not advertise AIHub's private, redacted per-run MCP handoff contract.");
    }
    const governedMcpUrl = stringSetting(connection, "governedMcpUrl", "");
    const governedToolsetName = stringSetting(connection, "governedToolsetName", "aihub-governed-tools");
    const gatewayToken = connection.secrets.mcpGatewayToken;
    if (!governedMcpUrl || !gatewayToken?.startsWith("aihub_mcp_")) {
      throw new Error("Hermes governed MCP endpoint or gateway credential is not configured.");
    }
    const enabled = toolsets.filter((toolset) => toolset.enabled);
    if (enabled.length !== 1 || enabled[0]?.name !== governedToolsetName) {
      throw new Error("Hermes must enable exactly the configured AIHub governed toolset and no other toolset.");
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
      features.run_submission !== true || features.run_status !== true || features.run_stop !== true ||
      runtime.mode !== "server_agent" || runtime.tool_execution !== "server" || runtime.split_runtime !== false
    ) {
      throw new Error("Hermes does not expose the required authenticated Runs API boundary.");
    }

    const toolsetsPath = stringSetting(connection, "toolsetsPath", "/v1/toolsets");
    const toolsetResponse = await this.request(connection, endpoint(connection, toolsetsPath), { method: "GET" });
    if (!toolsetResponse || typeof toolsetResponse !== "object" || Array.isArray(toolsetResponse)) {
      throw new Error("Hermes toolset discovery returned an invalid response.");
    }
    const toolsetEnvelope = toolsetResponse as Record<string, unknown>;
    if (toolsetEnvelope.platform !== "api_server" || !Array.isArray(toolsetEnvelope.data)) {
      throw new Error("Hermes toolset discovery did not describe the API-server surface.");
    }
    const toolsets = toolsetEnvelope.data.map((toolset) => {
      if (
        !toolset || typeof toolset !== "object" || Array.isArray(toolset) ||
        typeof (toolset as { name?: unknown }).name !== "string" ||
        typeof (toolset as { enabled?: unknown }).enabled !== "boolean"
      ) {
        throw new Error("Hermes toolset discovery contained an unrecognized entry; AIHub denies execution fail-closed.");
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
        ...(privateContext ? { private_context: privateContext } : {}),
      }),
      headers: { "idempotency-key": input.sessionId },
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
    const toolset = stringSetting(connection, "governedToolsetName", "aihub-governed-tools");
    const gatewayToken = connection.secrets.mcpGatewayToken;
    if (!url || !gatewayToken?.startsWith("aihub_mcp_")) {
      throw new Error("Hermes governed MCP endpoint or gateway credential is not configured.");
    }
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error("Hermes governed MCP endpoint is invalid.");
    }
    return {
      protocol: "aihub_mcp_headers_v1",
      expires_at: governedMcp.expiresAt.toISOString(),
      mcp: {
        name: toolset,
        url: parsedUrl.toString(),
        headers: {
          authorization: `Bearer ${gatewayToken}`,
          "aihub-run-authorization": governedMcp.authorization,
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
          id: "aihub-hermes-preflight",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "aihub-hermes-preflight", version: "1" },
          },
        }),
      });
      const body = await boundedJson(response);
      if (!response.ok) throw new Error("AIHub governed MCP gateway rejected the configured Hermes credential.");
      const result = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).result
        : null;
      const serverInfo = result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>).serverInfo
        : null;
      if (
        !serverInfo || typeof serverInfo !== "object" || Array.isArray(serverInfo) ||
        (serverInfo as Record<string, unknown>).name !== "mpm-aihub-governed-tools"
      ) {
        throw new Error("Configured governed MCP endpoint is not the AIHub tool gateway.");
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
    const id = typeof value.run_id === "string" ? value.run_id : runId;
    if (id !== runId || typeof value.status !== "string") throw new Error("Hermes run status did not match the requested run.");
    return {
      id,
      status: value.status.toLowerCase(),
      output: typeof value.output === "string" ? value.output.slice(0, 2_000_000) : null,
      error: typeof value.error === "string" ? value.error.slice(0, 500) : null,
    };
  }

  async stop(runId: string): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    const runsPath = stringSetting(connection, "runsPath", "/v1/runs").replace(/\/+$/, "");
    await this.request(connection, endpoint(connection, `${runsPath}/${encodeURIComponent(runId)}/stop`), {
      method: "POST",
      body: "{}",
    });
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
      if (!response.ok) throw new Error(`Hermes rejected the request with status ${response.status}.`);
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}
