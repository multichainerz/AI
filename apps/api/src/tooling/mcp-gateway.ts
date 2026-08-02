import type { GovernedTool } from "@orcasynapse/contracts";
import {
  ToolingDeniedError,
  type GovernedToolResult,
  type ToolingManager,
} from "./tooling-manager.js";

export const MCP_MODERN_VERSION = "2026-07-28";
export const MCP_LEGACY_VERSION = "2025-11-25";
const SERVER_INFO = { name: "orcasynapse-governed-tools", version: "0.1.0" } as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpGatewayResponse {
  status: number;
  body?: Record<string, unknown>;
}

export type McpProtocolEra = "modern" | "legacy";

function request(value: unknown): JsonRpcRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") return null;
  if (candidate.id !== undefined && candidate.id !== null && typeof candidate.id !== "string" && typeof candidate.id !== "number") return null;
  if (candidate.params !== undefined && (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params))) return null;
  return candidate as unknown as JsonRpcRequest;
}

function error(id: JsonRpcRequest["id"], code: number, message: string): McpGatewayResponse {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

function resultMeta(): Record<string, unknown> {
  return { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
}

function modernMetadata(message: JsonRpcRequest): boolean {
  const meta = message.params?._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const values = meta as Record<string, unknown>;
  const capabilities = values["io.modelcontextprotocol/clientCapabilities"];
  return values["io.modelcontextprotocol/protocolVersion"] === MCP_MODERN_VERSION
    && !!capabilities
    && typeof capabilities === "object"
    && !Array.isArray(capabilities);
}

function requestedProtocol(message: JsonRpcRequest): unknown {
  const meta = message.params?._meta;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"]
    : undefined;
}

function toolSchema(tool: GovernedTool): Record<string, unknown> {
  const stored = tool.inputSchema;
  const properties = stored.properties && typeof stored.properties === "object" && !Array.isArray(stored.properties)
    ? stored.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(stored.required) ? stored.required.filter((item): item is string => typeof item === "string") : [];
  return {
    type: "object",
    properties: {
      requestId: {
        type: "string",
        format: "uuid",
        description: "A new UUID for this logical invocation. Reuse it only when retrying the same invocation.",
      },
      ...properties,
    },
    required: ["requestId", ...required],
    additionalProperties: false,
  };
}

function resultBody(id: JsonRpcRequest["id"], result: GovernedToolResult): McpGatewayResponse {
  const structuredContent = { callId: result.callId, status: result.status, ...result.data };
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id: id ?? null,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: JSON.stringify(structuredContent).slice(0, 100_000) }],
        structuredContent,
        isError: result.isError,
        _meta: resultMeta(),
      },
    },
  };
}

export class McpGateway {
  constructor(private readonly manager: ToolingManager) {}

  async handle(
    value: unknown,
    era: McpProtocolEra = "legacy",
    runAuthorization?: string,
  ): Promise<McpGatewayResponse> {
    const message = request(value);
    if (!message) return error(null, -32600, "Invalid JSON-RPC request.");
    if (message.id === undefined) return { status: 202 };

    if (era === "modern" && !modernMetadata(message)) {
      const requested = requestedProtocol(message);
      const unsupportedVersion = requested !== MCP_MODERN_VERSION;
      return {
        status: 400,
        body: {
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: {
            code: unsupportedVersion ? -32022 : -32021,
            message: unsupportedVersion
              ? "Unsupported or missing per-request protocol version."
              : "Required client capabilities are missing from per-request metadata.",
            ...(unsupportedVersion ? { data: { supported: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION], requested: requested ?? null } } : {}),
          },
        },
      };
    }

    if (message.method === "server/discover") {
      if (era !== "modern") return error(message.id, -32601, "Method 'server/discover' requires modern MCP metadata.");
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            resultType: "complete",
            supportedVersions: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION],
            capabilities: { tools: { listChanged: false } },
            instructions: "Every tool call is re-authorized by OrcaSynapse. Consequential actions enter the human approval inbox.",
            ttlMs: 60_000,
            cacheScope: "private",
            _meta: resultMeta(),
          },
        },
      };
    }

    if (message.method === "initialize") {
      if (era === "modern") return { ...error(message.id, -32601, "The modern MCP protocol does not use initialize."), status: 404 };
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            protocolVersion: MCP_LEGACY_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: "Every tool call is re-authorized by OrcaSynapse. Consequential actions enter the human approval inbox.",
          },
        },
      };
    }

    if (message.method === "tools/list") {
      if (!runAuthorization) return error(message.id, -32001, "Private run authorization is required for tool discovery.");
      let governed;
      try {
        governed = await this.manager.listToolsForRun(runAuthorization);
      } catch (cause) {
        if (cause instanceof ToolingDeniedError) return error(message.id, -32001, cause.message);
        throw cause;
      }
      const tools = governed.items.filter(({ status }) => status === "ACTIVE").map((tool) => ({
        name: tool.slug,
        title: tool.displayName,
        description: `${tool.description} Risk: ${tool.risk === "CONSEQUENTIAL" ? "human approval required" : "read-only"}.`,
        inputSchema: toolSchema(tool),
        annotations: {
          readOnlyHint: tool.risk === "READ_ONLY",
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }));
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            resultType: "complete",
            tools,
            ttlMs: 30_000,
            cacheScope: "private",
            _meta: resultMeta(),
          },
        },
      };
    }

    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments;
      if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
        return error(message.id, -32602, "Tool name and object arguments are required.");
      }
      const allArguments = args as Record<string, unknown>;
      const requestId = allArguments.requestId;
      if (typeof runAuthorization !== "string" || typeof requestId !== "string") {
        return error(message.id, -32602, "Private run authorization and requestId are required.");
      }
      const businessArguments = Object.fromEntries(Object.entries(allArguments).filter(([key]) => key !== "requestId"));
      try {
        return resultBody(message.id, await this.manager.invoke(name, { authorization: runAuthorization, requestId, arguments: businessArguments }));
      } catch (cause) {
        if (cause instanceof ToolingDeniedError) {
          await this.manager.recordDeniedInvocation(name, { authorization: runAuthorization, requestId, arguments: businessArguments }, cause.message);
          return resultBody(message.id, { callId: "00000000-0000-4000-8000-000000000000", status: "DENIED", data: { message: cause.message }, isError: true });
        }
        throw cause;
      }
    }

    const unsupported = error(message.id, -32601, `Method '${message.method}' is not supported.`);
    return era === "modern" ? { ...unsupported, status: 404 } : unsupported;
  }
}
