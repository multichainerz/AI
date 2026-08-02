import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type HermesRuntimeNode,
} from "@orcasynapse/contracts";
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
    installerReadiness: vi.fn(async () => ({
      ready: true,
      dashboardReady: true,
      inferenceReady: true,
      invitationReady: true,
    })),
    createInvitation: vi.fn(async (_principal, input) => ({
      node,
      bundle: {
        format: "orcasynapse-hermes-enrollment/v1" as const,
        nodeId: NODE_ID,
        nodeSlug: node.slug,
        token: "t".repeat(43),
        controlPlaneUrl: input.controlPlaneUrl,
        hermesBaseUrl: input.baseUrl,
        hermesImage: input.hermesImage,
        supermemoryVersion: input.supermemoryVersion,
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })),
    resolveInvitation: vi.fn(async (token) => ({
      format: "orcasynapse-hermes-enrollment/v1" as const,
      nodeId: NODE_ID,
      nodeSlug: node.slug,
      token,
      controlPlaneUrl: "https://orcasynapse.internal",
      hermesBaseUrl: node.baseUrl,
      hermesImage: "nousresearch/hermes-agent:latest",
      supermemoryVersion: "latest",
      expiresAt: "2026-07-30T00:30:00.000Z",
    })),
    enroll: vi.fn(async () => ({
      node: { ...node, hostname: "hermes-01.internal", enrolledAt: NOW, identityFingerprint: "a".repeat(64) },
      heartbeatPath: `/api/v1/runtime-nodes/${NODE_ID}/heartbeat`,
      modelBootstrap: { provider: "custom" as const, baseUrl: "https://orcasynapse.internal/internal/v1", modelAlias: "hermes-agent", apiKey: "g".repeat(64) },
    })),
    heartbeat: vi.fn(async () => ({ accepted: true as const, serverTime: NOW })),
    registerMemory: vi.fn(async () => ({ accepted: true as const, connectionId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb" })),
    mutate: vi.fn(async () => ({ ...node, status: "DRAINING" as const, revision: 1 })),
    remove: vi.fn(async () => undefined),
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
  it("serves the VM2 installer after dashboard and inference readiness so enrollment can resume", async () => {
    const runtimeNodeManager = manager();
    const { app } = await testApp(runtimeNodeManager);
    const ready = await app.inject({ method: "GET", url: "/install/agentic-node.sh" });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.headers["content-type"]).toContain("text/x-shellscript");
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect(ready.headers["content-disposition"]).toBe("inline; filename=install-agentic-node.sh");
    expect(ready.body).toContain("#!/usr/bin/env bash");
    expect(ready.body).toContain("write_file_from_stdin()");
    expect(ready.body).toContain("HERMES_MANAGED_DIR=/opt/data/.orcasynapse-bootstrap-managed");
    expect(ready.body).toContain("allow_lazy_installs: true");
    expect(ready.body).toContain("allow_lazy_installs: false");
    expect(ready.body).toContain("activate_durable_lazy_target");
    expect(ready.body).not.toContain("/dev/stdin");
    expect((await app.inject({ method: "GET", url: "/install/hermes-node.sh" })).statusCode).toBe(404);
    const remover = await app.inject({ method: "GET", url: "/install/remove-agentic-node.sh" });
    expect(remover.statusCode, remover.body).toBe(200);
    expect(remover.headers["content-disposition"]).toBe("inline; filename=remove-agentic-node.sh");
    expect(remover.body).toContain("VM2 SECURE DECOMMISSION");
    expect(remover.body).toContain("Type %bDESTROY%b to continue");
    expect(remover.body).toContain("validate_container_ownership");
    expect(remover.body).toContain('rm -rf --one-file-system -- "${STATE_ROOT}" "${SUPERMEMORY_ROOT}"');
    expect(remover.body).not.toMatch(/docker system prune|apt(?:-get)? remove|rm -rf \/(?:\s|$)/);

    for (const state of [
      { ready: false, dashboardReady: false, inferenceReady: true, invitationReady: true },
      { ready: false, dashboardReady: true, inferenceReady: false, invitationReady: true },
    ] as const) {
      runtimeNodeManager.installerReadiness = vi.fn(async () => state);
      const blocked = await app.inject({ method: "GET", url: "/install/agentic-node.sh" });
      expect(blocked.statusCode).toBe(404);
      expect(blocked.json()).toMatchObject({ error: "AGENTIC_INSTALLER_UNAVAILABLE" });
      expect(blocked.body).not.toContain("#!/usr/bin/env bash");
      expect((await app.inject({ method: "GET", url: "/install/remove-agentic-node.sh" })).statusCode).toBe(200);
    }

    runtimeNodeManager.installerReadiness = vi.fn(async () => ({
      ready: true, dashboardReady: true, inferenceReady: true, invitationReady: false,
    }));
    expect((await app.inject({ method: "GET", url: "/install/agentic-node.sh" })).statusCode).toBe(200);
  });

  it("requires a protected admin session and forwards explicit permanent-removal confirmation", async () => {
    const { app, runtimeNodeManager } = await testApp();
    const payload = {
      confirmation: node.slug,
      reason: "VM2 host purge completed by the platform administrator.",
      expectedRevision: 4,
    };
    expect((await app.inject({ method: "DELETE", url: `/api/v1/admin/runtime-nodes/${NODE_ID}`, payload })).statusCode)
      .toBe(401);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/runtime-nodes/${NODE_ID}`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(runtimeNodeManager.remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      NODE_ID,
      payload,
    );
  });

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
        controlPlaneUrl: "https://orcasynapse.internal",
        hermesImage: "nousresearch/hermes-agent:latest",
        expiresInMinutes: 30,
      },
    });
    expect(invitation.statusCode).toBe(201);
    expect(invitation.json()).toMatchObject({ bundle: { format: "orcasynapse-hermes-enrollment/v1", token: "t".repeat(43) } });
    expect(runtimeNodeManager.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      expect.objectContaining({ slug: node.slug, supermemoryVersion: "0.0.5" }),
    );

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/v1/runtime-nodes/bootstrap",
      payload: { token: "t".repeat(43) },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json()).toMatchObject({ nodeId: NODE_ID, controlPlaneUrl: "https://orcasynapse.internal" });
    expect(runtimeNodeManager.resolveInvitation).toHaveBeenCalledWith("t".repeat(43));

    const enrollment = await app.inject({
      method: "POST",
      url: "/api/v1/runtime-nodes/enroll",
      payload: {
        nodeId: NODE_ID,
        token: "t".repeat(43),
        hostname: "hermes-01.internal",
        publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${"A".repeat(80)}\n-----END PUBLIC KEY-----`,
        controlPlaneUrl: "https://orcasynapse.internal",
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
        "x-orcasynapse-node-timestamp": NOW,
        "x-orcasynapse-node-nonce": "b6b4dc94-bcfc-41c4-bbd2-5d8e3dbc3dac",
        "x-orcasynapse-node-signature": "invalid",
      },
      payload: { observedAt: NOW, status: "ONLINE", hermesVersion: "0.1.0", capabilities: [] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "INVALID_NODE_SIGNATURE" });
  });
});
