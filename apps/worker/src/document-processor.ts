import { createHash } from "node:crypto";
import type {
  DocumentConversionJobPayload,
  DocumentOcrJobPayload,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import {
  convertDocumentToPages,
  knowledgeScopeTag,
  type DocumentObjectStore,
  UnlimitedOcrClient,
} from "@aihub/document-runtime";
import type { PgBossQueueService } from "@aihub/jobs";

const MAX_NORMALIZED_CHARACTERS = 20_000_000;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFailure(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)
    : "Document processing failed.";
}

export class PrismaDocumentProcessor {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly store: DocumentObjectStore,
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
      const original = await this.store.getBuffer(document.originalObjectKey);
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
      const pageNumbers = pages.map(({ pageNumber }) => pageNumber);
      const previous = await this.prisma.documentArtifact.findMany({
        where: { documentId: document.id, kind: "PAGE_IMAGE" },
        select: { id: true, pageNumber: true, objectKey: true },
      });
      const currentKeys = new Map<number, string>();
      for (const page of pages) {
        const key = `documents/${document.id}/generation-${payload.generation}/pages/${String(page.pageNumber).padStart(4, "0")}.${page.mediaType === "image/png" ? "png" : "jpg"}`;
        currentKeys.set(page.pageNumber, key);
        await this.store.putBuffer(key, page.bytes, page.mediaType);
        await this.prisma.documentArtifact.upsert({
          where: {
            documentId_kind_pageNumber: {
              documentId: document.id,
              kind: "PAGE_IMAGE",
              pageNumber: page.pageNumber,
            },
          },
          create: {
            documentId: document.id,
            kind: "PAGE_IMAGE",
            pageNumber: page.pageNumber,
            objectKey: key,
            mediaType: page.mediaType,
            sizeBytes: page.bytes.byteLength,
            sha256: sha256(page.bytes),
          },
          update: {
            objectKey: key,
            mediaType: page.mediaType,
            sizeBytes: page.bytes.byteLength,
            sha256: sha256(page.bytes),
          },
        });
      }
      const removedPages = previous.filter(({ pageNumber }) => !pageNumbers.includes(pageNumber));
      const obsoleteKeys = previous
        .filter(({ pageNumber, objectKey }) => currentKeys.get(pageNumber) !== objectKey)
        .map(({ objectKey }) => objectKey);
      await this.store.delete(obsoleteKeys).catch(() => undefined);
      if (removedPages.length > 0) {
        await this.prisma.documentArtifact.deleteMany({
          where: { id: { in: removedPages.map(({ id }) => id) } },
        });
      }
      await this.prisma.document.update({
        where: { id: document.id },
        data: { status: "OCR_PENDING", pageCount: pages.length },
      });
      const ocrJobId = await this.queue.sendDocumentOcr({
        documentId: document.id,
        generation: payload.generation,
        pageNumbers,
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
      const artifacts = await this.prisma.documentArtifact.findMany({
        where: {
          documentId: payload.documentId,
          kind: "PAGE_IMAGE",
          pageNumber: { in: payload.pageNumbers },
        },
        orderBy: { pageNumber: "asc" },
      });
      if (artifacts.length !== payload.pageNumbers.length) {
        throw new Error("One or more converted page images are missing.");
      }
      const textPages: string[] = [];
      const markdownPages: string[] = [];
      const metadataPages: Record<string, unknown>[] = [];
      let normalizedCharacters = 0;
      for (const artifact of artifacts) {
        const image = await this.store.getBuffer(artifact.objectKey, 25 * 1024 * 1024);
        const extracted = await this.ocr.extract(image, artifact.mediaType);
        textPages.push(extracted.text);
        normalizedCharacters += extracted.text.length + 2;
        markdownPages.push(`## Page ${artifact.pageNumber}\n\n${extracted.markdown}`);
        metadataPages.push({ pageNumber: artifact.pageNumber, ...extracted.metadata });
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
          metadata: { generation: payload.generation, pageCount: artifacts.length, workerId },
        },
      }).catch(() => undefined);
      return { documentId: payload.documentId, generation: payload.generation, pageCount: artifacts.length };
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
    const outputs = [
      { kind: "OCR_TEXT" as const, extension: "txt", mediaType: "text/plain; charset=utf-8", value: Buffer.from(text, "utf8") },
      { kind: "OCR_MARKDOWN" as const, extension: "md", mediaType: "text/markdown; charset=utf-8", value: Buffer.from(markdown, "utf8") },
      { kind: "OCR_JSON" as const, extension: "json", mediaType: "application/json", value: Buffer.from(JSON.stringify({ pages }), "utf8") },
    ];
    const previousOutputs = await this.prisma.documentArtifact.findMany({
      where: { documentId, kind: { in: outputs.map(({ kind }) => kind) } },
      select: { objectKey: true },
    });
    const outputKeys = new Set<string>();
    for (const output of outputs) {
      const key = `documents/${documentId}/generation-${generation}/normalized/document.${output.extension}`;
      outputKeys.add(key);
      await this.store.putBuffer(key, output.value, output.mediaType);
      await this.prisma.documentArtifact.upsert({
        where: {
          documentId_kind_pageNumber: { documentId, kind: output.kind, pageNumber: 0 },
        },
        create: {
          documentId,
          kind: output.kind,
          pageNumber: 0,
          objectKey: key,
          mediaType: output.mediaType,
          sizeBytes: output.value.byteLength,
          sha256: sha256(output.value),
        },
        update: {
          objectKey: key,
          mediaType: output.mediaType,
          sizeBytes: output.value.byteLength,
          sha256: sha256(output.value),
        },
      });
    }
    await this.store.delete(
      previousOutputs
        .map(({ objectKey }) => objectKey)
        .filter((objectKey) => !outputKeys.has(objectKey)),
    ).catch(() => undefined);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: "READY",
          pageCount: Math.max(1, pages.length),
          normalizedText: text,
          normalizedMarkdown: markdown,
          ocrMetadata: { pages } as Prisma.InputJsonValue,
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
