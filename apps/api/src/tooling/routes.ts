import {
  gatewayCredentialListSchema,
  governedToolListSchema,
  issueGatewayCredentialSchema,
  issuedGatewayCredentialSchema,
  decideToolApprovalSchema,
  decideToolsetAdmissionSchema,
  toolApprovalListSchema,
  toolCallListSchema,
  toolGrantListSchema,
  toolGrantSchema,
  toolMetricsSchema,
  toolRuntimeControlSchema,
  toolsetAdmissionListSchema,
  toolsetAdmissionSchema,
  updateToolRuntimeControlSchema,
  updateToolStatusSchema,
  upsertToolGrantSchema,
  type AdminScope,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminSessionToken, type AdminSessionManager } from "../auth/admin-session.js";
import {
  MCP_LEGACY_VERSION,
  MCP_MODERN_VERSION,
  McpGateway,
  type McpProtocolEra,
} from "./mcp-gateway.js";
import {
  ToolingConflictError,
  ToolingDeniedError,
  ToolingNotFoundError,
  type ToolingManager,
  type ToolingPrincipal,
} from "./tooling-manager.js";

export interface ToolingRouteOptions {
  sessionManager?: AdminSessionManager;
  manager?: ToolingManager;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requestHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function decodeMcpHeaderValue(value: string | undefined): string | undefined {
  const prefix = "=?base64?";
  if (!value?.startsWith(prefix) || !value.endsWith("?=")) return value;
  try {
    const encoded = value.slice(prefix.length, -2);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
    const bytes = Buffer.from(encoded, "base64");
    const decoded = bytes.toString("utf8");
    return decoded.includes("\uFFFD") || bytes.toString("base64") !== encoded ? undefined : decoded;
  } catch {
    return undefined;
  }
}

async function sendTransportError(
  reply: FastifyReply,
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await reply.code(400).send({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: { code, message, ...(data ? { data } : {}) },
  });
}

async function validateMcpTransport(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<McpProtocolEra | null> {
  const body = object(request.body);
  const params = object(body?.params);
  const meta = object(params?._meta);
  const bodyVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const protocolHeader = requestHeader(request, "mcp-protocol-version");
  const methodHeader = requestHeader(request, "mcp-method");
  const method = body?.method;
  const modern = method === "server/discover" || typeof bodyVersion === "string" || methodHeader !== undefined;
  if (!modern) return "legacy";

  if (protocolHeader !== MCP_MODERN_VERSION || bodyVersion !== MCP_MODERN_VERSION) {
    if (typeof bodyVersion === "string" && bodyVersion !== MCP_MODERN_VERSION) {
      await sendTransportError(reply, body?.id, -32022, "Unsupported protocol version.", {
        supported: [MCP_MODERN_VERSION, MCP_LEGACY_VERSION],
        requested: bodyVersion,
      });
    } else {
      await sendTransportError(reply, body?.id, -32020, "MCP-Protocol-Version header and body metadata must match.");
    }
    return null;
  }
  if (typeof method !== "string" || methodHeader !== method) {
    await sendTransportError(reply, body?.id, -32020, "Mcp-Method header must match the JSON-RPC method.");
    return null;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const headerName = decodeMcpHeaderValue(requestHeader(request, "mcp-name"));
    if (typeof name !== "string" || headerName !== name) {
      await sendTransportError(reply, body?.id, -32020, "Mcp-Name header must match the requested tool name.");
      return null;
    }
  }
  return "modern";
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, options: ToolingRouteOptions, scope: AdminScope): Promise<ToolingPrincipal | null> {
  const administrator = await options.sessionManager?.authenticate(adminSessionToken(request), scope);
  if (administrator) return { id: administrator.id, subject: administrator.subject };
  if (!options.sessionManager) {
    await reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Tooling identity services are not ready." });
    return null;
  }
  await reply.code(401).send({ error: "UNAUTHORIZED", message: "A scoped administrator session is required." });
  return null;
}

function managerOrLocked(options: ToolingRouteOptions, reply: FastifyReply): ToolingManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Governed tooling services are not ready." });
  return null;
}

async function sendToolingError(reply: FastifyReply, cause: unknown): Promise<void> {
  if (cause instanceof ToolingNotFoundError) {
    await reply.code(404).send({ error: "TOOLING_NOT_FOUND", message: cause.message });
    return;
  }
  if (cause instanceof ToolingConflictError) {
    await reply.code(409).send({ error: "TOOLING_CONFLICT", message: cause.message });
    return;
  }
  if (cause instanceof ToolingDeniedError) {
    await reply.code(423).send({ error: "TOOLING_DENIED", message: cause.message });
    return;
  }
  throw cause;
}

export async function registerMcpGatewayRoutes(app: FastifyInstance, options: ToolingRouteOptions): Promise<void> {
  const gateway = options.manager ? new McpGateway(options.manager) : null;
  app.get("/", async (_request, reply) => reply.code(405).header("allow", "POST").send());
  app.delete("/", async (_request, reply) => reply.code(405).header("allow", "POST").send());
  app.post("/", async (request, reply) => {
    if (!gateway || !options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "The MCP gateway is not ready." });
    if (request.headers.origin) return reply.code(403).send({ error: "ORIGIN_DENIED", message: "Browser-origin MCP requests are not accepted." });
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!(await options.manager.authenticateGateway(token))) {
      return reply.code(401).header("www-authenticate", "Bearer").send({ error: "UNAUTHORIZED", message: "A valid OrcaSynapse MCP gateway credential is required." });
    }
    const era = await validateMcpTransport(request, reply);
    if (!era) return;
    const runAuthorizationHeader = request.headers["orcasynapse-run-authorization"];
    const runAuthorization = typeof runAuthorizationHeader === "string" ? runAuthorizationHeader : undefined;
    const response = await gateway.handle(request.body, era, runAuthorization);
    reply.code(response.status).header("mcp-protocol-version", era === "modern" ? MCP_MODERN_VERSION : MCP_LEGACY_VERSION);
    return response.body ? reply.send(response.body) : reply.send();
  });
}

export async function registerAdminToolingRoutes(app: FastifyInstance, options: ToolingRouteOptions): Promise<void> {
  app.get("/tools", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return governedToolListSchema.parse(await manager.listTools());
  });

  app.patch("/tools/:toolId", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:manage");
    const manager = managerOrLocked(options, reply);
    const toolId = uuid((request.params as Record<string, unknown>).toolId);
    const input = updateToolStatusSchema.safeParse(request.body);
    if (!principal || !manager) return;
    if (!toolId || !input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: toolId ? input.error?.issues[0]?.message : "Tool ID is invalid." });
    try { await manager.setToolStatus(principal, toolId, input.data.status); return reply.code(204).send(); }
    catch (cause) { await sendToolingError(reply, cause); }
  });

  app.get("/grants", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return toolGrantListSchema.parse(await manager.listGrants());
  });

  app.put("/grants", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:manage");
    const manager = managerOrLocked(options, reply);
    const input = upsertToolGrantSchema.safeParse(request.body);
    if (!principal || !manager) return;
    if (!input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    try { return toolGrantSchema.parse(await manager.upsertGrant(principal, input.data)); }
    catch (cause) { await sendToolingError(reply, cause); }
  });

  app.get("/credentials", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return gatewayCredentialListSchema.parse(await manager.listCredentials());
  });

  app.post("/credentials", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:manage");
    const manager = managerOrLocked(options, reply);
    const input = issueGatewayCredentialSchema.safeParse(request.body);
    if (!principal || !manager) return;
    if (!input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    return reply.code(201).send(issuedGatewayCredentialSchema.parse(await manager.issueCredential(principal, input.data.name)));
  });

  app.delete("/credentials/:credentialId", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:manage");
    const manager = managerOrLocked(options, reply);
    const credentialId = uuid((request.params as Record<string, unknown>).credentialId);
    if (!principal || !manager) return;
    if (!credentialId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Credential ID is invalid." });
    try { await manager.revokeCredential(principal, credentialId); return reply.code(204).send(); }
    catch (cause) { await sendToolingError(reply, cause); }
  });

  app.get("/approvals", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    void reply.header("cache-control", "no-store");
    return toolApprovalListSchema.parse(await manager.listPendingApprovals());
  });

  app.post<{ Params: { approvalId: string } }>("/approvals/:approvalId/decision", async (request, reply) => {
    // tools:manage, not tools:read: approving a consequential call is the act
    // the whole approval boundary exists to gate.
    const principal = await requireAdmin(request, reply, options, "tools:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const input = decideToolApprovalSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_TOOL_DECISION", message: input.error.issues[0]?.message });
    }
    try {
      await manager.decideApproval(principal, request.params.approvalId, input.data.decision === "APPROVE", input.data.reason);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof ToolingConflictError) {
        return reply.code(409).send({ error: "TOOL_APPROVAL_CONFLICT", message: error.message });
      }
      throw error;
    }
  });

  app.get("/calls", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return toolCallListSchema.parse(await manager.listCalls());
  });

  app.get("/toolsets", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return toolsetAdmissionListSchema.parse(await manager.listToolsetAdmissions());
  });

  app.put<{ Params: { toolsetName: string } }>("/toolsets/:toolsetName", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const name = request.params.toolsetName.trim();
    if (name.length < 1 || name.length > 120) {
      return reply.code(400).send({ error: "INVALID_TOOLSET", message: "The toolset name is not a valid identifier." });
    }
    const input = decideToolsetAdmissionSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_TOOLSET_DECISION", message: input.error.issues[0]?.message });
    }
    try {
      return toolsetAdmissionSchema.parse(await manager.decideToolsetAdmission(principal, name, input.data));
    } catch (error) {
      if (error instanceof ToolingConflictError) {
        return reply.code(409).send({ error: "TOOLSET_ADMISSION_CONFLICT", message: error.message });
      }
      throw error;
    }
  });

  app.get("/runtime", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return toolRuntimeControlSchema.parse(await manager.getRuntimeControl());
  });

  app.patch("/runtime", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:manage");
    const manager = managerOrLocked(options, reply);
    const input = updateToolRuntimeControlSchema.safeParse(request.body);
    if (!principal || !manager) return;
    if (!input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    try { return toolRuntimeControlSchema.parse(await manager.updateRuntimeControl(principal, input.data)); }
    catch (cause) { await sendToolingError(reply, cause); }
  });

  app.get("/metrics", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, "tools:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return toolMetricsSchema.parse(await manager.metrics());
  });
}
