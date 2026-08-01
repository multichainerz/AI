import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type HermesRuntimeNode,
} from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { RuntimeNodeAuthenticationError, type HermesRuntimeNodeManager } from "./runtime-node-manager.js";

const TOKEN = "n".repeat(43);
const ADMIN_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const NOW = "2026-07-30T00:00:00.000Z";

const session: AdministratorSession = {
  id: ADMIN_ID, subject: "runtime-admin", role: "PLATFORM_ADMIN", scopes: [...ADMIN_SCOPES],
  createdAt: NOW, idleExpiresAt: "2026-07-30T00:15:00.000Z", absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

const node: HermesRuntimeNode = {
  id: NODE_ID,
  slug: "hermes-runtime-01",
  displayName: "Hermes Runtime 01",
  baseUrl: "http://10.0.0.12:8642",
  expectedHostname: null,
  hostname: null,
  status: "PENDING",
  identityFingerprint: null,
  hermesVersion: null,
  installerVersion: null,
  capabilities: [],
  serviceConnectionId: null,
  serviceConnectionStatus: null,
  lastSeenAt: null,
  enrolledAt: null,
  revokedAt: null,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return true; }
}

function manager(): HermesRuntimeNodeManager {
  return {
    list: vi.fn(async () => [node]),
    createInvitation: vi.fn(async (_principal, input) => ({
      node,
      bundle: {
        format: "aihub-hermes-enrollment/v1" as const,
        nodeId: NODE_ID,
        nodeSlug: node.slug,
        token: "t".repeat(43),
        controlPlaneUrl: input.controlPlaneUrl,
        hermesBaseUrl: input.baseUrl,
        hermesImage: input.hermesImage,
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })),
    enroll: vi.fn(async () => ({
      node: { ...node, hostname: "hermes-01.internal", enrolledAt: NOW, identityFingerprint: "a".repeat(64) },
      heartbeatPath: `/api/v1/runtime-nodes/${NODE_ID}/heartbeat`,
      modelBootstrap: { provider: "custom" as const, baseUrl: "https://aihub.internal/internal/v1", modelAlias: "hermes-agent", apiKey: "g".repeat(64) },
    })),
    heartbeat: vi.fn(async () => ({ accepted: true as const, serverTime: NOW })),
    registerMemory: vi.fn(async () => ({ accepted: true as const, connectionId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb" })),
    mutate: vi.fn(async () => ({ ...node, status: "DRAINING" as const, revision: 1 })),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function testApp(runtimeNodeManager = manager()) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(), runtimeNodeManager },
  });
  apps.push(app);
  return { app, runtimeNodeManager };
}

describe("Hermes runtime-node routes", () => {
  it("protects fleet administration while allowing one-time node enrollment", async () => {
    const { app, runtimeNodeManager } = await testApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/runtime-nodes/" })).statusCode).toBe(401);
    const invitation = await app.inject({
      method: "POST",
      url: "/api/v1/admin/runtime-nodes/invitations",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: {
        slug: "hermes-runtime-01",
        displayName: "Hermes Runtime 01",
        baseUrl: "http://10.0.0.12:8642",
        controlPlaneUrl: "https://aihub.internal",
        hermesImage: "nousresearch/hermes-agent:latest",
        expiresInMinutes: 30,
      },
    });
    expect(invitation.statusCode).toBe(201);
    expect(invitation.json()).toMatchObject({ bundle: { format: "aihub-hermes-enrollment/v1", token: "t".repeat(43) } });
    expect(runtimeNodeManager.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ id: ADMIN_ID }), expect.objectContaining({ slug: node.slug }));

    const enrollment = await app.inject({
      method: "POST",
      url: "/api/v1/runtime-nodes/enroll",
      payload: {
        nodeId: NODE_ID,
        token: "t".repeat(43),
        hostname: "hermes-01.internal",
        publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${"A".repeat(80)}\n-----END PUBLIC KEY-----`,
        controlPlaneUrl: "https://aihub.internal",
        apiKey: "k".repeat(64),
        hermesVersion: "nousresearch/hermes-agent:latest",
        installerVersion: "ai-v1.7.0",
        capabilities: ["gateway-api"],
      },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(runtimeNodeManager.enroll).toHaveBeenCalledWith(expect.objectContaining({ nodeId: NODE_ID }), "127.0.0.1");
  });

  it("maps invalid signed heartbeats to a stable authentication response", async () => {
    const runtimeNodeManager = manager();
    runtimeNodeManager.heartbeat = vi.fn(async () => { throw new RuntimeNodeAuthenticationError(); });
    const { app } = await testApp(runtimeNodeManager);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runtime-nodes/${NODE_ID}/heartbeat`,
      headers: {
        "x-aihub-node-timestamp": NOW,
        "x-aihub-node-nonce": "b6b4dc94-bcfc-41c4-bbd2-5d8e3dbc3dac",
        "x-aihub-node-signature": "invalid",
      },
      payload: { observedAt: NOW, status: "ONLINE", hermesVersion: "0.1.0", capabilities: [] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "INVALID_NODE_SIGNATURE" });
  });
});
