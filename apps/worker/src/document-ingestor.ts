import { chunkText, embedInBatches, type DocumentVectorStore, type TextEmbedder } from "@orcasynapse/knowledge";
import { auditEvent, document, type OrcaSynapseDatabase } from "@orcasynapse/database";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

/**
 * How long one worker owns a document before another may take it.
 *
 * Deliberately longer than the agent-run lease: embedding a large document is
 * slower than a single Hermes turn, and taking it away mid-flight would waste
 * the work rather than rescue it.
 */
const INGESTION_LEASE_MS = 300_000;

/**
 * Attempts before a document is failed permanently.
 *
 * Without a cap, a document that reliably crashes the worker is retried
 * forever, which is exactly how a single bad upload took the executor down
 * before v0.6.0. Three is enough to survive a restart or a transient
 * model-load failure without turning a poison pill into an outage.
 */
const MAXIMUM_INGESTION_ATTEMPTS = 3;

export interface IngestionOutcome {
  documentId: string;
  chunks: number;
  status: "READY" | "FAILED";
}

/**
 * Embeds documents the API has already extracted.
 *
 * Extraction stays on the request because it is fast and rejects a malformed
 * file while the caller is still listening. Embedding lives here because it
 * loads ~2 GB of weights and outlives any proxy timeout — and because a crash
 * mid-embed must leave the document recoverable rather than stranded.
 */
export class DocumentIngestor {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly vectors: DocumentVectorStore,
    private readonly embedder: TextEmbedder,
  ) {}

  /**
   * Claims one queued document, embeds it, and records the result.
   *
   * Returns null when there is nothing to do. The claim is a conditional
   * UPDATE, so two workers racing for the same document cannot both win.
   */
  async processNext(workerId: string): Promise<IngestionOutcome | null> {
    const claimed = await this.claim(workerId);
    if (!claimed) return null;

    const { id, ownerSubject, pendingText, attempts } = claimed;

    try {
      if (!pendingText || !pendingText.trim()) {
        // Nothing survived extraction; failing is correct rather than storing
        // an empty index that silently answers nothing.
        return await this.fail(id, "EXTRACTION_FAILED", "The document contained no extractable text.");
      }

      const chunks = chunkText(pendingText);
      if (chunks.length === 0) {
        return await this.fail(id, "EXTRACTION_FAILED", "The document produced no retrievable chunks.");
      }

      const vectors = await embedInBatches(this.embedder, chunks.map(({ content }) => content));
      const stored = await this.vectors.replaceDocumentChunks(
        id,
        ownerSubject,
        chunks.map((chunk, index) => ({
          ordinal: chunk.ordinal,
          content: chunk.content,
          embedding: vectors[index]!,
        })),
      );

      await this.database
        .update(document)
        .set({
          status: "READY",
          completedAt: new Date(),
          failureCode: null,
          failureMessage: null,
          // The queue payload is dropped now the chunks exist, so the extracted
          // text is held exactly once.
          pendingText: null,
          ingestionLeaseOwner: null,
          ingestionLeaseExpiresAt: null,
        })
        .where(eq(document.id, id));

      await this.database.insert(auditEvent).values({
        actorType: "SERVICE",
        actorId: workerId,
        action: "document.indexed_locally",
        resourceType: "Document",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: {
          chunks: stored,
          embeddingModel: this.embedder.model,
          attempts: attempts + 1,
          retainedSourceBytes: 0,
        },
      });

      return { documentId: id, chunks: stored, status: "READY" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Indexing failed.";
      if (attempts + 1 >= MAXIMUM_INGESTION_ATTEMPTS) {
        return await this.fail(id, "INDEXING_FAILED", message, workerId, attempts + 1);
      }
      // Release the lease so another attempt can pick it up, rather than
      // holding it until expiry.
      await this.database
        .update(document)
        .set({ ingestionLeaseOwner: null, ingestionLeaseExpiresAt: null, failureMessage: message.slice(0, 500) })
        .where(eq(document.id, id));
      return null;
    }
  }

  /** Takes ownership of the oldest document whose lease is free or expired. */
  private async claim(workerId: string): Promise<
    { id: string; ownerSubject: string; pendingText: string | null; attempts: number } | null
  > {
    const [candidate] = await this.database
      .select({
        id: document.id,
        ownerSubject: document.ownerSubject,
        pendingText: document.pendingText,
        attempts: document.ingestionAttempts,
      })
      .from(document)
      .where(
        and(
          // CONVERTING is included so a document stranded by a crashed worker is
          // reclaimed once its lease expires, instead of pending forever.
          or(eq(document.status, "QUEUED"), eq(document.status, "CONVERTING")),
          or(
            isNull(document.ingestionLeaseExpiresAt),
            lt(document.ingestionLeaseExpiresAt, new Date()),
          ),
        ),
      )
      .orderBy(asc(document.createdAt))
      .limit(1);
    if (!candidate) return null;

    const taken = await this.database
      .update(document)
      .set({
        status: "CONVERTING",
        ingestionLeaseOwner: workerId,
        ingestionLeaseExpiresAt: new Date(Date.now() + INGESTION_LEASE_MS),
        ingestionAttempts: sql`${document.ingestionAttempts} + 1`,
      })
      .where(
        and(
          eq(document.id, candidate.id),
          // Re-checked inside the write so a worker that lost the race does not
          // steal a document another one just claimed.
          or(
            isNull(document.ingestionLeaseExpiresAt),
            lt(document.ingestionLeaseExpiresAt, new Date()),
          ),
        ),
      )
      .returning({ id: document.id });

    return taken.length === 1 ? candidate : null;
  }

  private async fail(
    id: string,
    code: string,
    message: string,
    workerId?: string,
    attempts?: number,
  ): Promise<IngestionOutcome> {
    await this.database
      .update(document)
      .set({
        status: "FAILED",
        failureCode: code,
        failureMessage: message.slice(0, 500),
        pendingText: null,
        ingestionLeaseOwner: null,
        ingestionLeaseExpiresAt: null,
      })
      .where(eq(document.id, id));
    await this.vectors.deleteDocumentChunks(id).catch(() => undefined);
    if (workerId) {
      await this.database.insert(auditEvent).values({
        actorType: "SERVICE",
        actorId: workerId,
        action: "document.indexing_failed",
        resourceType: "Document",
        resourceId: id,
        outcome: "FAILURE",
        metadata: { failureCode: code, attempts: attempts ?? null, retainedSourceBytes: 0 },
      });
    }
    return { documentId: id, chunks: 0, status: "FAILED" };
  }
}
