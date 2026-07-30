import type { AIHubPrismaClient } from "@aihub/database";
import type { DocumentObjectStore } from "@aihub/document-runtime";
import type { PgBossQueueService } from "@aihub/jobs";
import { describe, expect, it, vi } from "vitest";
import { DocumentConflictError } from "./document-manager.js";
import { PrismaDocumentManager } from "./prisma-document-manager.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

describe("PrismaDocumentManager deletion boundaries", () => {
  it("does not allow a late memory publication to race local deletion", async () => {
    const prisma = {
      document: {
        findFirst: vi.fn(async () => ({
          id: DOCUMENT_ID,
          status: "READY",
          originalObjectKey: "documents/original.pdf",
          retentionUntil: new Date("2026-07-29T00:00:00.000Z"),
          artifacts: [{ objectKey: "documents/original.pdf" }],
          memoryPublication: { status: "PROCESSING" },
        })),
      },
    } as unknown as AIHubPrismaClient;
    const store = { delete: vi.fn() } as unknown as DocumentObjectStore;
    const queue = {} as PgBossQueueService;
    const manager = new PrismaDocumentManager(prisma, store, queue);

    await expect(manager.delete({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
      scopes: ["documents:use"],
    }, DOCUMENT_ID, { force: false })).rejects.toBeInstanceOf(DocumentConflictError);
    expect(store.delete).not.toHaveBeenCalled();
  });
});
