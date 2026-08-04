import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { createTestDatabase, documentChunk, type TestDatabase } from "@orcasynapse/database";
import { APPROVED_EMBEDDING_DIMENSIONS, DocumentVectorStore, type TextEmbedder } from "@orcasynapse/knowledge";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleDocumentManager } from "./drizzle-document-manager.js";
import { type DocumentPrincipal } from "./document-manager.js";

/**
 * The binary formats the product advertises, proven end to end.
 *
 * Every other document test uploads UTF-8 text, so the PDF path — extraction
 * through unpdf, then chunking, embedding and the pgvector write — was wired up
 * but never exercised. A dependency bump could have broken it silently.
 */

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
    model,
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
  it("extracts, chunks, embeds and stores a PDF without any operator step", async () => {
    const stored = await manager().upload(
      owner,
      upload("retention.pdf", pdfBytes([
        "OrcaSynapse retention policy: captured memories expire after 365 days.",
        "The approved inference threshold is ten concurrent requests.",
      ]), "application/pdf"),
      metadata,
    );

    expect(stored.status).toBe("READY");
    expect(stored.mediaType).toBe("application/pdf");
    expect(stored.failureCode).toBeNull();

    // The vectors are rows in this installation's own pgvector table.
    const chunks = await context.database
      .select({ content: documentChunk.content, model: documentChunk.embeddingModel, embedding: documentChunk.embedding })
      .from(documentChunk)
      .where(and(eq(documentChunk.documentId, stored.id), eq(documentChunk.ownerSubject, owner.subject)));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.model).toBe("Xenova/bge-m3");
    expect(chunks[0]?.embedding).toHaveLength(APPROVED_EMBEDDING_DIMENSIONS);
    // Text from both pages survived extraction.
    const text = chunks.map(({ content }) => content).join("\n");
    expect(text).toContain("expire after 365 days");
    expect(text).toContain("ten concurrent requests");
  });

  it("makes a PDF retrievable inside the owner boundary and invisible outside it", async () => {
    const model = embedder();
    const store = new DocumentVectorStore(context.database, model.model);
    const stored = await manager(model).upload(
      owner,
      upload("threshold.pdf", pdfBytes(["The approved operations threshold is ten."]), "application/pdf"),
      metadata,
    );

    const [query] = await model.embed(["threshold"]);
    const mine = await store.search(owner.subject, "threshold", query!, { limit: 10, minimumScore: -1 });
    expect(mine.map(({ documentId }) => documentId)).toContain(stored.id);

    const theirs = await store.search("user:someone-else", "threshold", query!, { limit: 10, minimumScore: -1 });
    expect(theirs).toHaveLength(0);
  });

  it("records a scanned PDF as failed with an OCR reason rather than indexing nothing", async () => {
    // A page with no text operators is what a scan looks like after extraction.
    const stored = await manager().upload(
      owner,
      upload("scan.pdf", pdfBytes([""]), "application/pdf"),
      metadata,
    );

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
