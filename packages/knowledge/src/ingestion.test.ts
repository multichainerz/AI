import { describe, expect, it, vi } from "vitest";
import {
  APPROVED_EMBEDDING_DIMENSIONS,
  EmbeddingContractError,
  LocalBgeM3Embedder,
  assertEmbeddingContract,
  embedInBatches,
  type TextEmbedder,
} from "./embedding.js";
import { ingestDocument } from "./ingestion.js";
import type { DocumentVectorStore } from "./vector-store.js";

const encode = (value: string) => new TextEncoder().encode(value);

function embedder(dimensions: number = APPROVED_EMBEDDING_DIMENSIONS): TextEmbedder {
  return {
    model: "Xenova/bge-m3",
    dimensions,
    embed: vi.fn(async (inputs: string[]) =>
      inputs.map((_, index) => Array.from({ length: dimensions }, () => index / 100)),
    ),
  };
}

function store() {
  return {
    replaceDocumentChunks: vi.fn(async (_id: string, _owner: string, chunks: unknown[]) => chunks.length),
    deleteDocumentChunks: vi.fn(async () => undefined),
    countChunks: vi.fn(async () => 0),
    search: vi.fn(async () => []),
  } as unknown as DocumentVectorStore;
}

describe("ingestDocument", () => {
  it("extracts, chunks, embeds and persists in one owner-scoped pass", async () => {
    const vectorStore = store();
    const model = embedder();

    const result = await ingestDocument(vectorStore, model, {
      documentId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      ownerSubject: "user:pilot",
      mediaType: "text/plain",
      bytes: encode("The approved threshold is ten. It applies to every operations request."),
    });

    expect(result.chunks).toBeGreaterThan(0);
    expect(result.embeddingModel).toBe("Xenova/bge-m3");
    expect(vectorStore.replaceDocumentChunks).toHaveBeenCalledWith(
      "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      "user:pilot",
      expect.arrayContaining([
        expect.objectContaining({ ordinal: 0, content: expect.any(String) }),
      ]),
    );
  });

  it("persists nothing when a document yields no chunks", async () => {
    const vectorStore = store();
    const model = embedder();

    await expect(
      ingestDocument(vectorStore, model, {
        documentId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        ownerSubject: "user:pilot",
        mediaType: "text/plain",
        bytes: encode("    "),
      }),
    ).rejects.toThrow();

    expect(vectorStore.replaceDocumentChunks).not.toHaveBeenCalled();
  });

  it("propagates an unsupported media type instead of storing an empty document", async () => {
    const vectorStore = store();

    await expect(
      ingestDocument(vectorStore, embedder(), {
        documentId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        ownerSubject: "user:pilot",
        mediaType: "image/png",
        bytes: encode("binary"),
      }),
    ).rejects.toThrow(/cannot extract text/i);

    expect(vectorStore.replaceDocumentChunks).not.toHaveBeenCalled();
  });
});

describe("assertEmbeddingContract", () => {
  const approved = (count: number) =>
    Array.from({ length: count }, () => Array.from({ length: APPROVED_EMBEDDING_DIMENSIONS }, () => 0.1));

  it("passes a batch that matches the approved model", () => {
    expect(assertEmbeddingContract(approved(3), 3)).toHaveLength(3);
  });

  it("rejects a substituted narrower model instead of indexing it silently", () => {
    // bge-base-en-v1.5 at 768 dimensions is precisely what an upstream release
    // swapped in before, degrading non-English recall with nothing to observe.
    const substituted = [Array.from({ length: 768 }, () => 0.1)];

    expect(() => assertEmbeddingContract(substituted, 1)).toThrow(EmbeddingContractError);
    expect(() => assertEmbeddingContract(substituted, 1)).toThrow(/768 dimensions/);
  });

  it("rejects a batch size the runtime did not honour", () => {
    expect(() => assertEmbeddingContract(approved(2), 3)).toThrow(EmbeddingContractError);
  });

  it("pins the approved model and width", () => {
    expect(new LocalBgeM3Embedder().model).toBe("Xenova/bge-m3");
    expect(new LocalBgeM3Embedder().dimensions).toBe(1024);
    expect(new EmbeddingContractError("x").code).toBe("EMBEDDING_CONTRACT_VIOLATED");
  });

  it("embeds in bounded batches so a large document cannot exhaust memory", async () => {
    const model = embedder(4);
    const vectors = await embedInBatches(model, Array.from({ length: 10 }, (_, i) => `chunk ${i}`), 3);

    expect(vectors).toHaveLength(10);
    expect(model.embed).toHaveBeenCalledTimes(4);
  });
});
