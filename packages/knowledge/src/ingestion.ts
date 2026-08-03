import { chunkText, DEFAULT_CHUNK_BOUNDS, type ChunkBounds } from "./chunking.js";
import { embedInBatches, type TextEmbedder } from "./embedding.js";
import {
  DEFAULT_EXTRACTION_BOUNDS,
  extractDocumentText,
  type ExtractionBounds,
} from "./extraction.js";
import type { DocumentVectorStore } from "./vector-store.js";

export interface IngestionInput {
  documentId: string;
  ownerSubject: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface IngestionResult {
  chunks: number;
  characters: number;
  pages: number | null;
  truncated: boolean;
  embeddingModel: string;
}

export interface IngestionBounds {
  extraction: ExtractionBounds;
  chunking: ChunkBounds;
  embeddingBatchSize: number;
}

export const DEFAULT_INGESTION_BOUNDS: IngestionBounds = {
  extraction: DEFAULT_EXTRACTION_BOUNDS,
  chunking: DEFAULT_CHUNK_BOUNDS,
  embeddingBatchSize: 16,
};

/**
 * Upload to retrievable, entirely inside OrcaSynapse.
 *
 * The caller owns the bytes and is expected to discard them the moment this
 * resolves or throws - nothing here writes them to disk, and only derived text
 * and vectors are persisted.
 */
export async function ingestDocument(
  store: DocumentVectorStore,
  embedder: TextEmbedder,
  input: IngestionInput,
  bounds: IngestionBounds = DEFAULT_INGESTION_BOUNDS,
): Promise<IngestionResult> {
  const extracted = await extractDocumentText(
    { mediaType: input.mediaType, bytes: input.bytes },
    bounds.extraction,
  );

  const chunks = chunkText(extracted.text, bounds.chunking);
  if (chunks.length === 0) {
    return {
      chunks: 0,
      characters: extracted.text.length,
      pages: extracted.pages,
      truncated: extracted.truncated,
      embeddingModel: embedder.model,
    };
  }

  const vectors = await embedInBatches(
    embedder,
    chunks.map(({ content }) => content),
    bounds.embeddingBatchSize,
  );

  const stored = await store.replaceDocumentChunks(
    input.documentId,
    input.ownerSubject,
    chunks.map((chunk, index) => ({
      ordinal: chunk.ordinal,
      content: chunk.content,
      embedding: vectors[index]!,
    })),
  );

  return {
    chunks: stored,
    characters: extracted.text.length,
    pages: extracted.pages,
    truncated: extracted.truncated,
    embeddingModel: embedder.model,
  };
}
