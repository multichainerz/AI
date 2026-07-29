import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  DocumentArtifact,
  DocumentDetail,
  DocumentList,
  DocumentMetrics,
  DocumentSummary,
  DocumentUploadMetadata,
  QuarantineDecision,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import { SeaweedDocumentStore } from "@aihub/document-runtime";
import type { PgBossQueueService } from "@aihub/jobs";
import {
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentStorageError,
  DocumentValidationError,
  type DocumentDownload,
  type DocumentManager,
  type DocumentPrincipal,
  type DocumentUpload,
} from "./document-manager.js";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;

interface StoredArtifact {
  id: string;
  kind: DocumentArtifact["kind"];
  pageNumber: number;
  objectKey: string;
  mediaType: string;
  sizeBytes: bigint;
  sha256: string;
  createdAt: Date;
}

interface StoredDocument {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: bigint;
  sha256: string;
  classification: DocumentSummary["classification"];
  status: DocumentSummary["status"];
  pageCount: number | null;
  processingGeneration: number;
  normalizedText: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  retentionUntil: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  artifacts?: StoredArtifact[];
}

function artifactDto(artifact: StoredArtifact): DocumentArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    pageNumber: artifact.pageNumber === 0 ? null : artifact.pageNumber,
    mediaType: artifact.mediaType,
    sizeBytes: Number(artifact.sizeBytes),
    sha256: artifact.sha256,
    createdAt: artifact.createdAt.toISOString(),
  };
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
    pageCount: document.pageCount,
    processingGeneration: document.processingGeneration,
    failureCode: document.failureCode,
    failureMessage: document.failureMessage,
    retentionUntil: document.retentionUntil.toISOString(),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    completedAt: document.completedAt?.toISOString() ?? null,
  };
}

function detailDto(document: StoredDocument): DocumentDetail {
  return {
    ...summaryDto(document),
    textPreview: document.normalizedText?.slice(0, 4_000) ?? null,
    artifacts: (document.artifacts ?? []).map(artifactDto),
  };
}

function cleanFileName(value: string): string {
  const cleaned = basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > 255) throw new DocumentValidationError("File name is invalid.");
  return cleaned;
}

function begins(value: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => value[index] === byte);
}

function detectedMediaType(sniff: Uint8Array, fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  if (begins(sniff, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (begins(sniff, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (begins(sniff, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (begins(sniff, [0x50, 0x4b, 0x03, 0x04])) {
    const office: Record<string, string> = {
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    if (office[extension]) return office[extension];
  }
  if (extension === ".txt" && !sniff.includes(0)) return "text/plain";
  throw new DocumentValidationError("Supported files are PDF, PNG, JPEG, TXT, DOCX, XLSX, and PPTX.");
}

function visibility(principal: DocumentPrincipal) {
  return principal.identityMode === "ENTERPRISE" ? { ownerSubject: principal.subject } : {};
}

export class PrismaDocumentManager implements DocumentManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly store: SeaweedDocumentStore,
    private readonly queue: PgBossQueueService,
  ) {}

  async list(principal: DocumentPrincipal): Promise<DocumentList> {
    const documents = await this.prisma.document.findMany({
      where: { ...visibility(principal), status: { not: "DELETED" } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    return { items: documents.map((document) => summaryDto(document as StoredDocument)) };
  }

  async get(principal: DocumentPrincipal, documentId: string): Promise<DocumentDetail> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ...visibility(principal), status: { not: "DELETED" } },
      include: { artifacts: { orderBy: [{ kind: "asc" }, { pageNumber: "asc" }] } },
    });
    if (!document) throw new DocumentNotFoundError();
    return detailDto(document as StoredDocument);
  }

  async upload(
    principal: DocumentPrincipal,
    upload: DocumentUpload,
    metadata: DocumentUploadMetadata,
  ): Promise<DocumentDetail> {
    const fileName = cleanFileName(upload.fileName);
    const id = randomUUID();
    const root = await mkdtemp(join(tmpdir(), "aihub-upload-"));
    const path = join(root, "upload.bin");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const sniffChunks: Buffer[] = [];
    let sniffSize = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > MAX_UPLOAD_BYTES) {
          callback(new DocumentValidationError("Document exceeds the 50 MB upload limit."));
          return;
        }
        hash.update(chunk);
        if (sniffSize < SNIFF_BYTES) {
          const selected = chunk.subarray(0, Math.min(chunk.length, SNIFF_BYTES - sniffSize));
          sniffChunks.push(selected);
          sniffSize += selected.length;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(upload.stream, meter, createWriteStream(path, { flags: "wx" }));
      if (sizeBytes === 0) throw new DocumentValidationError("Document is empty.");
      const mediaType = detectedMediaType(Buffer.concat(sniffChunks), fileName);
      const digest = hash.digest("hex");
      const duplicate = await this.prisma.document.findFirst({
        where: {
          ownerSubject: principal.subject,
          sha256: digest,
          status: { notIn: ["DELETED", "REJECTED"] },
        },
        select: { id: true },
      });
      if (duplicate) throw new DocumentConflictError("The same document is already present in your workspace.");
      const objectKey = `quarantine/${id}/original/${encodeURIComponent(fileName)}`;
      try {
        await this.store.putFile(objectKey, path, mediaType, sizeBytes);
      } catch {
        throw new DocumentStorageError("AIHub could not store the document in SeaweedFS.");
      }
      const retentionUntil = new Date(Date.now() + metadata.retentionDays * 24 * 60 * 60 * 1_000);
      try {
        const created = await this.prisma.$transaction(async (transaction) => {
          const document = await transaction.document.create({
            data: {
              id,
              ownerSubject: principal.subject,
              fileName,
              mediaType,
              sizeBytes,
              sha256: digest,
              classification: metadata.classification,
              originalObjectKey: objectKey,
              retentionUntil,
              artifacts: {
                create: {
                  kind: "ORIGINAL",
                  pageNumber: 0,
                  objectKey,
                  mediaType,
                  sizeBytes,
                  sha256: digest,
                },
              },
            },
            include: { artifacts: true },
          });
          await transaction.auditEvent.create({
            data: {
              actorType: "USER",
              actorId: principal.id,
              action: "document.uploaded_to_quarantine",
              resourceType: "Document",
              resourceId: id,
              outcome: "SUCCESS",
              metadata: { fileName, mediaType, sizeBytes, classification: metadata.classification },
            },
          });
          return document;
        });
        return detailDto(created as StoredDocument);
      } catch (error) {
        await this.store.delete([objectKey]).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async decideQuarantine(
    principal: DocumentPrincipal,
    documentId: string,
    decision: QuarantineDecision,
  ): Promise<DocumentDetail> {
    if (decision.decision === "REJECT") {
      const updated = await this.prisma.$transaction(async (transaction) => {
        const changed = await transaction.document.updateMany({
          where: { id: documentId, status: "QUARANTINED" },
          data: { status: "REJECTED", failureCode: "QUARANTINE_REJECTED", failureMessage: decision.reason },
        });
        if (changed.count !== 1) throw new DocumentConflictError("Only quarantined documents can be reviewed.");
        await transaction.auditEvent.create({
          data: {
            actorType: "USER",
            actorId: principal.id,
            action: "document.quarantine_rejected",
            resourceType: "Document",
            resourceId: documentId,
            outcome: "SUCCESS",
            metadata: { reason: decision.reason },
          },
        });
        return transaction.document.findUniqueOrThrow({ where: { id: documentId }, include: { artifacts: true } });
      });
      return detailDto(updated as StoredDocument);
    }
    return this.enqueue(principal, documentId, ["QUARANTINED"], decision.reason);
  }

  async reprocess(principal: DocumentPrincipal, documentId: string): Promise<DocumentDetail> {
    return this.enqueue(principal, documentId, ["FAILED", "READY"], "Manual reprocessing requested.");
  }

  async delete(
    principal: DocumentPrincipal,
    documentId: string,
    options: { force: boolean; reason?: string | undefined },
  ): Promise<void> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ...visibility(principal), status: { not: "DELETED" } },
      include: {
        artifacts: { select: { objectKey: true } },
        memoryPublication: { select: { status: true } },
      },
    });
    if (!document) throw new DocumentNotFoundError();
    if (["QUEUED", "CONVERTING", "OCR_PENDING", "OCR_PROCESSING", "DELETING"].includes(document.status)) {
      throw new DocumentConflictError("A document cannot be deleted while processing is active.");
    }
    if (document.memoryPublication && ["QUEUED", "PROCESSING", "DELETE_PENDING"].includes(document.memoryPublication.status)) {
      throw new DocumentConflictError("Wait for active memory synchronization to finish before deleting this document.");
    }
    const forceAllowed = principal.identityMode === "ADMINISTRATOR_PREVIEW" &&
      principal.scopes.includes("documents:delete") && options.force && (options.reason?.trim().length ?? 0) >= 3;
    if (document.retentionUntil > new Date() && !forceAllowed) {
      throw new DocumentConflictError("Document retention has not expired. An authorized forced deletion requires a reason.");
    }
    await this.prisma.document.update({ where: { id: documentId }, data: { status: "DELETING" } });
    const keys = [...new Set([document.originalObjectKey, ...document.artifacts.map(({ objectKey }) => objectKey)])];
    try {
      await this.store.delete(keys);
    } catch {
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: "FAILED", failureCode: "DELETE_FAILED", failureMessage: "SeaweedFS object deletion failed." },
      });
      throw new DocumentStorageError("AIHub could not delete every managed document object.");
    }
    await this.prisma.$transaction([
      this.prisma.documentArtifact.deleteMany({ where: { documentId } }),
      this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: "DELETED",
          deletedAt: new Date(),
          normalizedText: null,
          normalizedMarkdown: null,
          ocrMetadata: Prisma.DbNull,
          failureCode: null,
          failureMessage: null,
        },
      }),
      this.prisma.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: principal.id,
          action: forceAllowed ? "document.force_deleted" : "document.deleted",
          resourceType: "Document",
          resourceId: documentId,
          outcome: "SUCCESS",
          metadata: { objectCount: keys.length, reason: options.reason ?? null },
        },
      }),
    ]);
    await this.scheduleMemoryDeletion(documentId);
  }

  async download(
    principal: DocumentPrincipal,
    documentId: string,
    artifactId: string,
  ): Promise<DocumentDownload> {
    const artifact = await this.prisma.documentArtifact.findFirst({
      where: {
        id: artifactId,
        documentId,
        document: { ...visibility(principal), status: { not: "DELETED" } },
      },
      include: { document: { select: { fileName: true } } },
    });
    if (!artifact) throw new DocumentNotFoundError();
    const bytes = await this.store.getBuffer(artifact.objectKey);
    const extension = artifact.kind === "OCR_TEXT" ? ".txt" : artifact.kind === "OCR_MARKDOWN" ? ".md" : artifact.kind === "OCR_JSON" ? ".json" : "";
    return {
      bytes,
      mediaType: artifact.mediaType,
      fileName: artifact.kind === "ORIGINAL" ? artifact.document.fileName : `${artifact.document.fileName}${extension}`,
    };
  }

  async metrics(): Promise<DocumentMetrics> {
    const [groups, aggregate, artifactStorage] = await Promise.all([
      this.prisma.document.groupBy({
        by: ["status"],
        where: { status: { not: "DELETED" } },
        _count: { _all: true },
      }),
      this.prisma.document.aggregate({
        where: { status: { not: "DELETED" } },
        _count: { _all: true },
      }),
      this.prisma.documentArtifact.aggregate({
        where: { document: { status: { not: "DELETED" } } },
        _sum: { sizeBytes: true },
      }),
    ]);
    const count = (statuses: string[]) => groups
      .filter(({ status }) => statuses.includes(status))
      .reduce((sum, item) => sum + item._count._all, 0);
    return {
      generatedAt: new Date().toISOString(),
      total: aggregate._count._all,
      quarantined: count(["QUARANTINED"]),
      processing: count(["QUEUED", "CONVERTING", "OCR_PENDING", "OCR_PROCESSING"]),
      ready: count(["READY"]),
      failed: count(["FAILED"]),
      rejected: count(["REJECTED"]),
      storedBytes: Number(artifactStorage._sum.sizeBytes ?? 0),
    };
  }

  private async enqueue(
    principal: DocumentPrincipal,
    documentId: string,
    allowedStatuses: Array<"QUARANTINED" | "FAILED" | "READY">,
    reason: string,
  ): Promise<DocumentDetail> {
    const prepared = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.document.findFirst({
        where: { id: documentId, ...visibility(principal), status: { in: allowedStatuses } },
      });
      if (!current) throw new DocumentConflictError("The document is not eligible for this processing action.");
      const generation = current.processingGeneration + 1;
      const claimed = await transaction.document.updateMany({
        where: { id: documentId, processingGeneration: current.processingGeneration, status: current.status },
        data: {
          status: "QUEUED",
          processingGeneration: generation,
          approvedAt: current.approvedAt ?? new Date(),
          approvedBy: current.approvedBy ?? principal.id,
          normalizedText: null,
          normalizedMarkdown: null,
          ocrMetadata: Prisma.DbNull,
          failureCode: null,
          failureMessage: null,
          completedAt: null,
        },
      });
      if (claimed.count !== 1) throw new DocumentConflictError("The document changed while processing was requested.");
      await transaction.documentProcessingRun.create({ data: { documentId, generation } });
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: principal.id,
          action: current.status === "QUARANTINED" ? "document.quarantine_approved" : "document.reprocess_requested",
          resourceType: "Document",
          resourceId: documentId,
          outcome: "SUCCESS",
          metadata: { generation, reason },
        },
      });
      return { generation };
    });
    try {
      const jobId = await this.queue.sendDocumentConversion({ documentId, generation: prepared.generation });
      await this.prisma.documentProcessingRun.update({
        where: { documentId_generation: { documentId, generation: prepared.generation } },
        data: { conversionJobId: jobId },
      });
    } catch {
      await this.prisma.$transaction([
        this.prisma.document.update({
          where: { id: documentId },
          data: { status: "FAILED", failureCode: "QUEUE_SUBMISSION_FAILED", failureMessage: "Document processing could not be queued." },
        }),
        this.prisma.documentProcessingRun.update({
          where: { documentId_generation: { documentId, generation: prepared.generation } },
          data: { failedAt: new Date(), failureCode: "QUEUE_SUBMISSION_FAILED" },
        }),
      ]);
      throw new DocumentStorageError("Document processing could not be queued.");
    }
    return this.get(principal, documentId);
  }

  private async scheduleMemoryDeletion(documentId: string): Promise<void> {
    const publication = await this.prisma.documentMemoryPublication.findUnique({
      where: { documentId },
      select: { generation: true },
    });
    if (!publication) return;
    try {
      await this.prisma.documentMemoryPublication.update({
        where: { documentId },
        data: {
          status: "DELETE_PENDING",
          failureCode: null,
          failureMessage: null,
          queuedAt: new Date(),
        },
      });
      const jobId = await this.queue.sendMemoryIndex({
        documentId,
        generation: publication.generation,
        action: "DELETE",
      });
      await this.prisma.documentMemoryPublication.update({
        where: { documentId },
        data: { jobId },
      });
    } catch (error) {
      await this.prisma.documentMemoryPublication.updateMany({
        where: { documentId },
        data: {
          status: "FAILED",
          failureCode: "MEMORY_DELETE_QUEUE_FAILED",
          failureMessage: error instanceof Error ? error.message.slice(0, 500) : "Memory deletion could not be queued.",
        },
      }).catch(() => undefined);
    }
  }
}
