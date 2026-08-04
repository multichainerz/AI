import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type {
  DocumentDetail,
  DocumentList,
  DocumentMetrics,
  DocumentStatus,
  DocumentSummary,
  DocumentUploadMetadata,
} from "@orcasynapse/contracts";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { auditEvent, document, type OrcaSynapseDatabase } from "@orcasynapse/database";
import {
  ExtractionFailedError,
  TextLayerMissingError,
  UnsupportedDocumentError,
  extractionFormatFor,
  ingestDocument,
  type DocumentVectorStore,
  type TextEmbedder,
} from "@orcasynapse/knowledge";
import {
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentStorageError,
  DocumentValidationError,
  type DocumentManager,
  type DocumentPrincipal,
  type DocumentUpload,
} from "./document-manager.js";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Extension to media type for the formats OrcaSynapse can extract locally.
 *
 * Images are deliberately absent. Retrieval is text-only, so accepting an image
 * would store a document that can never be searched; the upload is refused with
 * a precise reason instead.
 */
const SUPPORTED_MEDIA_TYPES = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".html", "text/html"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

type StoredDocument = typeof document.$inferSelect;

function summaryDto(stored: StoredDocument): DocumentSummary {
  return {
    id: stored.id,
    fileName: stored.fileName,
    mediaType: stored.mediaType,
    sizeBytes: Number(stored.sizeBytes),
    sha256: stored.sha256,
    classification: stored.classification,
    status: stored.status,
    failureCode: stored.failureCode,
    failureMessage: stored.failureMessage,
    retentionUntil: stored.retentionUntil.toISOString(),
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
    completedAt: stored.completedAt?.toISOString() ?? null,
  };
}

function cleanFileName(value: string): string {
  const cleaned = basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > 255) throw new DocumentValidationError("File name is invalid.");
  return cleaned;
}

function mediaTypeFor(fileName: string, declared: string): string {
  const expected = SUPPORTED_MEDIA_TYPES.get(extname(fileName).toLowerCase());
  if (!expected) {
    throw new DocumentValidationError(
      "Use TXT, Markdown, HTML, CSV, JSON, PDF, DOCX, PPTX, or XLSX. Retrieval indexes extracted text, so image formats cannot be searched and are not accepted.",
    );
  }
  if (!extractionFormatFor(expected)) {
    throw new DocumentValidationError("OrcaSynapse cannot extract text from this format.");
  }
  const normalized = declared.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream" && normalized !== expected) {
    throw new DocumentValidationError("The file extension and declared media type do not match.");
  }
  return expected;
}

function visibility(principal: DocumentPrincipal) {
  return principal.identityMode === "ENTERPRISE"
    ? [eq(document.ownerSubject, principal.subject)]
    : [];
}

/**
 * Buffers the upload with a hard ceiling.
 *
 * The bytes exist only for the duration of this call: they are extracted,
 * embedded and discarded. Nothing writes them to disk, and only derived text
 * and vectors are persisted.
 */
async function readBounded(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const chunks: Uint8Array[] = [];
  const digest = createHash("sha256");
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new DocumentValidationError("Document exceeds the 50 MB upload limit.");
    }
    digest.update(chunk);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, sha256: digest.digest("hex") };
}

export class DrizzleDocumentManager implements DocumentManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly vectors: DocumentVectorStore,
    private readonly embedder: TextEmbedder,
  ) {}

  async list(principal: DocumentPrincipal): Promise<DocumentList> {
    const documents = await this.database
      .select()
      .from(document)
      .where(and(...visibility(principal), ne(document.status, "DELETED")))
      .orderBy(desc(document.updatedAt))
      .limit(200);
    return { items: documents.map(summaryDto) };
  }

  async get(principal: DocumentPrincipal, documentId: string): Promise<DocumentDetail> {
    const [stored] = await this.database
      .select()
      .from(document)
      .where(and(eq(document.id, documentId), ...visibility(principal), ne(document.status, "DELETED")))
      .limit(1);
    if (!stored) throw new DocumentNotFoundError();
    return summaryDto(stored);
  }

  async upload(
    principal: DocumentPrincipal,
    upload: DocumentUpload,
    metadata: DocumentUploadMetadata,
  ): Promise<DocumentDetail> {
    const fileName = cleanFileName(upload.fileName);
    const mediaType = mediaTypeFor(fileName, upload.declaredMediaType);
    const id = randomUUID();

    const { bytes, sha256 } = await readBounded(upload.stream, MAX_UPLOAD_BYTES);
    if (bytes.byteLength === 0) throw new DocumentValidationError("Document is empty.");

    const [duplicate] = await this.database
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          eq(document.ownerSubject, principal.subject),
          eq(document.sha256, sha256),
          ne(document.status, "DELETED"),
        ),
      )
      .limit(1);
    if (duplicate) throw new DocumentConflictError("The same document is already present in your workspace.");

    const now = new Date();
    const retentionUntil = new Date(now.getTime() + metadata.retentionDays * 24 * 60 * 60 * 1_000);

    // The metadata row is written first so a failed extraction is visible in the
    // dashboard with its reason, rather than the upload vanishing silently.
    const [created] = await this.database
      .insert(document)
      .values({
        id,
        ownerSubject: principal.subject,
        fileName,
        mediaType,
        sizeBytes: bytes.byteLength,
        sha256,
        classification: metadata.classification,
        status: "CONVERTING",
        retentionUntil,
      })
      .returning();
    if (!created) throw new DocumentStorageError("The document record could not be created.");

    try {
      const result = await ingestDocument(this.vectors, this.embedder, {
        documentId: id,
        ownerSubject: principal.subject,
        mediaType,
        bytes,
      });

      const [ready] = await this.database
        .update(document)
        .set({ status: "READY", completedAt: new Date(), failureCode: null, failureMessage: null })
        .where(eq(document.id, id))
        .returning();

      await this.database.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "document.indexed_locally",
        resourceType: "Document",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: {
          fileName,
          mediaType,
          sizeBytes: bytes.byteLength,
          classification: metadata.classification,
          chunks: result.chunks,
          embeddingModel: result.embeddingModel,
          retainedSourceBytes: 0,
        },
      });
      return summaryDto(ready ?? created);
    } catch (error) {
      const { code, message } = this.failure(error);
      const [failed] = await this.database
        .update(document)
        .set({ status: "FAILED", failureCode: code, failureMessage: message.slice(0, 500) })
        .where(eq(document.id, id))
        .returning();
      await this.vectors.deleteDocumentChunks(id).catch(() => undefined);
      await this.database.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "document.indexing_failed",
        resourceType: "Document",
        resourceId: id,
        outcome: "FAILURE",
        metadata: { fileName, mediaType, failureCode: code, retainedSourceBytes: 0 },
      });
      if (error instanceof DocumentValidationError) throw error;
      return summaryDto(failed ?? created);
    }
  }

  private failure(error: unknown): { code: string; message: string } {
    if (error instanceof TextLayerMissingError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof UnsupportedDocumentError || error instanceof ExtractionFailedError) {
      return { code: error.code, message: error.message };
    }
    return {
      code: "INDEXING_FAILED",
      message:
        error instanceof Error
          ? `OrcaSynapse could not index this document: ${error.message}`
          : "OrcaSynapse could not index this document.",
    };
  }

  async delete(
    principal: DocumentPrincipal,
    documentId: string,
    options: { force: boolean; reason?: string | undefined },
  ): Promise<void> {
    const [stored] = await this.database
      .select()
      .from(document)
      .where(and(eq(document.id, documentId), ...visibility(principal), ne(document.status, "DELETED")))
      .limit(1);
    if (!stored) throw new DocumentNotFoundError();

    const beforeRetention = stored.retentionUntil > new Date();
    const mayOverride =
      principal.identityMode === "ADMINISTRATOR_PREVIEW"
      && principal.scopes.includes("documents:delete")
      && options.force
      && (options.reason?.trim().length ?? 0) >= 3;
    if (beforeRetention && !mayOverride) {
      throw new DocumentConflictError(
        "The document is still inside its retention period. An administrator must record an override reason.",
      );
    }

    await this.database.transaction(async (transaction) => {
      // Chunks cascade from the document row, but they are removed explicitly so
      // retrieval stops immediately even though the metadata row is retained.
      await this.vectors.deleteDocumentChunks(documentId);
      await transaction
        .update(document)
        .set({ status: "DELETED", deletedAt: new Date(), failureCode: null, failureMessage: null })
        .where(eq(document.id, documentId));
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "document.deleted",
        resourceType: "Document",
        resourceId: documentId,
        outcome: "SUCCESS",
        metadata: { force: options.force, reason: options.reason ?? null, retainedSourceBytes: 0 },
      });
    });
  }

  async metrics(): Promise<DocumentMetrics> {
    const grouped = await this.database
      .select({ status: document.status, total: sql<number>`count(*)::int` })
      .from(document)
      .where(ne(document.status, "DELETED"))
      .groupBy(document.status);

    const count = (statuses: DocumentStatus[]) =>
      grouped.filter((item) => statuses.includes(item.status)).reduce((total, item) => total + item.total, 0);

    return {
      generatedAt: new Date().toISOString(),
      total: grouped.reduce((total, item) => total + item.total, 0),
      processing: count(["QUEUED", "CONVERTING"]),
      ready: count(["READY"]),
      failed: count(["FAILED", "REJECTED"]),
      retainedSourceBytes: 0,
    };
  }
}
