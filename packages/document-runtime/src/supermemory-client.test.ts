import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { PrismaRuntimeConnectionResolver } from "./connection-resolver.js";
import {
  knowledgeDocumentCustomId,
  knowledgeScopeTag,
  agentMemoryContainerTag,
  SupermemoryClient,
} from "./supermemory-client.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

function resolver(configuration: Record<string, unknown> = {}): PrismaRuntimeConnectionResolver {
  return {
    resolveOne: vi.fn(async () => ({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "SUPERMEMORY",
      baseUrl: "https://memory.orcasynapse.internal/api/",
      configuration,
      secrets: { apiKey: "write-only-key" },
    })),
  } as unknown as PrismaRuntimeConnectionResolver;
}

describe("SupermemoryClient", () => {
  it("streams an authenticated multipart source into the native file endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://memory.orcasynapse.internal/v3/documents/file");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer write-only-key",
        accept: "application/json",
      });
      const stream = init?.body as ReadableStream<Uint8Array>;
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.fromWeb(stream)) chunks.push(Buffer.from(chunk));
      const multipart = Buffer.concat(chunks).toString("utf8");
      expect(multipart).toContain(`name="customId"\r\n\r\n${knowledgeDocumentCustomId(DOCUMENT_ID)}`);
      expect(multipart).toContain(`name="containerTag"\r\n\r\n${knowledgeScopeTag("user:pilot")}`);
      expect(multipart).toContain('filename="policy.txt"');
      expect(multipart).toContain("private policy");
      return new Response(JSON.stringify({ id: "sm-document-1", status: "queued" }), { status: 200 });
    });
    const client = new SupermemoryClient(resolver(), fetcher);

    await expect(client.uploadFile({
      documentId: DOCUMENT_ID,
      ownerSubject: "user:pilot",
      stream: Readable.from("private policy"),
      fileName: "policy.txt",
      mediaType: "text/plain",
      classification: "CONFIDENTIAL",
      maximumBytes: 1_024,
    })).resolves.toMatchObject({
      externalDocumentId: "sm-document-1",
      status: "queued",
      sizeBytes: 14,
    });
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
        metadata: { orcasynapseDocumentId: DOCUMENT_ID, generation: 2, nested: { ignored: true } },
        chunks: [{ content: "Keep every receipt.", score: 0.9 }],
      }] }), { status: 200 });
    });
    const client = new SupermemoryClient(resolver({ searchPath: "/v3/search", retrievalLimit: 4 }), fetcher);

    await expect(client.search("user:pilot", "vehicle policy")).resolves.toEqual([expect.objectContaining({
      externalDocumentId: "sm-document-1",
      metadata: { orcasynapseDocumentId: DOCUMENT_ID, generation: 2 },
      chunks: [{ content: "Keep every receipt.", score: 0.9 }],
    })]);
  });

  it("derives a stable agent-memory namespace without accepting arbitrary tags", () => {
    expect(agentMemoryContainerTag("Primary Hermes")).toBe("orcasynapse-agent-primary-hermes");
    expect(() => agentMemoryContainerTag("---")).toThrow("supported character");
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
