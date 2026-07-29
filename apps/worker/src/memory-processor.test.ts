import type { AIHubPrismaClient } from "@aihub/database";
import type { SupermemoryClient } from "@aihub/document-runtime";
import { describe, expect, it, vi } from "vitest";
import { PrismaMemoryProcessor } from "./memory-processor.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

function publication() {
  return {
    documentId: DOCUMENT_ID,
    ownerSubject: "user:pilot",
    generation: 2,
    status: "QUEUED",
    externalDocumentId: null,
    document: {
      id: DOCUMENT_ID,
      status: "READY",
      processingGeneration: 2,
      normalizedText: "Approved policy text",
      normalizedMarkdown: "# Approved policy text",
      fileName: "policy.pdf",
      classification: "CONFIDENTIAL",
    },
  };
}

describe("PrismaMemoryProcessor", () => {
  it("publishes only the claimed current document generation", async () => {
    const prisma = {
      documentMemoryPublication: {
        findUnique: vi.fn(async () => publication()),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
      $transaction: vi.fn(),
    } as unknown as AIHubPrismaClient;
    const client = {
      publish: vi.fn(async () => "sm-document-1"),
      delete: vi.fn(),
    } as unknown as SupermemoryClient;
    const processor = new PrismaMemoryProcessor(prisma, client);

    await processor.process({ documentId: DOCUMENT_ID, generation: 2, action: "UPSERT" }, "job-1", "worker-1");

    expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({
      documentId: DOCUMENT_ID,
      ownerSubject: "user:pilot",
      content: "# Approved policy text",
      generation: 2,
    }));
    expect(prisma.documentMemoryPublication.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "PROCESSING" }),
      data: expect.objectContaining({ status: "READY", externalDocumentId: "sm-document-1" }),
    }));
  });

  it("skips a stale generation before making a remote call", async () => {
    const prisma = {
      documentMemoryPublication: { findUnique: vi.fn(async () => publication()) },
    } as unknown as AIHubPrismaClient;
    const client = {
      publish: vi.fn(),
      delete: vi.fn(),
    } as unknown as SupermemoryClient;
    const processor = new PrismaMemoryProcessor(prisma, client);

    await expect(processor.process(
      { documentId: DOCUMENT_ID, generation: 1, action: "UPSERT" },
      "job-1",
      "worker-1",
    )).resolves.toMatchObject({ skipped: true });
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("does not let an old upsert retry reclaim a deletion failure", async () => {
    const current = publication();
    const deleted = {
      ...current,
      status: "FAILED",
      document: { ...current.document, status: "DELETED" },
    };
    const prisma = {
      documentMemoryPublication: { findUnique: vi.fn(async () => deleted) },
    } as unknown as AIHubPrismaClient;
    const client = {
      publish: vi.fn(),
      delete: vi.fn(),
    } as unknown as SupermemoryClient;
    const processor = new PrismaMemoryProcessor(prisma, client);

    await expect(processor.process(
      { documentId: DOCUMENT_ID, generation: 2, action: "UPSERT" },
      "old-upsert-job",
      "worker-1",
    )).resolves.toMatchObject({ skipped: true, reason: "document-generation-is-not-publishable" });
    expect(client.publish).not.toHaveBeenCalled();
  });
});
