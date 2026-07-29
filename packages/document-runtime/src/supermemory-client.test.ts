import { describe, expect, it, vi } from "vitest";
import type { PrismaRuntimeConnectionResolver } from "./connection-resolver.js";
import {
  knowledgeDocumentCustomId,
  knowledgeScopeTag,
  SupermemoryClient,
} from "./supermemory-client.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

function resolver(configuration: Record<string, unknown> = {}): PrismaRuntimeConnectionResolver {
  return {
    resolveOne: vi.fn(async () => ({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "SUPERMEMORY",
      baseUrl: "https://memory.mpm.internal/api/",
      configuration,
      secrets: { apiKey: "write-only-key" },
    })),
  } as unknown as PrismaRuntimeConnectionResolver;
}

describe("SupermemoryClient", () => {
  it("publishes a document into a derived private container and waits for indexing", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer write-only-key" }));
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          containerTag: knowledgeScopeTag("user:pilot"),
          customId: knowledgeDocumentCustomId(DOCUMENT_ID),
          taskType: "superrag",
        });
        expect(JSON.stringify(body)).not.toContain("user:pilot");
        return new Response(JSON.stringify({ id: "sm-document-1" }), { status: 202 });
      }
      expect(url).toBe("https://memory.mpm.internal/v3/documents/sm-document-1");
      return new Response(JSON.stringify({ status: "done" }), { status: 200 });
    });
    const client = new SupermemoryClient(resolver({ documentsPath: "/v3/documents" }), fetcher);

    await expect(client.publish({
      documentId: DOCUMENT_ID,
      ownerSubject: "user:pilot",
      content: "Approved normalized content",
      fileName: "policy.pdf",
      classification: "CONFIDENTIAL",
      generation: 2,
    })).resolves.toBe("sm-document-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("parses bounded chunk search results and preserves scalar metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        q: "vehicle policy",
        containerTag: knowledgeScopeTag("user:pilot"),
        limit: 4,
      });
      return new Response(JSON.stringify({ results: [{
        documentId: "sm-document-1",
        score: 0.91,
        title: "Vehicle policy",
        metadata: { aihubDocumentId: DOCUMENT_ID, generation: 2, nested: { ignored: true } },
        chunks: [{ content: "Keep every receipt.", score: 0.9 }],
      }] }), { status: 200 });
    });
    const client = new SupermemoryClient(resolver({ searchPath: "/v3/search", retrievalLimit: 4 }), fetcher);

    await expect(client.search("user:pilot", "vehicle policy")).resolves.toEqual([expect.objectContaining({
      externalDocumentId: "sm-document-1",
      metadata: { aihubDocumentId: DOCUMENT_ID, generation: 2 },
      chunks: [{ content: "Keep every receipt.", score: 0.9 }],
    })]);
  });

  it("rejects administrator-configured paths that escape the Supermemory origin", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SupermemoryClient(
      resolver({ searchPath: "https://external.example/v3/search" }),
      fetcher,
    );
    await expect(client.search("user:pilot", "policy")).rejects.toThrow("configured origin");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
