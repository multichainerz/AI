import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import type {
  DocumentDetail,
  DocumentList,
  DocumentMetrics,
  DocumentSummary,
  DocumentUploadMetadata,
  QuarantineDecision,
} from "@aihub/contracts";
import { type AIHubPrismaClient } from "@aihub/database";
import {
  DOCUMENT_SCRATCH_TTL_MS,
  documentOriginalKey,
  documentScratchPrefix,
  type DocumentScratchStore,
} from "@aihub/document-runtime";
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
const SNIFF_BYTES = 8 * 1024;

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
  failureCode: string | null;
  failureMessage: string | null;
  stagingKey: string | null;
  stagingExpiresAt: Date | null;
  stagingPurgedAt: Date | null;
  retentionUntil: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function canReprocess(document: StoredDocument): boolean {
  return document.status === "FAILED" &&
    document.stagingKey !== null &&
    document.stagingPurgedAt === null &&
    document.stagingExpiresAt !== null &&
    document.stagingExpiresAt > new Date();
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
    stagingExpiresAt: document.stagingExpiresAt?.toISOString() ?? null,
    stagingPurgedAt: document.stagingPurgedAt?.toISOString() ?? null,
    reprocessAvailable: canReprocess(document),
    retentionUntil: document.retentionUntil.toISOString(),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    completedAt: document.completedAt?.toISOString() ?? null,
  };
}

function detailDto(document: StoredDocument): DocumentDetail {
  return summaryDto(document);
}

function cleanFileName(value: string): string {
  const cleaned = basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > 255) throw new DocumentValidationError("File name is invalid.");
  return cleaned;
}

function detectedMediaType(sniff: Uint8Array, fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".txt" && !sniff.includes(0)) return "text/plain";
  throw new DocumentValidationError("This AIHub release accepts UTF-8 .txt documents only.");
}

function visibility(principal: DocumentPrincipal) {
  return principal.identityMode === "ENTERPRISE" ? { ownerSubject: principal.subject } : {};
}

export class PrismaDocumentManager implements DocumentManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly store: DocumentScratchStore,
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
    const stagingKey = documentOriginalKey(id);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const sniffChunks: Buffer[] = [];
    let sniffSize = 0;
    const measuredUpload = Readable.from((async function* () {
      for await (const value of upload.stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > MAX_UPLOAD_BYTES) {
          throw new DocumentValidationError("Document exceeds the 50 MB upload limit.");
        }
        hash.update(chunk);
        if (sniffSize < SNIFF_BYTES) {
          const selected = chunk.subarray(0, Math.min(chunk.length, SNIFF_BYTES - sniffSize));
          sniffChunks.push(selected);
          sniffSize += selected.length;
        }
        yield chunk;
      }
    })());
    try {
      try {
        await this.store.putStream(stagingKey, measuredUpload);
      } catch (error) {
        if (error instanceof DocumentValidationError) throw error;
        throw new DocumentStorageError("AIHub could not stage the document for transient processing.");
      }
      if (sizeBytes === 0) throw new DocumentValidationError("Document is empty.");
      const mediaType = detectedMediaType(Buffer.concat(sniffChunks), fileName);
      const digest = hash.digest("hex");
      const duplicate = await this.prisma.document.findFirst({
        where: {
          ownerSubject: principal.subject,
          sha256: digest,
          OR: [
            { status: { in: ["QUARANTINED", "QUEUED", "CONVERTING", "READY"] } },
            {
              status: "FAILED",
              stagingKey: { not: null },
              stagingPurgedAt: null,
              stagingExpiresAt: { gt: new Date() },
            },
          ],
        },
        select: { id: true },
      });
      if (duplicate) throw new DocumentConflictError("The same document is already present in your workspace.");
      const retentionUntil = new Date(Date.now() + metadata.retentionDays * 24 * 60 * 60 * 1_000);
      const stagingExpiresAt = new Date(Date.now() + DOCUMENT_SCRATCH_TTL_MS);
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
            stagingKey,
            stagingExpiresAt,
            retentionUntil,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorType: "USER",
            actorId: principal.id,
            action: "document.uploaded_to_quarantine",
            resourceType: "Document",
            resourceId: id,
            outcome: "SUCCESS",
            metadata: {
              fileName,
              mediaType,
              sizeBytes,
              classification: metadata.classification,
              stagingExpiresAt: stagingExpiresAt.toISOString(),
            },
          },
        });
        return document;
      });
      return detailDto(created as StoredDocument);
    } catch (error) {
      await this.store.deletePrefix(documentScratchPrefix(id)).catch(() => undefined);
      throw error;
    }
  }

  async decideQuarantine(
    principal: DocumentPrincipal,
    documentId: string,
    decision: QuarantineDecision,
  ): Promise<DocumentDetail> {
    if (decision.decision === "REJECT") {
      await this.prisma.$transaction(async (transaction) => {
        const changed = await transaction.document.updateMany({
          where: { id: documentId, ...visibility(principal), status: "QUARANTINED" },
          data: {
            status: "REJECTED",
            failureCode: "QUARANTINE_REJECTED",
            failureMessage: decision.reason,
          },
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
      });
      try {
        await this.store.deletePrefix(documentScratchPrefix(documentId));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "Transient staging purge failed.";
        await this.prisma.$transaction([
          this.prisma.document.updateMany({
            where: { id: documentId, status: "REJECTED", stagingKey: { not: null } },
            data: { stagingExpiresAt: new Date() },
          }),
          this.prisma.auditEvent.create({
            data: {
              actorType: "SYSTEM",
              action: "document.transient_staging_purge_failed",
              resourceType: "Document",
              resourceId: documentId,
              outcome: "FAILURE",
              metadata: { stage: "quarantine_rejection", message },
            },
          }),
        ]).catch(() => undefined);
        throw new DocumentStorageError("AIHub rejected the document but could not purge transient staging; cleanup will retry.");
      }
      const updated = await this.prisma.document.update({
        where: { id: documentId },
        data: {
          stagingKey: null,
          stagingExpiresAt: null,
          stagingPurgedAt: new Date(),
        },
      });
      return detailDto(updated as StoredDocument);
    }
    return this.enqueue(principal, documentId, ["QUARANTINED"], decision.reason);
  }

  async reprocess(principal: DocumentPrincipal, documentId: string): Promise<DocumentDetail> {
    return this.enqueue(principal, documentId, ["FAILED"], "Manual reprocessing requested.");
  }

  async delete(
    principal: DocumentPrincipal,
    documentId: string,
    options: { force: boolean; reason?: string | undefined },
  ): Promise<void> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ...visibility(principal), status: { not: "DELETED" } },
      include: { memoryPublication: { select: { status: true } } },
    });
    if (!document) throw new DocumentNotFoundError();
    if (["QUEUED", "CONVERTING", "DELETING"].includes(document.status)) {
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
    const claimed = await this.prisma.document.updateMany({
      where: {
        id: documentId,
        status: document.status,
        processingGeneration: document.processingGeneration,
      },
      data: { status: "DELETING" },
    });
    if (claimed.count !== 1) {
      throw new DocumentConflictError("The document changed while deletion was requested.");
    }
    try {
      await this.store.deletePrefix(documentScratchPrefix(documentId));
    } catch (error) {
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: document.status },
      });
      await this.prisma.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: principal.id,
          action: "document.deletion_failed",
          resourceType: "Document",
          resourceId: documentId,
          outcome: "FAILURE",
          metadata: {
            stage: "transient_staging_purge",
            message: error instanceof Error ? error.message.slice(0, 500) : "Transient staging purge failed.",
          },
        },
      }).catch(() => undefined);
      throw new DocumentStorageError("AIHub could not purge the transient document staging area.");
    }
    await this.prisma.$transaction([
      this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: "DELETED",
          deletedAt: new Date(),
          stagingKey: null,
          stagingExpiresAt: null,
          stagingPurgedAt: new Date(),
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
          metadata: { transientStagingPurged: true, reason: options.reason ?? null },
        },
      }),
    ]);
    await this.scheduleMemoryDeletion(documentId);
  }

  async metrics(): Promise<DocumentMetrics> {
    const [groups, aggregate, staged] = await Promise.all([
      this.prisma.document.groupBy({
        by: ["status"],
        where: { status: { not: "DELETED" } },
        _count: { _all: true },
      }),
      this.prisma.document.aggregate({
        where: { status: { not: "DELETED" } },
        _count: { _all: true },
      }),
      this.prisma.document.aggregate({
        where: {
          status: { not: "DELETED" },
          stagingKey: { not: null },
          stagingPurgedAt: null,
        },
        _count: { _all: true },
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
      processing: count(["QUEUED", "CONVERTING"]),
      ready: count(["READY"]),
      failed: count(["FAILED"]),
      rejected: count(["REJECTED"]),
      stagedDocuments: staged._count._all,
      stagedSourceBytes: Number(staged._sum.sizeBytes ?? 0),
    };
  }

  private async enqueue(
    principal: DocumentPrincipal,
    documentId: string,
    allowedStatuses: Array<"QUARANTINED" | "FAILED">,
    reason: string,
  ): Promise<DocumentDetail> {
    const jobId = randomUUID();
    const prepared = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.document.findFirst({
        where: { id: documentId, ...visibility(principal), status: { in: allowedStatuses } },
      });
      if (!current) throw new DocumentConflictError("The document is not eligible for this processing action.");
      if (
        !current.stagingKey ||
        current.stagingPurgedAt ||
        !current.stagingExpiresAt ||
        current.stagingExpiresAt <= new Date()
      ) {
        throw new DocumentConflictError("The transient source is no longer available. Re-upload or re-fetch the enterprise source.");
      }
      const generation = current.processingGeneration + 1;
      const stagingExpiresAt = new Date(Date.now() + DOCUMENT_SCRATCH_TTL_MS);
      const claimed = await transaction.document.updateMany({
        where: { id: documentId, processingGeneration: current.processingGeneration, status: current.status },
        data: {
          status: "QUEUED",
          processingGeneration: generation,
          approvedAt: current.approvedAt ?? new Date(),
          approvedBy: current.approvedBy ?? principal.id,
          stagingExpiresAt,
          failureCode: null,
          failureMessage: null,
          completedAt: null,
        },
      });
      if (claimed.count !== 1) throw new DocumentConflictError("The document changed while processing was requested.");
      await transaction.documentProcessingRun.create({ data: { documentId, generation, conversionJobId: jobId } });
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: principal.id,
          action: current.status === "QUARANTINED" ? "document.quarantine_approved" : "document.reprocess_requested",
          resourceType: "Document",
          resourceId: documentId,
          outcome: "SUCCESS",
          metadata: { generation, reason, stagingExpiresAt: stagingExpiresAt.toISOString() },
        },
      });
      return { generation };
    });
    return this.get(principal, documentId);
  }

  private async scheduleMemoryDeletion(documentId: string): Promise<void> {
    const publication = await this.prisma.documentMemoryPublication.findUnique({
      where: { documentId },
      select: { generation: true },
    });
    if (!publication) return;
    await this.prisma.documentMemoryPublication.update({
      where: { documentId },
      data: {
        status: "DELETE_PENDING",
        jobId: randomUUID(),
        failureCode: null,
        failureMessage: null,
        queuedAt: new Date(),
      },
    });
  }
}
