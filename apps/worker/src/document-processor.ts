import type {
  DocumentConversionJobPayload,
  DocumentOcrJobPayload,
} from "@aihub/contracts";
import { type AIHubPrismaClient } from "@aihub/database";
import {
  convertDocumentToPages,
  documentGenerationPrefix,
  documentNormalizedKey,
  documentPageKey,
  documentScratchPrefix,
  knowledgeScopeTag,
  type DocumentScratchStore,
  UnlimitedOcrClient,
} from "@aihub/document-runtime";
import type { PgBossQueueService } from "@aihub/jobs";

const MAX_NORMALIZED_CHARACTERS = 20_000_000;
const MAX_NORMALIZED_BYTES = 25 * 1024 * 1024;

function safeFailure(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)
    : "Document processing failed.";
}

export class PrismaDocumentProcessor {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly store: DocumentScratchStore,
    private readonly ocr: UnlimitedOcrClient,
    private readonly queue: PgBossQueueService,
  ) {}

  async convert(
    payload: DocumentConversionJobPayload,
    jobId: string,
    workerId: string,
  ): Promise<object> {
    const claimed = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.document.updateMany({
        where: {
          id: payload.documentId,
          processingGeneration: payload.generation,
          deletedAt: null,
          OR: [
            { status: { in: ["QUEUED", "FAILED"] } },
            {
              status: "CONVERTING",
              processingRuns: { some: { generation: payload.generation, conversionJobId: jobId } },
            },
          ],
        },
        data: {
          status: "CONVERTING",
          failureCode: null,
          failureMessage: null,
        },
      });
      if (result.count === 1) {
        await transaction.documentProcessingRun.update({
          where: {
            documentId_generation: {
              documentId: payload.documentId,
              generation: payload.generation,
            },
          },
          data: { conversionJobId: jobId, startedAt: new Date(), failedAt: null, failureCode: null },
        });
      }
      return result;
    });
    if (claimed.count !== 1) return { skipped: true, reason: "stale-or-ineligible" };
    try {
      const document = await this.prisma.document.findUniqueOrThrow({
        where: { id: payload.documentId },
      });
      if (
        !document.stagingKey ||
        document.stagingPurgedAt ||
        !document.stagingExpiresAt ||
        document.stagingExpiresAt <= new Date()
      ) {
        throw new Error("The transient document source has expired. Re-upload or re-fetch the enterprise source.");
      }
      await this.store.deletePrefix(documentGenerationPrefix(document.id, payload.generation));
      const original = await this.store.getBuffer(document.stagingKey);
      if (document.mediaType === "text/plain") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(original).trim();
        if (!text) throw new Error("The text document is empty.");
        await this.completeTextDocument(document.id, payload.generation, text, text, [{ source: "plain-text" }]);
        await this.prisma.auditEvent.create({
          data: {
            actorType: "SYSTEM",
            action: "document.text_normalized",
            resourceType: "Document",
            resourceId: document.id,
            outcome: "SUCCESS",
            metadata: { generation: payload.generation, pageCount: 1, workerId },
          },
        }).catch(() => undefined);
        return { documentId: document.id, generation: payload.generation, pageCount: 1, directText: true };
      }

      const pages = await convertDocumentToPages(original, document.fileName, document.mediaType);
      for (const page of pages) {
        await this.store.putBuffer(
          documentPageKey(document.id, payload.generation, page.pageNumber, page.mediaType),
          page.bytes,
        );
      }
      await this.prisma.document.update({
        where: { id: document.id },
        data: { status: "OCR_PENDING", pageCount: pages.length },
      });
      const ocrJobId = await this.queue.sendDocumentOcr({
        documentId: document.id,
        generation: payload.generation,
        pages: pages.map(({ pageNumber, mediaType }) => ({ pageNumber, mediaType })),
      });
      await this.prisma.documentProcessingRun.update({
        where: {
          documentId_generation: {
            documentId: document.id,
            generation: payload.generation,
          },
        },
        data: { ocrJobId },
      });
      await this.prisma.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: "document.conversion_completed",
          resourceType: "Document",
          resourceId: document.id,
          outcome: "SUCCESS",
          metadata: { generation: payload.generation, pageCount: pages.length, workerId },
        },
      }).catch(() => undefined);
      return { documentId: document.id, generation: payload.generation, pageCount: pages.length };
    } catch (error) {
      await this.markFailed(payload.documentId, payload.generation, "CONVERSION_FAILED", error, workerId);
      throw error;
    }
  }

  async runOcr(
    payload: DocumentOcrJobPayload,
    jobId: string,
    workerId: string,
  ): Promise<object> {
    const claimed = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.document.updateMany({
        where: {
          id: payload.documentId,
          processingGeneration: payload.generation,
          deletedAt: null,
          OR: [
            { status: { in: ["OCR_PENDING", "FAILED"] } },
            {
              status: "OCR_PROCESSING",
              processingRuns: { some: { generation: payload.generation, ocrJobId: jobId } },
            },
          ],
        },
        data: { status: "OCR_PROCESSING", failureCode: null, failureMessage: null },
      });
      if (result.count === 1) {
        await transaction.documentProcessingRun.update({
          where: {
            documentId_generation: {
              documentId: payload.documentId,
              generation: payload.generation,
            },
          },
          data: { ocrJobId: jobId, failedAt: null, failureCode: null },
        });
      }
      return result;
    });
    if (claimed.count !== 1) return { skipped: true, reason: "stale-or-ineligible" };
    try {
      const textPages: string[] = [];
      const markdownPages: string[] = [];
      const metadataPages: Record<string, unknown>[] = [];
      let normalizedCharacters = 0;
      for (const page of payload.pages) {
        const image = await this.store.getBuffer(
          documentPageKey(payload.documentId, payload.generation, page.pageNumber, page.mediaType),
          25 * 1024 * 1024,
        );
        const extracted = await this.ocr.extract(image, page.mediaType);
        textPages.push(extracted.text);
        normalizedCharacters += extracted.text.length + 2;
        markdownPages.push(`## Page ${page.pageNumber}\n\n${extracted.markdown}`);
        metadataPages.push({ pageNumber: page.pageNumber, ...extracted.metadata });
        if (normalizedCharacters > MAX_NORMALIZED_CHARACTERS) {
          throw new Error("Normalized OCR text exceeds the document-size limit.");
        }
      }
      const text = textPages.join("\n\n");
      const markdown = markdownPages.join("\n\n---\n\n");
      await this.completeTextDocument(
        payload.documentId,
        payload.generation,
        text,
        markdown,
        metadataPages,
      );
      await this.prisma.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: "document.ocr_completed",
          resourceType: "Document",
          resourceId: payload.documentId,
          outcome: "SUCCESS",
          metadata: { generation: payload.generation, pageCount: payload.pages.length, workerId },
        },
      }).catch(() => undefined);
      return { documentId: payload.documentId, generation: payload.generation, pageCount: payload.pages.length };
    } catch (error) {
      await this.markFailed(payload.documentId, payload.generation, "OCR_FAILED", error, workerId);
      throw error;
    }
  }

  private async completeTextDocument(
    documentId: string,
    generation: number,
    text: string,
    markdown: string,
    pages: Record<string, unknown>[],
  ): Promise<void> {
    if (text.length > MAX_NORMALIZED_CHARACTERS || markdown.length > MAX_NORMALIZED_CHARACTERS) {
      throw new Error("Normalized document content exceeds the storage limit.");
    }
    const normalized = markdown.trim() || text.trim();
    if (!normalized) throw new Error("Normalized document content is empty.");
    const normalizedBytes = Buffer.from(normalized, "utf8");
    if (normalizedBytes.byteLength > MAX_NORMALIZED_BYTES) {
      throw new Error("Normalized document content exceeds the byte-size limit.");
    }
    await this.store.putBuffer(
      documentNormalizedKey(documentId, generation),
      normalizedBytes,
    );
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: "READY",
          pageCount: Math.max(1, pages.length),
          failureCode: null,
          failureMessage: null,
          completedAt: now,
        },
      }),
      this.prisma.documentProcessingRun.update({
        where: { documentId_generation: { documentId, generation } },
        data: { completedAt: now, failedAt: null, failureCode: null },
      }),
    ]);
    await this.scheduleMemoryPublication(documentId, generation);
  }

  async cleanupExpired(workerId: string): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.document.findMany({
      where: {
        stagingKey: { not: null },
        OR: [
          { stagingPurgedAt: { not: null } },
          {
            stagingPurgedAt: null,
            stagingExpiresAt: { lte: now },
            status: { notIn: ["QUEUED", "CONVERTING", "OCR_PENDING", "OCR_PROCESSING", "DELETING"] },
            AND: [{
              OR: [
                { memoryPublication: null },
                { memoryPublication: { is: { status: { not: "PROCESSING" } } } },
              ],
            }],
          },
        ],
      },
      select: {
        id: true,
        status: true,
        stagingPurgedAt: true,
      },
      take: 100,
    });
    let purged = 0;
    for (const document of expired) {
      const claimAt = document.stagingPurgedAt ?? new Date();
      if (!document.stagingPurgedAt) {
        const claimed = await this.prisma.document.updateMany({
          where: {
            id: document.id,
            status: document.status,
            stagingKey: { not: null },
            stagingPurgedAt: null,
            stagingExpiresAt: { lte: now },
            OR: [
              { memoryPublication: null },
              { memoryPublication: { is: { status: { not: "PROCESSING" } } } },
            ],
          },
          data: { stagingPurgedAt: claimAt },
        });
        if (claimed.count !== 1) continue;
      }
      let contentPurged = false;
      try {
        await this.store.deletePrefix(documentScratchPrefix(document.id));
        contentPurged = true;
        const current = await this.prisma.document.findUniqueOrThrow({
          where: { id: document.id },
          select: {
            status: true,
            memoryPublication: { select: { status: true } },
          },
        });
        const knowledgeReady = current.memoryPublication?.status === "READY";
        await this.prisma.$transaction([
          this.prisma.document.updateMany({
            where: {
              id: document.id,
              stagingKey: { not: null },
              stagingPurgedAt: claimAt,
            },
            data: {
              stagingKey: null,
              stagingExpiresAt: null,
              ...(!knowledgeReady && !["REJECTED", "DELETED"].includes(current.status)
                ? {
                    status: "FAILED" as const,
                    failureCode: "STAGING_EXPIRED",
                    failureMessage: "Transient document staging expired. Re-upload or re-fetch the enterprise source.",
                  }
                : knowledgeReady
                  ? { failureCode: null, failureMessage: null }
                  : {}),
            },
          }),
          this.prisma.auditEvent.create({
            data: {
              actorType: "SYSTEM",
              action: "document.transient_staging_purged",
              resourceType: "Document",
              resourceId: document.id,
              outcome: "SUCCESS",
              metadata: { workerId, knowledgeReady },
            },
          }),
        ]);
        purged += 1;
      } catch (error) {
        if (!contentPurged) {
          await this.prisma.document.updateMany({
            where: { id: document.id, stagingKey: { not: null }, stagingPurgedAt: claimAt },
            data: { stagingPurgedAt: null, stagingExpiresAt: new Date() },
          }).catch(() => undefined);
        }
        await this.prisma.auditEvent.create({
          data: {
            actorType: "SYSTEM",
            action: "document.transient_staging_purge_failed",
            resourceType: "Document",
            resourceId: document.id,
            outcome: "FAILURE",
            metadata: { workerId, message: safeFailure(error) },
          },
        }).catch(() => undefined);
      }
    }
    return purged;
  }

  private async scheduleMemoryPublication(documentId: string, generation: number): Promise<void> {
    try {
      const document = await this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { ownerSubject: true },
      });
      const queuedAt = new Date();
      await this.prisma.documentMemoryPublication.upsert({
        where: { documentId },
        create: {
          documentId,
          ownerSubject: document.ownerSubject,
          scopeTag: knowledgeScopeTag(document.ownerSubject),
          generation,
          status: "QUEUED",
          queuedAt,
        },
        update: {
          ownerSubject: document.ownerSubject,
          scopeTag: knowledgeScopeTag(document.ownerSubject),
          generation,
          status: "QUEUED",
          jobId: null,
          failureCode: null,
          failureMessage: null,
          queuedAt,
          syncedAt: null,
          deletedAt: null,
        },
      });
      const jobId = await this.queue.sendMemoryIndex({ documentId, generation, action: "UPSERT" });
      await this.prisma.documentMemoryPublication.updateMany({
        where: { documentId, generation, status: "QUEUED" },
        data: { jobId },
      });
    } catch (error) {
      await this.prisma.documentMemoryPublication.updateMany({
        where: { documentId, generation },
        data: {
          status: "FAILED",
          failureCode: "MEMORY_QUEUE_FAILED",
          failureMessage: safeFailure(error),
        },
      }).catch(() => undefined);
    }
  }

  private async markFailed(
    documentId: string,
    generation: number,
    code: string,
    error: unknown,
    workerId: string,
  ): Promise<void> {
    const now = new Date();
    const message = safeFailure(error);
    await this.prisma.$transaction([
      this.prisma.document.updateMany({
        where: {
          id: documentId,
          processingGeneration: generation,
          deletedAt: null,
          status: { in: ["CONVERTING", "OCR_PENDING", "OCR_PROCESSING", "FAILED"] },
        },
        data: { status: "FAILED", failureCode: code, failureMessage: message },
      }),
      this.prisma.documentProcessingRun.updateMany({
        where: { documentId, generation },
        data: { failedAt: now, failureCode: code },
      }),
      this.prisma.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: "document.processing_failed",
          resourceType: "Document",
          resourceId: documentId,
          outcome: "FAILURE",
          metadata: { generation, code, message, workerId },
        },
      }),
    ]);
  }
}
