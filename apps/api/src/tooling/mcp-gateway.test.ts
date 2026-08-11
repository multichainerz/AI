import type { GovernedTool } from "@orcasynapse/contracts";
import { describe, expect, it, vi } from "vitest";
import { McpGateway } from "./mcp-gateway.js";
import { ToolingDeniedError, type ToolingManager } from "./tooling-manager.js";

const tool: GovernedTool = {
  id: "d160a1a0-7218-48a4-8a9f-7e1681280fe4",
  slug: "system_status",
  displayName: "Read system status",
  description: "Read status in owner-only scope.",
  risk: "READ_ONLY",
  status: "ACTIVE",
  handlerKey: "hermes.system_status",
  inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"], additionalProperties: false },
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function manager(): ToolingManager {
  return {
    listTools: vi.fn(async () => ({ items: [tool] })),
    listToolsForRun: vi.fn(async () => ({ items: [tool] })),
    setToolStatus: vi.fn(), listGrants: vi.fn(), upsertGrant: vi.fn(), listCredentials: vi.fn(),
    issueCredential: vi.fn(), revokeCredential: vi.fn(), authenticateGateway: vi.fn(async () => true),
    invoke: vi.fn(async () => ({ callId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d", status: "COMPLETED", data: { service: "inference", healthy: true }, isError: false })),
    recordDeniedInvocation: vi.fn(async () => undefined), listCalls: vi.fn(),
    getRuntimeControl: vi.fn(), updateRuntimeControl: vi.fn(), metrics: vi.fn(),
  } as unknown as ToolingManager;
}

describe("McpGateway", () => {
  const authorization = `${"8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d"}.${"a".repeat(43)}`;

  it("retains the legacy handshake while exposing bounded tool schemas", async () => {
    const gateway = new McpGateway(manager());
    const initialized = await gateway.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    const listed = await gateway.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "legacy", authorization);
    expect(initialized.body).toMatchObject({ result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } } } });
    expect(listed.body).toMatchObject({ result: { tools: [{ name: "system_status", annotations: { readOnlyHint: true } }] } });
    expect(JSON.stringify(listed.body)).not.toContain("_orcasynapseAuthorization");
  });

  it("implements stateless modern discovery and cache-safe list results", async () => {
    const gateway = new McpGateway(manager());
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "hermes", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const discovered = await gateway.handle({
      jsonrpc: "2.0", id: "discover-1", method: "server/discover", params: { _meta: meta },
    }, "modern", authorization);
    const listed = await gateway.handle({
      jsonrpc: "2.0", id: "list-1", method: "tools/list", params: { _meta: meta },
    }, "modern", authorization);

    expect(discovered.body).toMatchObject({ result: {
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25"],
      capabilities: { tools: { listChanged: false } },
      cacheScope: "private",
    } });
    expect(listed.body).toMatchObject({ result: {
      resultType: "complete", ttlMs: 30_000, cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "orcasynapse-governed-tools" } },
    } });
  });

  it("acknowledges JSON-RPC notifications without producing a response body", async () => {
    const gateway = new McpGateway(manager());
    await expect(gateway.handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 4, reason: "client cancelled" },
    })).resolves.toEqual({ status: 202 });
  });

  it("takes run authorization from private transport context, not model arguments", async () => {
    const tooling = manager();
    const gateway = new McpGateway(tooling);
    const response = await gateway.handle({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "system_status", arguments: {
        requestId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
        service: "inference",
      } },
    }, "legacy", authorization);
    expect(tooling.invoke).toHaveBeenCalledWith("system_status", expect.objectContaining({
      arguments: { service: "inference" },
    }));
    expect(response.body).toMatchObject({ result: { isError: false, structuredContent: { status: "COMPLETED" } } });
  });

  it("returns a tool error and records denied attempts without exposing secrets", async () => {
    const tooling = manager();
    tooling.invoke = vi.fn(async () => { throw new ToolingDeniedError("Grant revoked."); });
    const gateway = new McpGateway(tooling);
    const response = await gateway.handle({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "system_status", arguments: {
        requestId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
        service: "inference",
      } },
    }, "legacy", authorization);
    expect(response.body).toMatchObject({ result: { isError: true, structuredContent: { status: "DENIED", message: "Grant revoked." } } });
    expect(tooling.recordDeniedInvocation).toHaveBeenCalledOnce();
  });

  it("denies tool discovery without private run authorization", async () => {
    const response = await new McpGateway(manager()).handle({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    expect(response.body).toMatchObject({ error: { code: -32001 } });
  });
});
