import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { createTestDatabase, document, documentChunk, type TestDatabase } from "@orcasynapse/database";
import { APPROVED_EMBEDDING_DIMENSIONS, DocumentVectorStore, type TextEmbedder } from "@orcasynapse/knowledge";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleDocumentManager } from "./drizzle-document-manager.js";
import { type DocumentPrincipal } from "./document-manager.js";

/**
 * The binary formats the product advertises, proven at the upload boundary.
 *
 * Since v0.6.0 the API extracts synchronously and queues the text; the
 * worker embeds it. These tests own the extraction half — that a real PDF is
 * parsed, accepted and queued, and that a broken one is refused on the request
 * rather than poisoning the queue. The embedding half lives in the worker's
 * document-ingestor tests.
 */

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const owner: DocumentPrincipal = {
  id: randomUUID(),
  subject: "user:pilot",
  identityMode: "ENTERPRISE",
  scopes: [],
} as never;

const metadata = { classification: "CONFIDENTIAL", retentionDays: 30 } as never;

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

/**
 * A structurally valid PDF with a real text layer, built here rather than
 * committed as a binary fixture so the bytes under test stay reviewable.
 */
function pdfBytes(pages: readonly string[]): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, index) => {
    const content = `BT /F1 14 Tf 72 720 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function upload(fileName: string, bytes: Buffer, declared: string) {
  return {
    fileName,
    declaredMediaType: declared,
    stream: Readable.from([bytes]) as never,
  };
}

describe("PDF ingestion", () => {
  it("extracts a PDF and queues its text without blocking on the model", async () => {
    const stored = await manager().upload(
      owner,
      upload("retention.pdf", pdfBytes([
        "OrcaSynapse retention policy: captured memories expire after 365 days.",
        "The approved inference threshold is ten concurrent requests.",
      ]), "application/pdf"),
      metadata,
    );

    // QUEUED, not READY: the caller gets their answer before embedding starts.
    expect(stored.status).toBe("QUEUED");
    expect(stored.mediaType).toBe("application/pdf");
    expect(stored.failureCode).toBeNull();

    const [queued] = await context.database
      .select({ pendingText: document.pendingText, attempts: document.ingestionAttempts })
      .from(document)
      .where(eq(document.id, stored.id));

    // Text from both pages survived extraction and is waiting for the worker.
    expect(queued?.pendingText).toContain("expire after 365 days");
    expect(queued?.pendingText).toContain("ten concurrent requests");
    expect(queued?.attempts).toBe(0);

    // Nothing is embedded yet; that is the worker's job.
    expect(await context.database
      .select({ id: documentChunk.id })
      .from(documentChunk)
      .where(eq(documentChunk.documentId, stored.id))).toHaveLength(0);
  });

  it("records the real byte size, which PDF extraction destroys if read too late", async () => {
    // pdf.js takes ownership of the typed array it is handed and detaches the
    // underlying ArrayBuffer, so byteLength reads 0 once extraction has run.
    // v0.6.0 moved extraction ahead of the insert and recorded every PDF as
    // 0 bytes; the size has to be captured before the bytes are handed over.
    const bytes = pdfBytes(["Sizing check: this document has a genuine byte length."]);
    expect(bytes.byteLength).toBeGreaterThan(0);

    const stored = await manager().upload(
      owner,
      upload("sized.pdf", bytes, "application/pdf"),
      metadata,
    );

    expect(stored.sizeBytes).toBe(bytes.byteLength);
    expect(stored.sizeBytes).toBeGreaterThan(0);
  });

  it("records a scanned PDF as failed with an OCR reason rather than queueing nothing", async () => {
    // A page with no text operators is what a scan looks like after extraction.
    const stored = await manager().upload(
      owner,
      upload("scan.pdf", pdfBytes([""]), "application/pdf"),
      metadata,
    );

    // Extraction failures are still synchronous: the caller learns immediately
    // rather than discovering it minutes later in a queue.
    expect(stored.status).toBe("FAILED");
    expect(stored.failureCode).toBe("OCR_PROVIDER_REQUIRED");
    expect(await context.database
      .select({ id: documentChunk.id })
      .from(documentChunk)
      .where(eq(documentChunk.documentId, stored.id))).toHaveLength(0);
  });

  it("refuses a .pdf name whose bytes are not a PDF instead of storing an empty index", async () => {
    const stored = await manager().upload(
      owner,
      upload("broken.pdf", Buffer.from("this is plain text pretending to be a PDF"), "application/pdf"),
      metadata,
    );

    expect(stored.status).toBe("FAILED");
    expect(stored.failureCode).toBe("EXTRACTION_FAILED");
  });
});
