import { randomUUID } from "node:crypto";
import {
  createTestDatabase,
  document,
  documentChunk,
  auditEvent,
  type TestDatabase,
} from "@orcasynapse/database";
import {
  APPROVED_EMBEDDING_DIMENSIONS,
  DocumentVectorStore,
  type TextEmbedder,
} from "@orcasynapse/knowledge";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentIngestor } from "./document-ingestor.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const OWNER = "user:pilot";
const WORKER = randomUUID();

function embedder(): TextEmbedder {
  return {
    model: "Xenova/bge-m3",
    dimensions: APPROVED_EMBEDDING_DIMENSIONS,
    embed: vi.fn(async (inputs: string[]) =>
      inputs.map((_, index) =>
        Array.from({ length: APPROVED_EMBEDDING_DIMENSIONS }, (_, p) => Math.sin(index + p * 0.01) / 32),
      ),
    ),
  };
}

function ingestor(model: TextEmbedder = embedder()) {
  return new DocumentIngestor(
    context.database,
    new DocumentVectorStore(context.database, model.model),
    model,
  );
}

/** A document the API has already extracted, waiting for the worker. */
async function queued(text: string, overrides: Record<string, unknown> = {}) {
  const [row] = await context.database
    .insert(document)
    .values({
      ownerSubject: OWNER,
      fileName: "policy.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1_024,
      sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      classification: "CONFIDENTIAL",
      status: "QUEUED",
      pendingText: text,
      retentionUntil: new Date(Date.now() + 86_400_000),
      ...overrides,
    })
    .returning({ id: document.id });
  return row!.id;
}

async function stateOf(id: string) {
  const [row] = await context.database
    .select({
      status: document.status,
      pendingText: document.pendingText,
      attempts: document.ingestionAttempts,
      leaseOwner: document.ingestionLeaseOwner,
      failureCode: document.failureCode,
    })
    .from(document)
    .where(eq(document.id, id));
  return row!;
}

describe("DocumentIngestor", () => {
  it("embeds a queued document into pgvector and marks it ready", async () => {
    const id = await queued("The approved operations threshold is ten for every request.");

    const outcome = await ingestor().processNext(WORKER);

    expect(outcome).toMatchObject({ documentId: id, status: "READY" });
    expect(outcome!.chunks).toBeGreaterThan(0);

    const chunks = await context.database
      .select({ content: documentChunk.content, embedding: documentChunk.embedding, owner: documentChunk.ownerSubject })
      .from(documentChunk)
      .where(eq(documentChunk.documentId, id));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.embedding).toHaveLength(APPROVED_EMBEDDING_DIMENSIONS);
    expect(chunks[0]?.owner).toBe(OWNER);

    const after = await stateOf(id);
    expect(after.status).toBe("READY");
    // The queue payload is dropped once the chunks exist, so the extracted text
    // is never held in two places.
    expect(after.pendingText).toBeNull();
    expect(after.leaseOwner).toBeNull();
  });

  it("makes the embedded document retrievable inside the owner boundary only", async () => {
    const model = embedder();
    const store = new DocumentVectorStore(context.database, model.model);
    const id = await queued("Ambang batas yang disetujui adalah sepuluh.");
    await new DocumentIngestor(context.database, store, model).processNext(WORKER);

    const [query] = await model.embed(["ambang batas"]);
    const mine = await store.search(OWNER, "ambang batas", query!, { limit: 5, minimumScore: -1 });
    expect(mine.map(({ documentId }) => documentId)).toContain(id);

    const theirs = await store.search("user:someone-else", "ambang batas", query!, { limit: 5, minimumScore: -1 });
    expect(theirs).toHaveLength(0);
  });

  it("returns null when nothing is queued", async () => {
    expect(await ingestor().processNext(WORKER)).toBeNull();
  });

  it("reclaims a document stranded by a worker that died mid-embed", async () => {
    // CONVERTING with an expired lease is exactly what a crashed worker leaves
    // behind. Before this existed, such a document stayed pending forever.
    const id = await queued("Recoverable body text for the stranded document.", {
      status: "CONVERTING",
      ingestionLeaseOwner: randomUUID(),
      ingestionLeaseExpiresAt: new Date(Date.now() - 60_000),
      ingestionAttempts: 1,
    });

    const outcome = await ingestor().processNext(WORKER);

    expect(outcome).toMatchObject({ documentId: id, status: "READY" });
    expect((await stateOf(id)).status).toBe("READY");
  });

  it("leaves a document held by a live lease alone", async () => {
    await queued("Another worker is already embedding this.", {
      status: "CONVERTING",
      ingestionLeaseOwner: randomUUID(),
      ingestionLeaseExpiresAt: new Date(Date.now() + 300_000),
    });

    expect(await ingestor().processNext(WORKER)).toBeNull();
  });

  it("retries a failing document, then fails it permanently rather than looping", async () => {
    // One document that always throws must not become an endless crash loop;
    // that is what took the executor down before ai-v1.35.0.
    const failing: TextEmbedder = {
      model: "Xenova/bge-m3",
      dimensions: APPROVED_EMBEDDING_DIMENSIONS,
      embed: async () => { throw new Error("embedding runtime unavailable"); },
    };
    const id = await queued("A body long enough to produce at least one chunk.");
    const subject = new DocumentIngestor(
      context.database,
      new DocumentVectorStore(context.database, failing.model),
      failing,
    );

    expect(await subject.processNext(WORKER)).toBeNull();
    expect((await stateOf(id)).status).toBe("CONVERTING");
    expect(await subject.processNext(WORKER)).toBeNull();

    const third = await subject.processNext(WORKER);
    expect(third).toMatchObject({ documentId: id, status: "FAILED" });

    const after = await stateOf(id);
    expect(after.status).toBe("FAILED");
    expect(after.attempts).toBe(3);
    expect(after.pendingText).toBeNull();
    // No half-written index survives the failure.
    expect(await context.database
      .select({ id: documentChunk.id })
      .from(documentChunk)
      .where(eq(documentChunk.documentId, id))).toHaveLength(0);
  });

  it("fails a document whose extracted text is empty instead of indexing nothing", async () => {
    const id = await queued("   ");

    const outcome = await ingestor().processNext(WORKER);

    expect(outcome).toMatchObject({ status: "FAILED" });
    expect((await stateOf(id)).failureCode).toBe("EXTRACTION_FAILED");
  });

  it("records the indexing outcome in the audit trail without the content", async () => {
    const id = await queued("The approved operations threshold is ten for every request.");
    await ingestor().processNext(WORKER);

    const events = await context.database
      .select({ action: auditEvent.action, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, id));

    expect(events.map(({ action }) => action)).toContain("document.indexed_locally");
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("retainedSourceBytes");
    expect(serialized).not.toContain("approved operations threshold");
  });
});

describe("documents stranded before the ingestion queue existed", () => {
  it("fails a CONVERTING document that has no queue payload at all", async () => {
    // Anything uploaded before ai-v1.36.0 sits in CONVERTING with pendingText
    // NULL, because the API used to embed inline and never wrote one. Such a
    // row must still reach a terminal state rather than pending forever.
    const id = await queued("placeholder", {
      status: "CONVERTING",
      pendingText: null,
      ingestionLeaseExpiresAt: null,
    });

    const outcome = await ingestor().processNext(WORKER);

    expect(outcome).toMatchObject({ documentId: id, status: "FAILED" });
    const after = await stateOf(id);
    expect(after.status).toBe("FAILED");
    expect(after.failureCode).toBe("EXTRACTION_FAILED");
  });

  it("does not resurrect a document deleted while it was being embedded", async () => {
    // Embedding a large document takes tens of seconds locally, and an operator
    // may delete it in that window. The finishing worker used to write READY
    // back over DELETED and re-insert the chunk text; because every read filters
    // on status rather than deletedAt, the document reappeared in the dashboard
    // with its content re-indexed. A deletion that reports success must hold.
    const id = await queued("a policy paragraph worth indexing");

    const slowEmbedder = embedder();
    const original = slowEmbedder.embed;
    slowEmbedder.embed = vi.fn(async (inputs: string[]) => {
      // The delete lands mid-embed, exactly as it would on a real host.
      await context.database
        .update(document)
        .set({ status: "DELETED", deletedAt: new Date() })
        .where(eq(document.id, id));
      return original(inputs);
    });

    const outcome = await ingestor(slowEmbedder).processNext(WORKER);

    expect(outcome).toMatchObject({ documentId: id, status: "SUPERSEDED" });
    const after = await stateOf(id);
    expect(after.status).toBe("DELETED");
    // And its text is not left behind in the index under a deleted row.
    const chunks = await context.database
      .select({ id: documentChunk.id }).from(documentChunk).where(eq(documentChunk.documentId, id));
    expect(chunks).toHaveLength(0);
  });

  it("does not release a lease it no longer holds", async () => {
    // The retry branch (attempts under the cap) nulls the lease so another
    // attempt can start sooner. Unguarded, a worker whose own lease had already
    // lapsed would null the lease of the worker that replaced it -- and claim()
    // matches on isNull(ingestionLeaseExpiresAt), so a third worker then takes
    // a document the second is still embedding.
    const id = await queued("a policy paragraph worth indexing");
    const thief = randomUUID();
    const failing: TextEmbedder = {
      model: "Xenova/bge-m3",
      dimensions: APPROVED_EMBEDDING_DIMENSIONS,
      embed: async () => {
        await context.database
          .update(document)
          .set({ ingestionLeaseOwner: thief, ingestionLeaseExpiresAt: new Date(Date.now() + 300_000) })
          .where(eq(document.id, id));
        throw new Error("embedding runtime unavailable");
      },
    };

    expect(await ingestor(failing).processNext(WORKER)).toBeNull();

    expect((await stateOf(id)).leaseOwner, "the replacement worker's lease was released").toBe(thief);
  });

  it("leaves the index alone when its own claim was stolen", async () => {
    // claim() reclaims a CONVERTING row whose lease lapsed, which is the
    // slow-embed case, so two workers can hold the same document in turn. The
    // dispossessed one must not retract chunks: the row is not deleted, so the
    // index belongs to whoever holds the claim now. Deleting would leave a
    // document that reads as indexed and returns no passages.
    const id = await queued("a policy paragraph worth indexing");

    const slowEmbedder = embedder();
    const original = slowEmbedder.embed;
    slowEmbedder.embed = vi.fn(async (inputs: string[]) => {
      // Another worker takes the claim while this one is still embedding.
      await context.database
        .update(document)
        .set({ ingestionLeaseOwner: randomUUID(), ingestionLeaseExpiresAt: new Date(Date.now() + 300_000) })
        .where(eq(document.id, id));
      return original(inputs);
    });

    const outcome = await ingestor(slowEmbedder).processNext(WORKER);

    expect(outcome).toMatchObject({ documentId: id, status: "SUPERSEDED" });
    // Still CONVERTING and owned by the other worker — not written over.
    expect((await stateOf(id)).status).toBe("CONVERTING");
    const chunks = await context.database
      .select({ id: documentChunk.id }).from(documentChunk).where(eq(documentChunk.documentId, id));
    expect(chunks.length, "chunks were retracted from a document that was not deleted").toBeGreaterThan(0);
  });
});
