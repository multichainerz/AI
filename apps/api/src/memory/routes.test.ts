import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type AgentMemoryRecord,
  type MemoryPolicy,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { AgentMemoryNotFoundError, type MemoryManager } from "./memory-manager.js";

const TOKEN = "a".repeat(43);
const READER_TOKEN = "b".repeat(43);
const POLICY_ID = "1f7f2e0a-7a94-4a2f-9a67-8b5f7f1f1d21";
const MEMORY_ID = "2c4d6e80-1b3a-4c5d-8e9f-0a1b2c3d4e5f";

const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "security-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-08-01T00:00:00.000Z",
  idleExpiresAt: "2026-08-01T01:00:00.000Z",
  absoluteExpiresAt: "2026-08-01T08:00:00.000Z",
};

/** An auditor may look at what agents remember, but never change or delete it. */
const auditor: AdministratorSession = {
  ...session,
  id: "b1d8a1a4-5a4c-4b2f-9d0e-6c7b8a9f0e11",
  subject: "auditor",
  role: "AUDITOR",
  scopes: ["memory:read", "audit:read"],
};

const policy: MemoryPolicy = {
  id: POLICY_ID,
  slug: "default-memory",
  displayName: "Default memory policy",
  description: "Bounds what every agent may remember.",
  status: "ACTIVE",
  maximumCaptureMode: "LEARN_USER",
  retentionDays: 365,
  maximumItemsPerOwner: 500,
  recallLimit: 6,
  recallMinimumScore: 0.4,
  revision: 2,
  firstActivatedAt: "2026-08-01T00:00:00.000Z",
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const record: AgentMemoryRecord = {
  id: MEMORY_ID,
  ownerSubject: "user:ada",
  agentProfileId: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b",
  agentProfileSlug: "assistant",
  content: "Prefers concise answers.",
  sourceRunId: null,
  retentionUntil: "2027-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) {
    if (token === TOKEN) return session;
    return token === READER_TOKEN ? auditor : null;
  }
  async revoke() { return false; }
}

function manager(): MemoryManager {
  return {
    list: vi.fn(async () => ({ items: [policy] })),
    create: vi.fn(async () => ({ ...policy, status: "DRAFT" as const, revision: 1, firstActivatedAt: null })),
    update: vi.fn(async () => policy),
    activate: vi.fn(async () => policy),
    suspend: vi.fn(async () => ({ ...policy, status: "SUSPENDED" as const })),
    records: vi.fn(async () => ({ items: [record] })),
    recordsForOwner: vi.fn(async () => ({ items: [record] })),
    forget: vi.fn(async () => undefined),
    purge: vi.fn(async () => 3),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function memoryApp(memoryManager = manager()) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(), memoryManager },
  });
  apps.push(app);
  return { app, memoryManager };
}

const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
const readerHeaders = { cookie: `${ADMIN_SESSION_COOKIE}=${READER_TOKEN}` };

describe("memory policy routes", () => {
  it("requires an authenticated reader", async () => {
    const { app } = await memoryApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/memory/policies" })).statusCode).toBe(401);
  });

  it("lists policies and validates decisions before the manager sees them", async () => {
    const { app, memoryManager } = await memoryApp();

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/memory/policies", headers })).json())
      .toMatchObject({ items: [{ slug: "default-memory", maximumCaptureMode: "LEARN_USER" }] });

    const short = await app.inject({
      method: "POST",
      url: `/api/v1/admin/memory/policies/${POLICY_ID}/suspend`,
      headers,
      payload: { expectedRevision: 2, reason: "x" },
    });
    expect(short.statusCode).toBe(400);
    expect(memoryManager.suspend).not.toHaveBeenCalled();

    const suspended = await app.inject({
      method: "POST",
      url: `/api/v1/admin/memory/policies/${POLICY_ID}/suspend`,
      headers,
      payload: { expectedRevision: 2, reason: "Tightening retention." },
    });
    expect(suspended.json()).toMatchObject({ status: "SUSPENDED" });
    expect(memoryManager.suspend).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }),
      POLICY_ID,
      expect.objectContaining({ reason: "Tightening retention." }),
    );
  });

  it("rejects a policy whose retention is outside the contract", async () => {
    const { app, memoryManager } = await memoryApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/memory/policies",
      headers,
      payload: {
        slug: "forever", displayName: "Forever", description: "Keeps everything.",
        maximumCaptureMode: "LEARN_EXCHANGE", retentionDays: 0,
        maximumItemsPerOwner: 500, recallLimit: 6, recallMinimumScore: 0.4,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(memoryManager.create).not.toHaveBeenCalled();
  });
});

describe("memory record routes", () => {
  it("lets a reader inspect stored memory but never delete it", async () => {
    const { app, memoryManager } = await memoryApp();

    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/memory/records?ownerSubject=user:ada", headers: readerHeaders });
    expect(listed.json()).toMatchObject({ items: [{ ownerSubject: "user:ada" }] });
    // Remembered content must not sit in a shared cache.
    expect(listed.headers["cache-control"]).toBe("no-store");

    const denied = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/memory/records/${MEMORY_ID}`,
      headers: readerHeaders,
      payload: { reason: "Asked to be forgotten." },
    });
    expect(denied.statusCode).toBe(403);
    expect(memoryManager.forget).not.toHaveBeenCalled();
  });

  it("requires a reason for every deletion and purge", async () => {
    const { app, memoryManager } = await memoryApp();

    expect((await app.inject({ method: "DELETE", url: `/api/v1/admin/memory/records/${MEMORY_ID}`, headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/memory/records/purge", headers, payload: { ownerSubject: "user:ada" } })).statusCode).toBe(400);
    expect(memoryManager.forget).not.toHaveBeenCalled();
    expect(memoryManager.purge).not.toHaveBeenCalled();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/memory/records/${MEMORY_ID}`,
      headers,
      payload: { reason: "Retention exception approved." },
    });
    expect(deleted.statusCode).toBe(204);

    const purged = await app.inject({
      method: "POST",
      url: "/api/v1/admin/memory/records/purge",
      headers,
      payload: { ownerSubject: "user:ada", reason: "Employee offboarded." },
    });
    expect(purged.json()).toEqual({ removed: 3 });
  });

  it("reports a missing memory as 404 rather than a server error", async () => {
    const memoryManager = manager();
    memoryManager.forget = vi.fn(async () => {
      throw new AgentMemoryNotFoundError("That memory does not exist.");
    });
    const { app } = await memoryApp(memoryManager);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/memory/records/${MEMORY_ID}`,
      headers,
      payload: { reason: "Retention exception approved." },
    });
    expect(response.statusCode).toBe(404);
  });

  it("locks the surface when memory services are not ready", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions() } });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/memory/policies", headers })).statusCode).toBe(423);
  });
});
