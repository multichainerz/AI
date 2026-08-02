import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type MemoryMetrics,
  type MemoryPublicationList,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { MemoryPublicationConflictError, type MemoryManager } from "./memory-manager.js";

const SESSION_TOKEN = "m".repeat(43);
const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const principal: AdministratorSession = {
  id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
  subject: "memory-operator",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T00:15:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

class SessionManager implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined, scope?: string) {
    return token === SESSION_TOKEN && (!scope || principal.scopes.includes(scope as never)) ? principal : null;
  }
  async revoke() { return true; }
}

function manager(): MemoryManager {
  return {
    list: vi.fn(async (): Promise<MemoryPublicationList> => ({ items: [{
      documentId: DOCUMENT_ID,
      fileName: "policy.pdf",
      classification: "CONFIDENTIAL",
      generation: 1,
      status: "READY",
      externalDocumentId: "sm-document-1",
      failureCode: null,
      failureMessage: null,
      retryable: false,
      queuedAt: "2026-07-30T00:00:00.000Z",
      syncedAt: "2026-07-30T00:01:00.000Z",
      updatedAt: "2026-07-30T00:01:00.000Z",
    }] })),
    metrics: vi.fn(async (): Promise<MemoryMetrics> => ({
      generatedAt: "2026-07-30T00:01:00.000Z",
      total: 1,
      queued: 0,
      processing: 0,
      ready: 1,
      failed: 0,
      deletePending: 0,
    })),
    reindex: vi.fn(async () => undefined),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function memoryApp(memoryManager: MemoryManager = manager()) {
  const app = await createApp({
    logger: false,
    runtime: {
      bootstrapState: "READY",
      sessionManager: new SessionManager(),
      memoryManager,
    },
  });
  apps.push(app);
  return app;
}

describe("administrator memory routes", () => {
  it("fails closed without a scoped administrator session", async () => {
    const app = await memoryApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/memory/publications" })).statusCode).toBe(401);
  });

  it("returns bounded publication state and metrics", async () => {
    const app = await memoryApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };
    const publications = await app.inject({ method: "GET", url: "/api/v1/admin/memory/publications", headers });
    const metrics = await app.inject({ method: "GET", url: "/api/v1/admin/memory/metrics", headers });
    expect(publications.statusCode).toBe(200);
    expect(publications.json()).toMatchObject({ items: [{ documentId: DOCUMENT_ID, status: "READY" }] });
    expect(metrics.json()).toMatchObject({ total: 1, ready: 1 });
  });

  it("validates identifiers and maps synchronization conflicts", async () => {
    const memoryManager = manager();
    vi.mocked(memoryManager.reindex).mockRejectedValueOnce(new MemoryPublicationConflictError("Not eligible."));
    const app = await memoryApp(memoryManager);
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };
    const invalid = await app.inject({ method: "POST", url: "/api/v1/admin/memory/documents/not-a-uuid/reindex", headers });
    const conflict = await app.inject({ method: "POST", url: `/api/v1/admin/memory/documents/${DOCUMENT_ID}/reindex`, headers });
    expect(invalid.statusCode).toBe(400);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "MEMORY_CONFLICT" });
  });
});
