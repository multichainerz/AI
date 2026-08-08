import { chunkText, embedInBatches, type DocumentVectorStore, type TextEmbedder } from "@orcasynapse/knowledge";
import { auditEvent, document, type OrcaSynapseDatabase } from "@orcasynapse/database";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";

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
  // SUPERSEDED means the row moved on while this worker was embedding -- almost
  // always an operator deleting the document mid-ingestion. It is a normal
  // outcome, not a failure: the work is discarded rather than written back.
  status: "READY" | "FAILED" | "SUPERSEDED";
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

      const settled = await this.database
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
        // Only while this worker still holds the claim. Deletion is allowed to
        // race ingestion: an operator can delete a large document while it is
        // still embedding, and without this guard the finishing worker wrote
        // READY back over DELETED. Every read filters on status rather than
        // deletedAt, so the document reappeared in the dashboard with its text
        // re-indexed -- a deletion that reported success and did not hold.
        // Status *and* lease owner. Deleting does not clear the lease, so
        // matching the owner alone still matched a row an operator had already
        // deleted -- the guard has to assert the row is still the one this
        // worker claimed, in the state it claimed it in.
        .where(and(
          eq(document.id, id),
          eq(document.status, "CONVERTING"),
          eq(document.ingestionLeaseOwner, workerId),
        ))
        .returning({ id: document.id });

      // The chunks were written before the row was, so a lost claim leaves them
      // behind. Retract them rather than leaving a deleted document's text in
      // the index under a row that no longer points at it.
      if (settled.length !== 1) {
        // Two different reasons the claim can be lost, and they need opposite
        // handling. If the row was deleted, our chunks are orphans and must go.
        // If another worker took the claim -- reachable, because claim() picks
        // up a CONVERTING row whose lease lapsed, which is the slow-embed case
        // -- then the chunks in the index are *theirs*, and retracting them
        // would leave a READY document indexing nothing.
        const [current] = await this.database
          .select({ status: document.status })
          .from(document)
          .where(eq(document.id, id))
          .limit(1);
        if (!current || current.status === "DELETED") {
          await this.vectors.deleteDocumentChunks(id).catch(() => undefined);
        }
        return { documentId: id, chunks: 0, status: "SUPERSEDED" };
      }

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
      // Only our own lease. Unguarded, a worker whose lease had already lapsed
      // released the lease of the worker that replaced it -- and claim() treats
      // a null expiry as free, so a third worker took a document the second was
      // still embedding. This is also the write that could put a failureMessage
      // on a DELETED row, which the terminal writes are guarded against.
      await this.database
        .update(document)
        .set({ ingestionLeaseOwner: null, ingestionLeaseExpiresAt: null, failureMessage: message.slice(0, 500) })
        .where(and(
          eq(document.id, id),
          ne(document.status, "DELETED"),
          eq(document.ingestionLeaseOwner, workerId),
        ));
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
    const settled = await this.database
      .update(document)
      .set({
        status: "FAILED",
        failureCode: code,
        failureMessage: message.slice(0, 500),
        pendingText: null,
        ingestionLeaseOwner: null,
        ingestionLeaseExpiresAt: null,
      })
      // Deleted rows stay deleted, and a worker that lost its claim must not
      // write a terminal failure over the row its replacement is still working.
      // The early extraction failures pass no workerId; they run after the
      // claim but have no lease value to match on there.
      .where(and(
        eq(document.id, id),
        ne(document.status, "DELETED"),
        ...(workerId ? [eq(document.ingestionLeaseOwner, workerId)] : []),
      ))
      .returning({ id: document.id });
    // Only when the row above was actually ours. Retracting unconditionally was
    // worse than having no guard at all: a worker whose lease had lapsed would
    // fail, match no row, and still wipe the index the replacement had just
    // written -- leaving a READY document that returns nothing. Before the
    // guard existed the row at least went FAILED alongside its empty index, so
    // the state was wrong but self-consistent.
    if (settled.length === 1) {
      await this.vectors.deleteDocumentChunks(id).catch(() => undefined);
    }
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
