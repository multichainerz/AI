import { Readable } from "node:stream";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import type { SupermemoryClient } from "@orcasynapse/runtime-clients";
import { describe, expect, it, vi } from "vitest";
import { PrismaDocumentManager } from "./prisma-document-manager.js";

const principal = {
  id: "42fb9f76-972b-4a3e-a819-3f0670c9e7cb",
  subject: "user:pilot",
  identityMode: "ENTERPRISE" as const,
  scopes: ["documents:use"],
};

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
    ownerSubject: principal.subject,
    fileName: "policy.txt",
    mediaType: "text/plain",
    sizeBytes: 12n,
    sha256: "a".repeat(64),
    classification: "INTERNAL",
    status: "QUEUED",
    failureCode: null,
    failureMessage: null,
    retentionUntil: new Date("2027-08-03T00:00:00.000Z"),
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
    updatedAt: new Date("2026-08-03T00:00:00.000Z"),
    completedAt: null,
    supermemoryProjection: { externalDocumentId: "sm-document-1", status: "QUEUED" },
    ...overrides,
  };
}

describe("PrismaDocumentManager", () => {
  it("streams accepted source bytes to Supermemory and persists metadata only", async () => {
    const created = stored();
    const transaction = {
      document: { create: vi.fn(async () => created) },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      document: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as OrcaSynapsePrismaClient;
    const supermemory = {
      uploadFile: vi.fn(async () => ({
        externalDocumentId: "sm-document-1",
        status: "queued",
        sizeBytes: 12,
        sha256: "a".repeat(64),
      })),
      delete: vi.fn(),
    } as unknown as SupermemoryClient;

    const result = await new PrismaDocumentManager(prisma, supermemory).upload(principal, {
      fileName: "policy.txt",
      declaredMediaType: "text/plain",
      stream: Readable.from("policy text"),
    }, { classification: "INTERNAL", retentionDays: 365 });

    expect(result.status).toBe("QUEUED");
    expect(supermemory.uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      ownerSubject: principal.subject,
      fileName: "policy.txt",
      maximumBytes: 50 * 1024 * 1024,
    }));
    expect(transaction.document.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        supermemoryProjection: {
          create: expect.objectContaining({ externalDocumentId: "sm-document-1" }),
        },
      }),
    }));
  });

  it("rejects unsupported source types before contacting Supermemory", async () => {
    const supermemory = { uploadFile: vi.fn() } as unknown as SupermemoryClient;
    const manager = new PrismaDocumentManager({} as OrcaSynapsePrismaClient, supermemory);

    await expect(manager.upload(principal, {
      fileName: "archive.exe",
      declaredMediaType: "application/octet-stream",
      stream: Readable.from("unsafe"),
    }, { classification: "INTERNAL", retentionDays: 365 })).rejects.toThrow("Use TXT");
    expect(supermemory.uploadFile).not.toHaveBeenCalled();
  });

  it("projects completed Supermemory indexing into the document ledger", async () => {
    const row = stored();
    const prisma = {
      document: {
        findMany: vi.fn(async () => [row]),
        update: vi.fn(async () => ({})),
      },
      supermemoryProjection: { update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (operations: unknown[]) => operations),
    } as unknown as OrcaSynapsePrismaClient;
    const supermemory = {
      documentState: vi.fn(async () => ({ status: "done", type: "text", customId: null })),
    } as unknown as SupermemoryClient;

    const result = await new PrismaDocumentManager(prisma, supermemory).list(principal);

    expect(result.items[0]?.status).toBe("READY");
    expect(prisma.document.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "READY" }),
    }));
  });

  it("explains the Supermemory 0.0.5 large-document failure and the exact recovery", async () => {
    const row = stored({
      fileName: "policy.pdf",
      mediaType: "application/pdf",
      sizeBytes: 108_100n,
    });
    const prisma = {
      document: { findMany: vi.fn(async () => [row]), update: vi.fn(async () => ({})) },
      supermemoryProjection: { update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (operations: unknown[]) => operations),
    } as unknown as OrcaSynapsePrismaClient;
    const supermemory = {
      documentState: vi.fn(async () => ({
        status: "failed", type: "pdf", customId: null, runtimeVersion: "0.0.5", failureReason: null,
      })),
    } as unknown as SupermemoryClient;

    const result = await new PrismaDocumentManager(prisma, supermemory).list(principal);

    expect(result.items[0]).toMatchObject({
      status: "FAILED",
      failureCode: "SUPERMEMORY_PROCESSING_FAILED",
      failureMessage: expect.stringContaining("0.0.7-rc.2"),
    });
  });

  it("distinguishes rich-document extraction from BGE-M3 embedding failures", async () => {
    const row = stored({ fileName: "policy.pdf", mediaType: "application/pdf" });
    const prisma = {
      document: { findMany: vi.fn(async () => [row]), update: vi.fn(async () => ({})) },
      supermemoryProjection: { update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (operations: unknown[]) => operations),
    } as unknown as OrcaSynapsePrismaClient;
    const supermemory = {
      documentState: vi.fn(async () => ({
        status: "failed", type: "pdf", customId: null, runtimeVersion: "0.0.7-rc.2", failureReason: null,
      })),
    } as unknown as SupermemoryClient;

    const result = await new PrismaDocumentManager(prisma, supermemory).list(principal);

    expect(result.items[0]?.failureMessage).toContain("before this document reached BGE-M3 embedding");
    expect(result.items[0]?.failureMessage).toContain("chat model");
  });
});
