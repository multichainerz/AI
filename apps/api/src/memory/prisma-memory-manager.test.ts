import type { AIHubPrismaClient } from "@aihub/database";
import type { PgBossQueueService } from "@aihub/jobs";
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
  const queue = {
    sendMemoryIndex: vi.fn(async () => "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb"),
  } as unknown as PgBossQueueService;
  return { prisma, queue, manager: new PrismaMemoryManager(prisma, queue) };
}

describe("PrismaMemoryManager", () => {
  it("queues an upsert for an active ready document", async () => {
    const { manager, queue, prisma } = harness("READY");
    await manager.reindex(DOCUMENT_ID, "memory-operator");
    expect(queue.sendMemoryIndex).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      generation: 2,
      action: "UPSERT",
    });
    expect(prisma.documentMemoryPublication.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "QUEUED" }),
    }));
  });

  it("queues deletion recovery for a deleted document with a prior publication", async () => {
    const { manager, queue, prisma } = harness("DELETED");
    await manager.reindex(DOCUMENT_ID, "memory-operator");
    expect(prisma.documentMemoryPublication.findUnique).toHaveBeenCalledWith({
      where: { documentId: DOCUMENT_ID },
      select: { documentId: true },
    });
    expect(queue.sendMemoryIndex).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      generation: 2,
      action: "DELETE",
    });
    expect(prisma.documentMemoryPublication.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "DELETE_PENDING" }),
    }));
  });
});
