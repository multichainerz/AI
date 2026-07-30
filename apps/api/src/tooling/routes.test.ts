import { ADMIN_SCOPES, type AdministratorSession } from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { ToolingManager } from "./tooling-manager.js";

const SESSION_TOKEN = "s".repeat(43);
const GATEWAY_TOKEN = `aihub_mcp_${"g".repeat(43)}`;
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "platform-admin", role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES], createdAt: "2026-07-30T00:00:00.000Z", idleExpiresAt: "2026-07-30T01:00:00.000Z", absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

class Sessions implements AdminSessionManager {
  async createBootstrapSession() { return null; }
  async authenticate(token: string | undefined) { return token === SESSION_TOKEN ? session : null; }
  async revoke() { return true; }
}

function manager(): ToolingManager {
  return {
    listTools: vi.fn(async () => ({ items: [] })), setToolStatus: vi.fn(), listGrants: vi.fn(async () => ({ items: [] })),
    upsertGrant: vi.fn(), listCredentials: vi.fn(async () => ({ items: [] })), issueCredential: vi.fn(async (_principal, name) => ({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb", name, tokenPrefix: GATEWAY_TOKEN.slice(0, 20), token: GATEWAY_TOKEN,
      enabled: true, lastUsedAt: null, revokedAt: null, createdAt: "2026-07-30T00:00:00.000Z",
    })), revokeCredential: vi.fn(), authenticateGateway: vi.fn(async (token) => token === GATEWAY_TOKEN),
    invoke: vi.fn(), recordDeniedInvocation: vi.fn(), listCalls: vi.fn(async () => ({ items: [] })), listApprovals: vi.fn(async () => ({ items: [] })),
    decideApproval: vi.fn(), getRuntimeControl: vi.fn(async () => ({ enabled: false, reason: "Acceptance pending", approvalTtlMinutes: 15, updatedAt: "2026-07-30T00:00:00.000Z", updatedBy: null })),
    updateRuntimeControl: vi.fn(), metrics: vi.fn(async () => ({
      generatedAt: "2026-07-30T00:00:00.000Z", activeTools: 2, activeGrants: 0,
      pendingApprovals: 0, executingCalls: 0, openActionDispatches: 0, failedActionDispatches: 0,
      completedCalls: 0, deniedCalls: 0, failedCalls: 0,
    })),
  } as unknown as ToolingManager;
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function toolingApp() {
  const toolingManager = manager();
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions(), toolingManager } });
  apps.push(app);
  return { app, toolingManager };
}

describe("governed tooling routes", () => {
  it("protects the administrator registry and one-time credential issuance", async () => {
    const { app } = await toolingApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/tooling/tools" })).statusCode).toBe(401);
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/tooling/tools", headers })).json()).toEqual({ items: [] });
    const issued = await app.inject({ method: "POST", url: "/api/v1/admin/tooling/credentials", headers, payload: { name: "Hermes pilot gateway" } });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({ token: GATEWAY_TOKEN, enabled: true });
  });

  it("requires gateway authentication and rejects browser-origin MCP traffic", async () => {
    const { app } = await toolingApp();
    const payload = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "hermes", version: "1" } } };
    expect((await app.inject({ method: "POST", url: "/api/v1/mcp/", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/mcp/", headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, origin: "https://untrusted.example" }, payload })).statusCode).toBe(403);
    const initialized = await app.inject({ method: "POST", url: "/api/v1/mcp/", headers: { authorization: `Bearer ${GATEWAY_TOKEN}` }, payload });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.headers["mcp-protocol-version"]).toBe("2025-11-25");
    expect(initialized.json()).toMatchObject({ result: { serverInfo: { name: "mpm-aihub-governed-tools" } } });
  });

  it("validates stateless MCP headers against per-request metadata", async () => {
    const { app } = await toolingApp();
    const payload = {
      jsonrpc: "2.0",
      id: "discover-1",
      method: "server/discover",
      params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "hermes", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    };
    const authorization = `Bearer ${GATEWAY_TOKEN}`;
    const mismatched = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/",
      headers: { authorization, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      payload,
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: -32020 } });

    const discovered = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/",
      headers: { authorization, "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
      payload,
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(discovered.json()).toMatchObject({ result: { resultType: "complete", supportedVersions: ["2026-07-28", "2025-11-25"] } });
  });
});
