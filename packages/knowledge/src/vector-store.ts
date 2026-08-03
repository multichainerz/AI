import { and, cosineDistance, desc, eq, gt, sql } from "drizzle-orm";
import {
  documentChunks,
  documents,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";

export interface StoredChunk {
  ordinal: number;
  content: string;
  embedding: number[];
}

export interface ChunkHit {
  documentId: string;
  fileName: string;
  classification: "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  ordinal: number;
  content: string;
  score: number;
}

export interface VectorSearchOptions {
  limit: number;
  /** Cosine similarity floor. Below this a hit is noise and injecting it costs
   *  prompt budget without adding evidence. */
  minimumScore: number;
}

export const DEFAULT_SEARCH_OPTIONS: VectorSearchOptions = { limit: 6, minimumScore: 0.35 };

/**
 * Owner-scoped retrieval over locally embedded document text.
 *
 * The owner boundary is a predicate inside the query rather than a namespace
 * handed to an external service, so it cannot be widened by anything the
 * browser or the agent supplies.
 */
export class DocumentVectorStore {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly embeddingModel: string,
  ) {}

  async replaceDocumentChunks(
    documentId: string,
    ownerSubject: string,
    chunks: StoredChunk[],
  ): Promise<number> {
    return this.database.transaction(async (transaction) => {
      await transaction.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
      if (chunks.length === 0) return 0;
      await transaction.insert(documentChunks).values(
        chunks.map((chunk) => ({
          documentId,
          ownerSubject,
          ordinal: chunk.ordinal,
          content: chunk.content,
          characterCount: chunk.content.length,
          embeddingModel: this.embeddingModel,
          embedding: chunk.embedding,
        })),
      );
      return chunks.length;
    });
  }

  async deleteDocumentChunks(documentId: string): Promise<void> {
    await this.database.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  }

  async countChunks(documentId: string): Promise<number> {
    const [row] = await this.database
      .select({ total: sql<number>`count(*)::int` })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId));
    return row?.total ?? 0;
  }

  /**
   * Hybrid retrieval: cosine similarity fused with a lexical rank over the same
   * chunk. The lexical half materially backstops non-English recall, where a
   * single embedding model is least reliable.
   */
  async search(
    ownerSubject: string,
    query: string,
    queryEmbedding: number[],
    options: VectorSearchOptions = DEFAULT_SEARCH_OPTIONS,
  ): Promise<ChunkHit[]> {
    const similarity = sql<number>`1 - (${cosineDistance(documentChunks.embedding, queryEmbedding)})`;
    const lexical = sql<number>`ts_rank_cd(to_tsvector('simple', ${documentChunks.content}), plainto_tsquery('simple', ${query}))`;
    // Weighted fusion rather than reciprocal rank: one ordered scan, and the
    // vector half stays dominant while lexical breaks near-ties.
    const fused = sql<number>`(${similarity}) + (0.15 * least(${lexical}, 1.0))`;

    const rows = await this.database
      .select({
        documentId: documentChunks.documentId,
        fileName: documents.fileName,
        classification: documents.classification,
        ordinal: documentChunks.ordinal,
        content: documentChunks.content,
        score: fused,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documents.id, documentChunks.documentId))
      .where(
        and(
          eq(documentChunks.ownerSubject, ownerSubject),
          eq(documents.status, "READY"),
          sql`${documents.deletedAt} IS NULL`,
          gt(similarity, options.minimumScore),
        ),
      )
      .orderBy(desc(fused))
      .limit(options.limit);

    return rows.map((row) => ({
      documentId: row.documentId,
      fileName: row.fileName,
      classification: row.classification,
      ordinal: row.ordinal,
      content: row.content,
      score: Number(row.score),
    }));
  }
}
