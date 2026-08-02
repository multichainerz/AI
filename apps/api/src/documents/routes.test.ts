import { ADMIN_SCOPES, type DocumentDetail } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminPrincipal, type AdminSessionManager } from "../auth/admin-session.js";
import {
  ENTERPRISE_SESSION_COOKIE,
  type EnterpriseIdentityManager,
} from "../identity/enterprise-session.js";
import type { DocumentManager } from "./document-manager.js";

const SESSION_TOKEN = "s".repeat(43);
const ENTERPRISE_TOKEN = "u".repeat(43);
const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

const admin: AdminPrincipal = {
  id: SESSION_ID,
  subject: "installation-key-administrator",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T00:15:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

const detail: DocumentDetail = {
  id: DOCUMENT_ID,
  fileName: "policy.txt",
  mediaType: "text/plain",
  sizeBytes: 1024,
  sha256: "a".repeat(64),
  classification: "CONFIDENTIAL",
  status: "QUARANTINED",
  pageCount: null,
  processingGeneration: 0,
  failureCode: null,
  failureMessage: null,
  stagingExpiresAt: "2026-07-31T00:00:00.000Z",
  stagingPurgedAt: null,
  reprocessAvailable: false,
  retentionUntil: "2027-07-30T00:00:00.000Z",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  completedAt: null,
};

class SessionManager implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === SESSION_TOKEN ? admin : null; }
  async revoke() { return true; }
}

const identityManager: EnterpriseIdentityManager = {
  async status() { return { configured: true, message: "Configured" }; },
  async startLogin() { throw new Error("Not used"); },
  async completeLogin() { throw new Error("Not used"); },
  async authenticate(token) {
    return token === ENTERPRISE_TOKEN ? {
      id: SESSION_ID,
      subject: "user:fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
      identityMode: "ENTERPRISE",
      displayName: "Pilot User",
      email: "pilot@orcasynapse.example",
      scopes: ["chat:use", "documents:use", "agents:use"],
      session: {
        id: SESSION_ID,
        identityMode: "ENTERPRISE",
        user: {
          id: "fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
          displayName: "Pilot User",
          email: "pilot@orcasynapse.example",
        },
        scopes: ["chat:use", "documents:use", "agents:use"],
        createdAt: "2026-07-30T00:00:00.000Z",
        idleExpiresAt: "2026-07-30T08:00:00.000Z",
        absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
      },
    } : null;
  },
  async revoke() { return true; },
};

function memoryManager(): DocumentManager {
  return {
    list: vi.fn(async () => ({ items: [detail] })),
    get: vi.fn(async () => detail),
    upload: vi.fn(async (_principal, upload) => {
      for await (const _chunk of upload.stream) {
        // Drain the stream to mirror the production upload manager.
      }
      return detail;
    }),
    decideQuarantine: vi.fn(async (): Promise<DocumentDetail> => ({
      ...detail,
      status: "QUEUED",
      processingGeneration: 1,
    })),
    reprocess: vi.fn(async (): Promise<DocumentDetail> => ({
      ...detail,
      status: "QUEUED",
      processingGeneration: 1,
    })),
    delete: vi.fn(async () => undefined),
    metrics: vi.fn(async () => ({
      generatedAt: "2026-07-30T00:00:00.000Z",
      total: 1,
      quarantined: 1,
      processing: 0,
      ready: 0,
      failed: 0,
      rejected: 0,
      stagedDocuments: 1,
      stagedSourceBytes: 1024,
    })),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function documentApp(manager: DocumentManager = memoryManager()) {
  const app = await createApp({
    logger: false,
    runtime: {
      bootstrapState: "READY",
      sessionManager: new SessionManager(),
      identityManager,
      documentManager: manager,
    },
  });
  apps.push(app);
  return app;
}

describe("document routes", () => {
  it("requires an active OrcaSynapse identity", async () => {
    const app = await documentApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/documents" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("lists ownership-scoped documents for an approved enterprise identity", async () => {
    const manager = memoryManager();
    const app = await documentApp(manager);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/documents",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${ENTERPRISE_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ id: DOCUMENT_ID, fileName: "policy.txt", status: "QUARANTINED" }] });
    expect(response.body).not.toContain("textPreview");
    expect(response.body).not.toContain("artifacts");
    expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({
      identityMode: "ENTERPRISE",
      subject: "user:fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
    }));
  });

  it("selects the explicit administrator principal when both session cookies exist", async () => {
    const manager = memoryManager();
    const app = await documentApp(manager);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/documents",
      headers: {
        cookie: `${ENTERPRISE_SESSION_COOKIE}=${ENTERPRISE_TOKEN}; ${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({
      identityMode: "ADMINISTRATOR_PREVIEW",
      subject: "installation-key-administrator",
    }));
  });

  it("accepts one bounded multipart file with query-only governance metadata", async () => {
    const manager = memoryManager();
    const app = await documentApp(manager);
    const boundary = "orcasynapse-document-boundary";
    const payload = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="pilot.txt"',
      "Content-Type: text/plain",
      "",
      "OrcaSynapse pilot content",
      `--${boundary}--`,
      "",
    ].join("\r\n"));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/documents?classification=RESTRICTED&retentionDays=30",
      headers: {
        cookie: `${ENTERPRISE_SESSION_COOKIE}=${ENTERPRISE_TOKEN}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(manager.upload).toHaveBeenCalledWith(
      expect.objectContaining({ identityMode: "ENTERPRISE" }),
      expect.objectContaining({ fileName: "pilot.txt", declaredMediaType: "text/plain" }),
      { classification: "RESTRICTED", retentionDays: 30 },
    );
  });

  it("keeps quarantine decisions and fleet metrics administrator-scoped", async () => {
    const manager = memoryManager();
    const app = await documentApp(manager);
    const enterpriseMetrics = await app.inject({
      method: "GET",
      url: "/api/v1/documents/metrics",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${ENTERPRISE_TOKEN}` },
    });
    expect(enterpriseMetrics.statusCode).toBe(401);
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${DOCUMENT_ID}/quarantine-decision`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { decision: "APPROVE", reason: "Approved internal pilot" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "QUEUED", processingGeneration: 1 });
  });
});
