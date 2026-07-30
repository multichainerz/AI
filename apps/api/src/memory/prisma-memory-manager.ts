import type { MemoryMetrics, MemoryPublication, MemoryPublicationList } from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import { knowledgeScopeTag } from "@aihub/document-runtime";
import type { PgBossQueueService } from "@aihub/jobs";
import { MemoryPublicationConflictError, type MemoryManager } from "./memory-manager.js";

export class PrismaMemoryManager implements MemoryManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly queue: PgBossQueueService,
  ) {}

  async list(): Promise<MemoryPublicationList> {
    const publications = await this.prisma.documentMemoryPublication.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: {
        document: {
          select: {
            fileName: true,
            classification: true,
            status: true,
            stagingKey: true,
            stagingExpiresAt: true,
            stagingPurgedAt: true,
          },
        },
      },
    });
    return {
      items: publications.map((publication): MemoryPublication => ({
        documentId: publication.documentId,
        fileName: publication.document.fileName,
        classification: publication.document.classification,
        generation: publication.generation,
        status: publication.status,
        externalDocumentId: publication.externalDocumentId,
        failureCode: publication.failureCode,
        failureMessage: publication.failureMessage,
        retryable: publication.status === "FAILED" && (
          publication.document.status === "DELETED" ||
          (
            publication.document.status === "READY" &&
            publication.document.stagingKey !== null &&
            publication.document.stagingPurgedAt === null &&
            publication.document.stagingExpiresAt !== null &&
            publication.document.stagingExpiresAt > new Date()
          )
        ),
        queuedAt: publication.queuedAt?.toISOString() ?? null,
        syncedAt: publication.syncedAt?.toISOString() ?? null,
        updatedAt: publication.updatedAt.toISOString(),
      })),
    };
  }

  async metrics(): Promise<MemoryMetrics> {
    const groups = await this.prisma.documentMemoryPublication.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const count = (statuses: string[]) => groups
      .filter(({ status }) => statuses.includes(status))
      .reduce((sum, item) => sum + item._count._all, 0);
    return {
      generatedAt: new Date().toISOString(),
      total: groups.reduce((sum, item) => sum + item._count._all, 0),
      queued: count(["QUEUED"]),
      processing: count(["PROCESSING"]),
      ready: count(["READY"]),
      failed: count(["FAILED"]),
      deletePending: count(["DELETE_PENDING"]),
    };
  }

  async reindex(documentId: string, actorId: string): Promise<void> {
    const document = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        OR: [
          { status: "DELETED" },
          {
            status: "READY",
            stagingKey: { not: null },
            stagingPurgedAt: null,
            stagingExpiresAt: { gt: new Date() },
            memoryPublication: { is: { status: "FAILED" } },
          },
        ],
      },
      select: {
        id: true,
        ownerSubject: true,
        processingGeneration: true,
        status: true,
      },
    });
    if (!document) {
      throw new MemoryPublicationConflictError(
        "The publication is not retryable. Re-upload or re-fetch the enterprise source if transient staging has been purged.",
      );
    }
    const action = document.status === "DELETED" ? "DELETE" : "UPSERT";
    if (action === "DELETE") {
      const publication = await this.prisma.documentMemoryPublication.findUnique({
        where: { documentId },
        select: { documentId: true },
      });
      if (!publication) throw new MemoryPublicationConflictError("The deleted document has no memory publication to remove.");
    }
    const queuedAt = new Date();
    await this.prisma.documentMemoryPublication.upsert({
      where: { documentId },
      create: {
        documentId,
        ownerSubject: document.ownerSubject,
        scopeTag: knowledgeScopeTag(document.ownerSubject),
        generation: document.processingGeneration,
        status: action === "DELETE" ? "DELETE_PENDING" : "QUEUED",
        queuedAt,
      },
      update: {
        ownerSubject: document.ownerSubject,
        scopeTag: knowledgeScopeTag(document.ownerSubject),
        generation: document.processingGeneration,
        status: action === "DELETE" ? "DELETE_PENDING" : "QUEUED",
        failureCode: null,
        failureMessage: null,
        queuedAt,
        syncedAt: null,
        deletedAt: null,
      },
    });
    try {
      const jobId = await this.queue.sendMemoryIndex({
        documentId,
        generation: document.processingGeneration,
        action,
      });
      await this.prisma.$transaction([
        this.prisma.documentMemoryPublication.update({ where: { documentId }, data: { jobId } }),
        this.prisma.auditEvent.create({
          data: {
            actorType: "USER",
            actorId,
            action: action === "DELETE" ? "memory.delete_retry_requested" : "memory.reindex_requested",
            resourceType: "Document",
            resourceId: documentId,
            outcome: "SUCCESS",
            metadata: { generation: document.processingGeneration, action },
          },
        }),
      ]);
    } catch {
      await this.prisma.documentMemoryPublication.update({
        where: { documentId },
        data: {
          status: "FAILED",
          failureCode: "MEMORY_QUEUE_FAILED",
          failureMessage: "Memory synchronization could not be queued.",
        },
      });
      throw new MemoryPublicationConflictError("Memory synchronization could not be queued.");
    }
  }
}
