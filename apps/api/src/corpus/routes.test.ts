import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type HermesCorpusEntry,
  type HermesCorpusMutation,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { HermesCorpusManager } from "./corpus-manager.js";

const TOKEN = "c".repeat(43);
const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const ENTRY_ID = "af6cfed8-297e-46e2-8bb7-66e45a18ecbb";
const MUTATION_ID = "3075b357-97ea-4f36-8cda-7ecf00665291";
const PRINCIPAL_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const NOW = "2026-08-14T00:00:00.000Z";
const HASH = "a".repeat(64);

const session: AdministratorSession = {
  id: PRINCIPAL_ID, subject: "corpus-admin", role: "PLATFORM_ADMIN", scopes: [...ADMIN_SCOPES],
  createdAt: NOW, idleExpiresAt: "2026-08-14T00:15:00.000Z", absoluteExpiresAt: "2026-08-14T08:00:00.000Z",
};

const entry: HermesCorpusEntry = {
  id: ENTRY_ID, nodeId: NODE_ID, path: "memories/MEMORY.md", kind: "MEMORY", mediaType: "text/markdown",
  sizeBytes: 14, sha256: HASH, content: "Remember this", structuredEntries: ["Remember this"], readOnly: false,
  revision: 1, observedAt: NOW, deletedAt: null,
};

const mutation: HermesCorpusMutation = {
  id: MUTATION_ID, nodeId: NODE_ID, operation: "MEMORY_REMOVE", path: entry.path,
  expectedHash: HASH, content: null, oldText: "Remember this", reason: "Remove stale memory.",
  status: "PENDING_APPROVAL", requestedBy: PRINCIPAL_ID, requestedBySubject: "corpus-admin",
  approvedBy: null, approvedBySubject: null, beforeHash: HASH, afterHash: null,
  error: null, idempotencyKey: "11a84d43-3b7d-462f-b63d-091425af4cbc", requestedAt: NOW,
  approvedAt: null, dispatchedAt: null, completedAt: null,
};

class Sessions implements AdminSessionManager {
  constructor(private readonly principal: AdministratorSession = session) {}
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? this.principal : null; }
  async revoke() { return true; }
}

function manager(): HermesCorpusManager {
  return {
    overview: vi.fn(async () => ({ nodes: [{
      nodeId: NODE_ID, nodeSlug: "hermes-01", nodeDisplayName: "Hermes 01", available: true, writable: true,
      entryCount: 1, totalBytes: 14, rootHash: HASH, lastSyncedAt: NOW, stale: false,
    }] })),
    entries: vi.fn(async (query) => [query.includeContent ? entry : { ...entry, content: null, structuredEntries: null }]),
    revisions: vi.fn(async () => []),
    mutations: vi.fn(async () => [mutation]),
    createMutation: vi.fn(async () => mutation),
    decideMutation: vi.fn(async () => ({ ...mutation, status: "QUEUED" as const, approvedBy: "b58588b8-537a-4671-9777-f52e3f2ed16a", approvedAt: NOW })),
    uploadSnapshot: vi.fn(async () => ({ accepted: true as const, snapshotId: "8d89ac11-b9c2-4d3f-b151-4d5d508d7146", serverTime: NOW })),
    desiredState: vi.fn(async () => ({ documentBase64: "e30=", signature: "YQ==", publicKeyFingerprint: HASH })),
    completeMutation: vi.fn(async () => ({ accepted: true as const, serverTime: NOW })),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function testApp(corpusManager = manager(), principal: AdministratorSession = session) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(principal), corpusManager },
  });
  apps.push(app);
  return { app, corpusManager };
}

describe("Hermes corpus routes", () => {
  it("protects the repository and exposes mirrored content to scoped administrators", async () => {
    const { app, corpusManager } = await testApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/corpus/overview" })).statusCode).toBe(401);

    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    const overview = await app.inject({ method: "GET", url: "/api/v1/admin/corpus/overview", headers });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json()).toMatchObject({ nodes: [{ nodeId: NODE_ID, available: true }] });

    const files = await app.inject({ method: "GET", url: `/api/v1/admin/corpus/entries?nodeId=${NODE_ID}&q=remember`, headers });
    expect(files.statusCode, files.body).toBe(200);
    expect(files.json()).toMatchObject({ items: [{ path: "memories/MEMORY.md", content: "Remember this" }] });
    expect(corpusManager.entries).toHaveBeenCalledWith(expect.objectContaining({ nodeId: NODE_ID, query: "remember", includeContent: true }));
  });

  it("validates and forwards governed destructive changes", async () => {
    const { app, corpusManager } = await testApp();
    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/corpus/mutations",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}`, "content-type": "application/json" },
      payload: {
        nodeId: NODE_ID, operation: "MEMORY_REMOVE", path: "memories/MEMORY.md", expectedHash: HASH,
        content: null, oldText: "Remember this", reason: "Remove stale memory.",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "PENDING_APPROVAL", operation: "MEMORY_REMOVE" });
    expect(corpusManager.createMutation).toHaveBeenCalledWith(expect.objectContaining({ id: PRINCIPAL_ID }), expect.objectContaining({ expectedHash: HASH }));
  });

  it("allows metadata-only repository reads without granting a content-search side channel", async () => {
    const metadataPrincipal: AdministratorSession = {
      ...session, role: "OPERATIONS_ADMIN", scopes: ["corpus:metadata:read"],
    };
    const { app, corpusManager } = await testApp(manager(), metadataPrincipal);
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    const metadata = await app.inject({
      method: "GET",
      url: `/api/v1/admin/corpus/entries?nodeId=${NODE_ID}&q=memory&includeContent=false`,
      headers,
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.json()).toMatchObject({ items: [{ path: entry.path, content: null, structuredEntries: null }] });
    expect(corpusManager.entries).toHaveBeenCalledWith(expect.objectContaining({ includeContent: false }));
    expect((await app.inject({
      method: "GET", url: `/api/v1/admin/corpus/entries?nodeId=${NODE_ID}&includeContent=true`, headers,
    })).statusCode).toBe(403);
  });

  it("accepts signed VM2 snapshots only through the runtime-node route", async () => {
    const { app, corpusManager } = await testApp();
    const response = await app.inject({
      method: "POST", url: `/api/v1/runtime-nodes/${NODE_ID}/corpus/snapshot`,
      headers: {
        "x-orcasynapse-node-timestamp": NOW,
        "x-orcasynapse-node-nonce": "8089041a-3fa8-4290-ab46-f54788dc3042",
        "x-orcasynapse-node-signature": "signature",
      },
      payload: {
        format: "orcasynapse-hermes-corpus-snapshot/v1", observedAt: NOW, rootHash: HASH,
        entries: [{ path: entry.path, kind: entry.kind, mediaType: entry.mediaType, sizeBytes: String(entry.sizeBytes), sha256: HASH, content: entry.content, structuredEntries: entry.structuredEntries, readOnly: false }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(corpusManager.uploadSnapshot).toHaveBeenCalledWith(
      NODE_ID,
      expect.objectContaining({ signature: "signature" }),
      expect.objectContaining({ rootHash: HASH, entries: [expect.objectContaining({ sizeBytes: "14" })] }),
    );
  });
});
