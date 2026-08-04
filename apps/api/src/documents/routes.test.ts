import type { DocumentDetail } from "@orcasynapse/contracts";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AdminSessionManager } from "../auth/admin-session.js";
import type { DocumentManager } from "./document-manager.js";
import { registerDocumentRoutes } from "./routes.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const detail: DocumentDetail = {
  id: DOCUMENT_ID,
  fileName: "policy.txt",
  mediaType: "text/plain",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  classification: "INTERNAL",
  status: "QUEUED",
  failureCode: null,
  failureMessage: null,
  retentionUntil: "2027-08-03T00:00:00.000Z",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  completedAt: null,
};

function sessionManager(): AdminSessionManager {
  return {
    authenticate: vi.fn(async () => ({
      id: "42fb9f76-972b-4a3e-a819-3f0670c9e7cb",
      subject: "local:admin",
      role: "SYSTEM_ADMIN",
      scopes: ["documents:read", "documents:review", "documents:delete"],
    })),
  } as unknown as AdminSessionManager;
}

function manager(): DocumentManager {
  return {
    list: vi.fn(async () => ({ items: [detail] })),
    get: vi.fn(async () => detail),
    upload: vi.fn(async (_principal, upload) => {
      for await (const _chunk of upload.stream) { /* mirror streaming relay */ }
      return detail;
    }),
    delete: vi.fn(async () => undefined),
    metrics: vi.fn(async () => ({
      generatedAt: "2026-08-03T00:00:00.000Z",
      total: 1,
      processing: 1,
      ready: 0,
      failed: 0,
      retainedSourceBytes: 0 as const,
    })),
  };
}

describe("document routes", () => {
  it("lists metadata-only knowledge records", async () => {
    const app = Fastify();
    await app.register(async (router) => registerDocumentRoutes(router, { sessionManager: sessionManager(), manager: manager() }), { prefix: "/api/v1/documents" });
    const response = await app.inject({ method: "GET", url: "/api/v1/documents" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ id: DOCUMENT_ID, status: "QUEUED" }] });
    await app.close();
  });

  it("accepts one bounded multipart source for direct relay", async () => {
    const documentManager = manager();
    const app = Fastify();
    await app.register(async (router) => registerDocumentRoutes(router, { sessionManager: sessionManager(), manager: documentManager }), { prefix: "/api/v1/documents" });
    const boundary = "orcasynapse-test-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="pilot.txt"',
      "Content-Type: text/plain",
      "",
      "approved source",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/documents?classification=RESTRICTED&retentionDays=30",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(documentManager.upload).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "local:admin" }),
      expect.objectContaining({ fileName: "pilot.txt", declaredMediaType: "text/plain" }),
      { classification: "RESTRICTED", retentionDays: 30 },
    );
    await app.close();
  });

  it("refuses a format the extractor cannot read, before the manager sees it", async () => {
    const documentManager = manager();
    const app = Fastify();
    await app.register(async (router) => registerDocumentRoutes(router, { sessionManager: sessionManager(), manager: documentManager }), { prefix: "/api/v1/documents" });
    const boundary = "orcasynapse-test-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="scan.png"',
      "Content-Type: image/png",
      "",
      "not text",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/documents?classification=INTERNAL&retentionDays=30",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: "UNSUPPORTED_MEDIA_TYPE" });
    // The message names what the operator can actually upload.
    expect(response.json().message).toContain(".xlsx");
    // Rejection happens at the boundary, not after ingestion has read the file.
    expect(documentManager.upload).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a spreadsheet, which the picker previously could not offer", async () => {
    const documentManager = manager();
    const app = Fastify();
    await app.register(async (router) => registerDocumentRoutes(router, { sessionManager: sessionManager(), manager: documentManager }), { prefix: "/api/v1/documents" });
    const boundary = "orcasynapse-test-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="capacity.xlsx"',
      "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "",
      "workbook bytes",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/documents?classification=INTERNAL&retentionDays=30",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(documentManager.upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fileName: "capacity.xlsx" }),
      expect.anything(),
    );
    await app.close();
  });

  it("reports zero retained source bytes", async () => {
    const app = Fastify();
    await app.register(async (router) => registerDocumentRoutes(router, { sessionManager: sessionManager(), manager: manager() }), { prefix: "/api/v1/documents" });
    const response = await app.inject({ method: "GET", url: "/api/v1/documents/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.json().retainedSourceBytes).toBe(0);
    await app.close();
  });
});
