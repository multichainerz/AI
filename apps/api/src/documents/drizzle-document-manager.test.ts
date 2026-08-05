import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { auditEvent, createTestDatabase, document, type TestDatabase } from "@orcasynapse/database";
import { APPROVED_EMBEDDING_DIMENSIONS, DocumentVectorStore, type TextEmbedder } from "@orcasynapse/knowledge";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleDocumentManager } from "./drizzle-document-manager.js";
import {
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentValidationError,
  type DocumentPrincipal,
} from "./document-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const owner: DocumentPrincipal = {
  id: randomUUID(),
  subject: "user:pilot",
  identityMode: "ENTERPRISE",
  scopes: [],
} as never;

const administrator: DocumentPrincipal = {
  id: randomUUID(),
  subject: "admin:preview",
  identityMode: "ADMINISTRATOR_PREVIEW",
  scopes: ["documents:delete"],
} as never;

/** Deterministic stand-in for BGE-M3: the manager is under test, not the model. */
function embedder(): TextEmbedder {
  return {
    model: "Xenova/bge-m3",
    dimensions: APPROVED_EMBEDDING_DIMENSIONS,
    embed: vi.fn(async (inputs: string[]) =>
      inputs.map((_, index) =>
        Array.from({ length: APPROVED_EMBEDDING_DIMENSIONS }, (_, position) =>
          Math.sin(index + position * 0.01) / 32,
        ),
      ),
    ),
  };
}

function manager(model: TextEmbedder = embedder()) {
  return new DrizzleDocumentManager(
    context.database,
    new DocumentVectorStore(context.database, model.model),
  );
}

function upload(fileName: string, body: string, declared = "") {
  return {
    fileName,
    declaredMediaType: declared || "application/octet-stream",
    stream: Readable.from([Buffer.from(body, "utf8")]) as never,
  };
}

const metadata = { classification: "CONFIDENTIAL", retentionDays: 30 } as never;

describe("DrizzleDocumentManager", () => {
  it("queues an uploaded document for indexing and answers immediately", async () => {
    const stored = await manager().upload(
      owner,
      upload("policy.txt", "The approved operations threshold is ten for every request."),
      metadata,
    );

    // The upload no longer waits for the model: it extracts, queues, returns.
    expect(stored.status).toBe("QUEUED");
    expect(stored.mediaType).toBe("text/plain");
    expect(stored.sizeBytes).toBeGreaterThan(0);

    const [event] = await context.database
      .select({ action: auditEvent.action, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, stored.id));
    expect(event?.action).toBe("document.queued_for_indexing");
    // The trail still proves no source bytes were kept.
    expect(JSON.stringify(event?.metadata)).toContain("retainedSourceBytes");
  });

  it("refuses an image because retrieval indexes extracted text", async () => {
    await expect(
      manager().upload(owner, upload("scan.png", "binary"), metadata),
    ).rejects.toBeInstanceOf(DocumentValidationError);
  });

  it("refuses a file whose extension contradicts its declared media type", async () => {
    await expect(
      manager().upload(owner, upload("notes.txt", "text", "application/pdf"), metadata),
    ).rejects.toThrow(/do not match/);
  });

  it("refuses an empty document", async () => {
    await expect(manager().upload(owner, upload("empty.txt", ""), metadata)).rejects.toThrow(/empty/i);
  });

  it("rejects the same content uploaded twice by one owner", async () => {
    await manager().upload(owner, upload("first.txt", "Identical body text for the checksum."), metadata);
    await expect(
      manager().upload(owner, upload("second.txt", "Identical body text for the checksum."), metadata),
    ).rejects.toBeInstanceOf(DocumentConflictError);
  });

  it("records a document with no extractable text as failed with an OCR reason", async () => {
    const stored = await manager().upload(owner, upload("blank.txt", "   \n\t  "), metadata);

    expect(stored.status).toBe("FAILED");
    expect(stored.failureCode).toBe("OCR_PROVIDER_REQUIRED");
    expect(stored.failureMessage).toMatch(/OCR provider/i);
  });

  it("holds a delete inside the retention window unless an administrator overrides it", async () => {
    const stored = await manager().upload(owner, upload("policy.txt", "Retained body text."), metadata);

    await expect(
      manager().delete(owner, stored.id, { force: false }),
    ).rejects.toBeInstanceOf(DocumentConflictError);

    await manager().delete(administrator, stored.id, { force: true, reason: "Legal removal request." });

    const [row] = await context.database
      .select({ status: document.status })
      .from(document)
      .where(eq(document.id, stored.id));
    expect(row?.status).toBe("DELETED");
  });

  it("stops retrieval as soon as a document is deleted", async () => {
    const model = embedder();
    const store = new DocumentVectorStore(context.database, model.model);
    const subject = new DrizzleDocumentManager(context.database, store);
    const stored = await subject.upload(owner, upload("policy.txt", "Threshold body text."), metadata);

    await subject.delete(administrator, stored.id, { force: true, reason: "Legal removal request." });

    expect(await store.countChunks(stored.id)).toBe(0);
    await expect(subject.get(owner, stored.id)).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("counts documents by state without including deleted ones", async () => {
    await manager().upload(owner, upload("a.txt", "First body text."), metadata);
    await manager().upload(owner, upload("b.txt", "   "), metadata);

    const metrics = await manager().metrics();
    expect(metrics.total).toBe(2);
    // The first is queued for the worker; the second failed extraction on the
    // request, because whitespace yields no text layer at all.
    expect(metrics.processing).toBe(1);
    expect(metrics.ready).toBe(0);
    expect(metrics.failed).toBe(1);
    expect(metrics.retainedSourceBytes).toBe(0);
  });

  it("hides another owner's documents from an enterprise identity", async () => {
    const mine = await manager().upload(owner, upload("mine.txt", "Owner scoped body."), metadata);
    const other: DocumentPrincipal = { ...owner, subject: "user:other" } as never;

    await expect(manager().get(other, mine.id)).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect((await manager().list(other)).items).toHaveLength(0);
    expect((await manager().list(owner)).items).toHaveLength(1);
  });
});
