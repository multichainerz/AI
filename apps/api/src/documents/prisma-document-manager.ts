import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type {
  DocumentDetail,
  DocumentList,
  DocumentMetrics,
  DocumentStatus,
  DocumentSummary,
  DocumentUploadMetadata,
} from "@orcasynapse/contracts";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import {
  knowledgeScopeTag,
  SupermemoryClient,
  SupermemoryUploadTooLargeError,
  type SupermemoryDocumentState,
} from "@orcasynapse/document-runtime";
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
const SUPPORTED_MEDIA_TYPES = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".html", "text/html"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

interface StoredDocument {
  id: string;
  ownerSubject: string;
  fileName: string;
  mediaType: string;
  sizeBytes: bigint;
  sha256: string;
  classification: DocumentSummary["classification"];
  status: DocumentStatus;
  failureCode: string | null;
  failureMessage: string | null;
  retentionUntil: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  supermemoryProjection?: {
    externalDocumentId: string | null;
    status: "NOT_INDEXED" | "QUEUED" | "PROCESSING" | "READY" | "FAILED" | "DELETE_PENDING" | "DELETED";
  } | null;
}

function summaryDto(document: StoredDocument): DocumentSummary {
  return {
    id: document.id,
    fileName: document.fileName,
    mediaType: document.mediaType,
    sizeBytes: Number(document.sizeBytes),
    sha256: document.sha256,
    classification: document.classification,
    status: document.status,
    failureCode: document.failureCode,
    failureMessage: document.failureMessage,
    retentionUntil: document.retentionUntil.toISOString(),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    completedAt: document.completedAt?.toISOString() ?? null,
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
    throw new DocumentValidationError("Use TXT, Markdown, HTML, PDF, DOCX, PNG, JPEG, or WebP. Rich-file extraction depends on the installed Supermemory Local capabilities.");
  }
  const normalized = declared.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream" && normalized !== expected) {
    throw new DocumentValidationError("The file extension and declared media type do not match.");
  }
  return expected;
}

function visibility(principal: DocumentPrincipal): { ownerSubject?: string } {
  return principal.identityMode === "ENTERPRISE" ? { ownerSubject: principal.subject } : {};
}

function projectedStatus(status: string): DocumentStatus {
  if (status === "done") return "READY";
  if (status === "failed") return "FAILED";
  return "QUEUED";
}

function memoryStatus(status: DocumentStatus): "QUEUED" | "READY" | "FAILED" {
  if (status === "READY") return "READY";
  if (status === "FAILED") return "FAILED";
  return "QUEUED";
}

function extractionFailureMessage(document: StoredDocument, state: SupermemoryDocumentState): string {
  const version = state.runtimeVersion?.replace(/^v/, "") ?? null;
  if ((version === null || version === "0.0.5") && Number(document.sizeBytes) > 96 * 1024) {
    return `This file expands beyond the workflow-step limit used by ${version ? `Supermemory Local ${version}` : "older Supermemory Local releases"}. Upgrade or re-enroll VM2 with the supported 0.0.7-rc.2 release, then upload the authoritative file again.`;
  }
  if (state.failureReason) {
    return `Supermemory reported: ${state.failureReason} Review the VM2 Supermemory service log, correct the extractor configuration, then upload the authoritative file again.`;
  }
  if (["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(document.mediaType)) {
    return "Supermemory stopped before this document reached BGE-M3 embedding. Text-bearing PDF and DOCX extraction uses the configured local OpenAI-compatible chat model; BGE-M3 indexes the extracted text afterward. Scanned or image-heavy files require an optional Gemini or Vertex document-understanding provider. Review the VM2 Supermemory log, then upload the authoritative file again.";
  }
  if (document.mediaType.startsWith("image/")) {
    return "Supermemory stopped before this image reached BGE-M3 embedding. Image understanding requires an optional Gemini or Vertex provider; BGE-M3 only indexes text after extraction. Review the VM2 Supermemory log, then upload the authoritative file again.";
  }
  return "Supermemory could not process this source. Review the VM2 Supermemory service log and its local LLM compatibility, then upload the authoritative file again.";
}

export class PrismaDocumentManager implements DocumentManager {
  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly supermemory: SupermemoryClient,
  ) {}

  async list(principal: DocumentPrincipal): Promise<DocumentList> {
    const documents = await this.prisma.document.findMany({
      where: { ...visibility(principal), status: { not: "DELETED" } },
      include: { supermemoryProjection: { select: { externalDocumentId: true, status: true } } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const projected = await Promise.all(documents.map((document) => this.synchronize(document as StoredDocument)));
    return { items: projected.map(summaryDto) };
  }

  async get(principal: DocumentPrincipal, documentId: string): Promise<DocumentDetail> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ...visibility(principal), status: { not: "DELETED" } },
      include: { supermemoryProjection: { select: { externalDocumentId: true, status: true } } },
    });
    if (!document) throw new DocumentNotFoundError();
    return summaryDto(await this.synchronize(document as StoredDocument));
  }

  async upload(
    principal: DocumentPrincipal,
    upload: DocumentUpload,
    metadata: DocumentUploadMetadata,
  ): Promise<DocumentDetail> {
    const fileName = cleanFileName(upload.fileName);
    const mediaType = mediaTypeFor(fileName, upload.declaredMediaType);
    const id = randomUUID();
    let externalDocumentId: string | null = null;
    try {
      const result = await this.supermemory.uploadFile({
        documentId: id,
        ownerSubject: principal.subject,
        stream: upload.stream,
        fileName,
        mediaType,
        classification: metadata.classification,
        maximumBytes: MAX_UPLOAD_BYTES,
      });
      externalDocumentId = result.externalDocumentId;
      if (result.sizeBytes === 0) throw new DocumentValidationError("Document is empty.");

      const duplicate = await this.prisma.document.findFirst({
        where: {
          ownerSubject: principal.subject,
          sha256: result.sha256,
          status: { not: "DELETED" },
        },
        select: { id: true },
      });
      if (duplicate) throw new DocumentConflictError("The same document is already present in your workspace.");

      const status = projectedStatus(result.status);
      const now = new Date();
      const retentionUntil = new Date(now.getTime() + metadata.retentionDays * 24 * 60 * 60 * 1_000);
      const created = await this.prisma.$transaction(async (transaction) => {
        const document = await transaction.document.create({
          data: {
            id,
            ownerSubject: principal.subject,
            fileName,
            mediaType,
            sizeBytes: result.sizeBytes,
            sha256: result.sha256,
            classification: metadata.classification,
            status,
            retentionUntil,
            completedAt: status === "READY" ? now : null,
            supermemoryProjection: {
              create: {
                ownerSubject: principal.subject,
                scopeTag: knowledgeScopeTag(principal.subject),
                status: memoryStatus(status),
                externalDocumentId,
                queuedAt: now,
                syncedAt: status === "READY" ? now : null,
                ...(status === "FAILED" ? {
                  failureCode: "SUPERMEMORY_PROCESSING_FAILED",
                  failureMessage: "Supermemory could not process the uploaded source.",
                } : {}),
              },
            },
          },
          include: { supermemoryProjection: { select: { externalDocumentId: true, status: true } } },
        });
        await transaction.auditEvent.create({
          data: {
            actorType: "USER",
            actorId: principal.id,
            action: "document.streamed_to_supermemory",
            resourceType: "Document",
            resourceId: id,
            outcome: "SUCCESS",
            metadata: {
              fileName,
              mediaType,
              sizeBytes: result.sizeBytes,
              classification: metadata.classification,
              externalDocumentId,
              retainedSourceBytes: 0,
            },
          },
        });
        return document;
      });
      return summaryDto(created as StoredDocument);
    } catch (error) {
      if (externalDocumentId) await this.supermemory.delete(id, externalDocumentId).catch(() => undefined);
      if (error instanceof SupermemoryUploadTooLargeError) {
        throw new DocumentValidationError("Document exceeds the 50 MB upload limit.");
      }
      if (error instanceof DocumentValidationError || error instanceof DocumentConflictError) throw error;
      throw new DocumentStorageError(error instanceof Error
        ? `Supermemory could not accept the document: ${error.message}`
        : "Supermemory could not accept the document.");
    }
  }

  async delete(
    principal: DocumentPrincipal,
    documentId: string,
    options: { force: boolean; reason?: string | undefined },
  ): Promise<void> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ...visibility(principal), status: { not: "DELETED" } },
      include: { supermemoryProjection: { select: { externalDocumentId: true } } },
    });
    if (!document) throw new DocumentNotFoundError();
    const beforeRetention = document.retentionUntil > new Date();
    const mayOverride = principal.identityMode === "ADMINISTRATOR_PREVIEW"
      && principal.scopes.includes("documents:delete")
      && options.force
      && (options.reason?.trim().length ?? 0) >= 3;
    if (beforeRetention && !mayOverride) {
      throw new DocumentConflictError("The document is still inside its retention period. An administrator must record an override reason.");
    }

    await this.supermemory.delete(documentId, document.supermemoryProjection?.externalDocumentId);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.document.update({
        where: { id: documentId },
        data: { status: "DELETED", deletedAt: new Date(), failureCode: null, failureMessage: null },
      });
      await transaction.supermemoryProjection.updateMany({
        where: { documentId },
        data: { status: "DELETED", deletedAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: principal.id,
          action: "document.deleted_from_supermemory",
          resourceType: "Document",
          resourceId: documentId,
          outcome: "SUCCESS",
          metadata: { force: options.force, reason: options.reason ?? null, retainedSourceBytes: 0 },
        },
      });
    });
  }

  async metrics(): Promise<DocumentMetrics> {
    const grouped = await this.prisma.document.groupBy({
      by: ["status"],
      where: { status: { not: "DELETED" } },
      _count: { _all: true },
    });
    const count = (statuses: DocumentStatus[]) => grouped
      .filter((item) => statuses.includes(item.status))
      .reduce((total, item) => total + item._count._all, 0);
    return {
      generatedAt: new Date().toISOString(),
      total: grouped.reduce((total, item) => total + item._count._all, 0),
      processing: count(["QUEUED", "CONVERTING"]),
      ready: count(["READY"]),
      failed: count(["FAILED", "REJECTED"]),
      retainedSourceBytes: 0,
    };
  }

  private async synchronize(document: StoredDocument): Promise<StoredDocument> {
    const legacyFailure = document.status === "FAILED"
      && document.failureCode === "SUPERMEMORY_PROCESSING_FAILED"
      && (!document.failureMessage || document.failureMessage.includes("installed Supermemory extractor"));
    if (!["QUEUED", "CONVERTING"].includes(document.status) && !legacyFailure) return document;
    const externalDocumentId = document.supermemoryProjection?.externalDocumentId;
    if (!externalDocumentId) return document;
    try {
      const state = await this.supermemory.documentState(externalDocumentId);
      if (legacyFailure && !["failed", "done"].includes(state.status)) return document;
      const status = projectedStatus(state.status);
      if (status === document.status && !legacyFailure) return document;
      const now = new Date();
      const failureCode = status === "FAILED" ? "SUPERMEMORY_PROCESSING_FAILED" : null;
      const failureMessage = status === "FAILED" ? extractionFailureMessage(document, state) : null;
      await this.prisma.$transaction([
        this.prisma.document.update({
          where: { id: document.id },
          data: { status, completedAt: status === "READY" ? now : null, failureCode, failureMessage },
        }),
        this.prisma.supermemoryProjection.update({
          where: { documentId: document.id },
          data: {
            status: memoryStatus(status),
            syncedAt: status === "READY" ? now : null,
            failureCode,
            failureMessage,
          },
        }),
      ]);
      return { ...document, status, completedAt: status === "READY" ? now : null, failureCode, failureMessage };
    } catch {
      return document;
    }
  }
}
