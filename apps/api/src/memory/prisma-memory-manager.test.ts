import type { AIHubPrismaClient } from "@aihub/database";
import { describe, expect, it, vi } from "vitest";
import { PrismaMemoryManager } from "./prisma-memory-manager.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

function harness(status: "READY" | "DELETED") {
  const prisma = {
    document: {
      findFirst: vi.fn(async () => ({
        id: DOCUMENT_ID,
        ownerSubject: "user:pilot",
        processingGeneration: 2,
        status,
      })),
    },
    documentMemoryPublication: {
      findUnique: vi.fn(async () => ({ documentId: DOCUMENT_ID })),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    auditEvent: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (actions: Array<Promise<unknown>>) => Promise.all(actions)),
  } as unknown as AIHubPrismaClient;
  return { prisma, manager: new PrismaMemoryManager(prisma) };
}

describe("PrismaMemoryManager", () => {
  it("queues an upsert for an active ready document", async () => {
    const { manager, prisma } = harness("READY");
    await manager.reindex(DOCUMENT_ID, "memory-operator");
    expect(prisma.documentMemoryPublication.update).toHaveBeenCalledWith(expect.objectContaining({ data: { jobId: expect.any(String) } }));
    expect(prisma.documentMemoryPublication.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "QUEUED" }),
    }));
  });

  it("queues deletion recovery for a deleted document with a prior publication", async () => {
    const { manager, prisma } = harness("DELETED");
    await manager.reindex(DOCUMENT_ID, "memory-operator");
    expect(prisma.documentMemoryPublication.findUnique).toHaveBeenCalledWith({
      where: { documentId: DOCUMENT_ID },
      select: { documentId: true },
    });
    expect(prisma.documentMemoryPublication.update).toHaveBeenCalledWith(expect.objectContaining({ data: { jobId: expect.any(String) } }));
    expect(prisma.documentMemoryPublication.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "DELETE_PENDING" }),
    }));
  });
});
