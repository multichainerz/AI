import type { MemoryIndexJobPayload } from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import { SupermemoryClient } from "@aihub/document-runtime";

function safeFailure(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)
    : "Memory synchronization failed.";
}

export class PrismaMemoryProcessor {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly client: SupermemoryClient,
  ) {}

  async process(payload: MemoryIndexJobPayload, jobId: string, workerId: string): Promise<object> {
    const publication = await this.prisma.documentMemoryPublication.findUnique({
      where: { documentId: payload.documentId },
      include: { document: true },
    });
    if (!publication || publication.generation !== payload.generation) {
      return { skipped: true, reason: "stale-or-missing-publication" };
    }
    if (payload.action === "DELETE" && publication.document.status !== "DELETED") {
      return { skipped: true, reason: "document-is-not-deleted" };
    }
    if (
      payload.action === "UPSERT" &&
      (
        publication.document.status !== "READY" ||
        publication.document.processingGeneration !== payload.generation ||
        !publication.document.normalizedText
      )
    ) {
      return { skipped: true, reason: "document-generation-is-not-publishable" };
    }
    const eligible = payload.action === "DELETE"
      ? ["DELETE_PENDING", "FAILED"] as const
      : ["QUEUED", "FAILED"] as const;
    const claimed = await this.prisma.documentMemoryPublication.updateMany({
      where: {
        documentId: payload.documentId,
        generation: payload.generation,
        OR: [
          { status: { in: [...eligible] } },
          { status: "PROCESSING", jobId },
        ],
      },
      data: { status: "PROCESSING", jobId, failureCode: null, failureMessage: null },
    });
    if (claimed.count !== 1) return { skipped: true, reason: "stale-or-ineligible" };

    try {
      if (payload.action === "DELETE") {
        await this.client.delete(payload.documentId, publication.externalDocumentId);
        await this.prisma.documentMemoryPublication.update({
          where: { documentId: payload.documentId },
          data: { status: "DELETED", deletedAt: new Date(), syncedAt: null },
        });
      } else {
        const externalDocumentId = await this.client.publish({
          documentId: publication.documentId,
          ownerSubject: publication.ownerSubject,
          content: publication.document.normalizedMarkdown || publication.document.normalizedText || "",
          fileName: publication.document.fileName,
          classification: publication.document.classification,
          generation: payload.generation,
        });
        await this.prisma.documentMemoryPublication.updateMany({
          where: { documentId: payload.documentId, generation: payload.generation, status: "PROCESSING" },
          data: {
            status: "READY",
            externalDocumentId,
            syncedAt: new Date(),
            deletedAt: null,
          },
        });
      }
      await this.prisma.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: payload.action === "DELETE" ? "memory.document_deleted" : "memory.document_published",
          resourceType: "Document",
          resourceId: payload.documentId,
          outcome: "SUCCESS",
          metadata: { generation: payload.generation, workerId },
        },
      }).catch(() => undefined);
      return { documentId: payload.documentId, generation: payload.generation, action: payload.action };
    } catch (error) {
      const message = safeFailure(error);
      await this.prisma.$transaction([
        this.prisma.documentMemoryPublication.updateMany({
          where: { documentId: payload.documentId, generation: payload.generation, status: "PROCESSING" },
          data: { status: "FAILED", failureCode: `MEMORY_${payload.action}_FAILED`, failureMessage: message },
        }),
        this.prisma.auditEvent.create({
          data: {
            actorType: "SYSTEM",
            action: "memory.synchronization_failed",
            resourceType: "Document",
            resourceId: payload.documentId,
            outcome: "FAILURE",
            metadata: { generation: payload.generation, action: payload.action, message, workerId },
          },
        }),
      ]);
      throw error;
    }
  }
}
