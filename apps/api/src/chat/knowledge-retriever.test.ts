import type { AIHubPrismaClient } from "@aihub/database";
import type { SupermemoryClient } from "@aihub/document-runtime";
import { describe, expect, it, vi } from "vitest";
import { SupermemoryKnowledgeRetriever } from "./knowledge-retriever.js";

const ALLOWED_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const DENIED_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";

describe("SupermemoryKnowledgeRetriever", () => {
  it("re-authorizes remote hits against local ownership and publication state", async () => {
    const prisma = {
      document: {
        findMany: vi.fn(async () => [{
          id: ALLOWED_ID,
          fileName: "approved-policy.pdf",
          classification: "CONFIDENTIAL",
        }]),
      },
    } as unknown as AIHubPrismaClient;
    const client = {
      search: vi.fn(async () => [
        {
          externalDocumentId: "sm-allowed",
          score: 0.92,
          title: null,
          metadata: { aihubDocumentId: ALLOWED_ID },
          chunks: [{ content: "Approved policy excerpt", score: 0.9 }],
        },
        {
          externalDocumentId: "sm-denied",
          score: 0.99,
          title: null,
          metadata: { aihubDocumentId: DENIED_ID },
          chunks: [{ content: "Another user's private source", score: 0.99 }],
        },
      ]),
    } as unknown as SupermemoryClient;
    const retriever = new SupermemoryKnowledgeRetriever(prisma, client);

    const result = await retriever.search("user:pilot", "policy");

    expect(result).toEqual([expect.objectContaining({
      documentId: ALLOWED_ID,
      fileName: "approved-policy.pdf",
      excerpt: "Approved policy excerpt",
    })]);
    expect(prisma.document.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        ownerSubject: "user:pilot",
        status: "READY",
        memoryPublication: { status: "READY" },
      }),
    }));
  });
});
