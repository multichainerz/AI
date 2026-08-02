import { Readable } from "node:stream";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import type { DocumentScratchStore } from "@orcasynapse/document-runtime";
import { describe, expect, it, vi } from "vitest";
import { DocumentConflictError, DocumentStorageError, DocumentValidationError } from "./document-manager.js";
import { PrismaDocumentManager } from "./prisma-document-manager.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

describe("PrismaDocumentManager upload boundaries", () => {
  it("rejects rich files before creating document metadata and purges transient staging", async () => {
    const store = {
      putStream: vi.fn(async (_key: string, source: Readable) => {
        for await (const _chunk of source) {
          // Consume the measured upload as the encrypted store would.
        }
      }),
      deletePrefix: vi.fn(async () => undefined),
    } as unknown as DocumentScratchStore;
    const manager = new PrismaDocumentManager({} as OrcaSynapsePrismaClient, store);

    await expect(manager.upload({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
      scopes: ["documents:use"],
    }, {
      fileName: "scan.pdf",
      declaredMediaType: "application/pdf",
      stream: Readable.from([Buffer.from("%PDF-1.7")]),
    }, {
      classification: "INTERNAL",
      retentionDays: 365,
    })).rejects.toBeInstanceOf(DocumentValidationError);

    expect(store.deletePrefix).toHaveBeenCalledOnce();
  });
});

describe("PrismaDocumentManager deletion boundaries", () => {
  it("does not allow a late memory publication to race local deletion", async () => {
    const prisma = {
      document: {
        findFirst: vi.fn(async () => ({
          id: DOCUMENT_ID,
          status: "READY",
          retentionUntil: new Date("2026-07-29T00:00:00.000Z"),
          memoryPublication: { status: "PROCESSING" },
        })),
      },
    } as unknown as OrcaSynapsePrismaClient;
    const store = { deletePrefix: vi.fn() } as unknown as DocumentScratchStore;
    const manager = new PrismaDocumentManager(prisma, store);

    await expect(manager.delete({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
      scopes: ["documents:use"],
    }, DOCUMENT_ID, { force: false })).rejects.toBeInstanceOf(DocumentConflictError);
    expect(store.deletePrefix).not.toHaveBeenCalled();
  });

  it("restores the claimed status when transient staging cannot be purged", async () => {
    const document = {
      id: DOCUMENT_ID,
      status: "READY",
      processingGeneration: 2,
      retentionUntil: new Date("2026-07-29T00:00:00.000Z"),
      memoryPublication: { status: "READY" },
    };
    const prisma = {
      document: {
        findFirst: vi.fn(async () => document),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    } as unknown as OrcaSynapsePrismaClient;
    const store = {
      deletePrefix: vi.fn(async () => { throw new Error("volume unavailable"); }),
    } as unknown as DocumentScratchStore;
    const manager = new PrismaDocumentManager(prisma, store);

    await expect(manager.delete({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
      scopes: ["documents:use"],
    }, DOCUMENT_ID, { force: false })).rejects.toBeInstanceOf(DocumentStorageError);

    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      data: { status: "READY" },
    });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "document.deletion_failed", outcome: "FAILURE" }),
    }));
  });
});

describe("PrismaDocumentManager quarantine boundaries", () => {
  it("scopes rejection claims to the enterprise document owner", async () => {
    const transaction = {
      document: { updateMany: vi.fn(async () => ({ count: 0 })) },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: typeof transaction) => unknown) => work(transaction)),
    } as unknown as OrcaSynapsePrismaClient;
    const store = { deletePrefix: vi.fn() } as unknown as DocumentScratchStore;
    const manager = new PrismaDocumentManager(prisma, store);

    await expect(manager.decideQuarantine({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
      scopes: ["documents:use"],
    }, DOCUMENT_ID, { decision: "REJECT", reason: "Not relevant" }))
      .rejects.toBeInstanceOf(DocumentConflictError);

    expect(transaction.document.updateMany).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID, ownerSubject: "user:pilot", status: "QUARANTINED" },
      data: expect.objectContaining({ status: "REJECTED" }),
    });
    expect(store.deletePrefix).not.toHaveBeenCalled();
  });
});
