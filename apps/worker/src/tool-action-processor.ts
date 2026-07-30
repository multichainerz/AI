import { randomUUID } from "node:crypto";
import type { MemoryIndexJobPayload } from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import { knowledgeScopeTag } from "@aihub/document-runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 8;
const dispatchInclude = {
  call: {
    include: {
      approval: true,
      tool: true,
      grant: true,
      run: { include: { profile: true } },
    },
  },
} satisfies Prisma.ToolActionDispatchInclude;
type DispatchCall = Prisma.ToolActionDispatchGetPayload<{ include: typeof dispatchInclude }>["call"];

export interface ToolActionQueue {
  ensureMemoryIndex(payload: MemoryIndexJobPayload): Promise<string | null>;
}

class ToolActionPolicyError extends Error {}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeFailure(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)
    : "Approved tool action submission failed.";
}

export class PrismaToolActionProcessor {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly queue: ToolActionQueue,
  ) {}

  async processAvailable(workerId: string, limit = 10): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const claimed = await this.claimNext(workerId);
      if (!claimed) break;
      await this.processClaimed(claimed.id, claimed.attemptCount, claimed.claimToken, workerId);
      processed += 1;
    }
    return processed;
  }

  private async claimNext(workerId: string): Promise<{ id: string; attemptCount: number; claimToken: string } | null> {
    return this.prisma.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "ToolActionDispatch"
        WHERE (
          "status" = 'PENDING'::"ToolActionDispatchStatus"
          AND "nextAttemptAt" <= CURRENT_TIMESTAMP
        ) OR (
          "status" = 'PROCESSING'::"ToolActionDispatchStatus"
          AND "claimedAt" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes'
        )
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const candidate = candidates[0];
      if (!candidate) return null;
      const claimToken = randomUUID();
      const claimed = await transaction.toolActionDispatch.update({
        where: { id: candidate.id },
        data: {
          status: "PROCESSING",
          attemptCount: { increment: 1 },
          claimedAt: new Date(),
          claimedBy: workerId,
          claimToken,
          lastError: null,
        },
        select: { id: true, attemptCount: true },
      });
      return { ...claimed, claimToken };
    });
  }

  private async processClaimed(dispatchId: string, attemptCount: number, claimToken: string, workerId: string): Promise<void> {
    try {
      const dispatch = await this.prisma.toolActionDispatch.findUnique({
        where: { id: dispatchId },
        include: dispatchInclude,
      });
      if (
        !dispatch ||
        dispatch.status !== "PROCESSING" ||
        dispatch.claimedBy !== workerId ||
        dispatch.claimToken !== claimToken
      ) return;

      const document = await this.assertStillAuthorized(dispatch.call);
      const publication = await this.prisma.documentMemoryPublication.findUnique({
        where: { documentId: document.id },
        select: { sourceToolDispatchId: true, jobId: true, generation: true, status: true },
      });
      let jobId = publication && publication.sourceToolDispatchId === dispatch.id ? publication.jobId : null;

      if (!jobId) {
        const queuedAt = new Date();
        if (publication?.sourceToolDispatchId !== dispatch.id) {
          const currentGenerationInFlight =
            publication?.generation === document.processingGeneration &&
            (publication.status === "QUEUED" || publication.status === "PROCESSING");
          if (currentGenerationInFlight) {
            await this.prisma.documentMemoryPublication.update({
              where: { documentId: document.id },
              data: { sourceToolDispatchId: dispatch.id },
            });
            jobId = publication.jobId;
          } else {
            await this.prisma.documentMemoryPublication.upsert({
              where: { documentId: document.id },
              create: {
                documentId: document.id,
                ownerSubject: document.ownerSubject,
                scopeTag: knowledgeScopeTag(document.ownerSubject),
                generation: document.processingGeneration,
                status: "QUEUED",
                queuedAt,
                sourceToolDispatchId: dispatch.id,
              },
              update: {
                ownerSubject: document.ownerSubject,
                scopeTag: knowledgeScopeTag(document.ownerSubject),
                generation: document.processingGeneration,
                status: "QUEUED",
                queuedAt,
                jobId: null,
                sourceToolDispatchId: dispatch.id,
                failureCode: null,
                failureMessage: null,
                syncedAt: null,
                deletedAt: null,
              },
            });
          }
        }
        if (!jobId) {
          jobId = await this.queue.ensureMemoryIndex({
            documentId: document.id,
            generation: document.processingGeneration,
            action: "UPSERT",
          });
        }
        if (jobId) {
          await this.prisma.documentMemoryPublication.updateMany({
            where: { documentId: document.id, sourceToolDispatchId: dispatch.id },
            data: { jobId },
          });
        }
      }

      const completedAt = new Date();
      await this.prisma.$transaction(async (transaction) => {
        const completed = await transaction.toolActionDispatch.updateMany({
          where: { id: dispatch.id, status: "PROCESSING", claimToken },
          data: {
            status: "COMPLETED", submittedJobId: jobId, completedAt,
            claimedAt: null, claimedBy: null, claimToken: null,
          },
        });
        if (completed.count !== 1) return;
        await transaction.governedToolCall.update({
          where: { id: dispatch.callId },
          data: {
            status: "COMPLETED",
            result: { queued: true, documentId: document.id, jobId } as Prisma.InputJsonValue,
            completedAt,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorType: "SYSTEM",
            action: "tool.approved_action_submitted",
            resourceType: "GovernedToolCall",
            resourceId: dispatch.callId,
            outcome: "SUCCESS",
            metadata: { dispatchId: dispatch.id, documentId: document.id, jobId, workerId },
          },
        });
      });
    } catch (error) {
      if (error instanceof ToolActionPolicyError) {
        await this.cancelDispatch(dispatchId, claimToken, safeFailure(error), workerId);
        return;
      }
      await this.retryOrFail(dispatchId, claimToken, attemptCount, safeFailure(error), workerId);
    }
  }

  private async assertStillAuthorized(call: DispatchCall): Promise<{
    id: string;
    ownerSubject: string;
    processingGeneration: number;
  }> {
    const control = await this.prisma.toolRuntimeControl.findUnique({ where: { id: "global" } });
    if (call.approval?.status !== "APPROVED" || call.status !== "EXECUTING") {
      throw new ToolActionPolicyError("The approved call is no longer executable.");
    }
    if (!control?.enabled || call.tool.status !== "ACTIVE" || !call.grant.enabled) {
      throw new ToolActionPolicyError("Tool execution was revoked after approval.");
    }
    if (
      call.grant.toolId !== call.toolId ||
      call.grant.profileVersionId !== call.run.profileVersionId ||
      call.grant.resourceScope !== "OWNER_ONLY"
    ) {
      throw new ToolActionPolicyError("The stored tool grant no longer matches the exact run and tool scope.");
    }
    if (call.tool.risk !== "CONSEQUENTIAL" || call.tool.handlerKey !== "builtin.document_memory_resync") {
      throw new ToolActionPolicyError("The approved action handler is not allowed.");
    }
    if (call.run.profile.status !== "ACTIVE" || call.run.profile.activeVersion !== call.run.profileVersion) {
      throw new ToolActionPolicyError("The agent profile or version was revoked after approval.");
    }
    if (!(await this.requesterMatchesGrant(call.run.requestedBy, call.grant.allowedGroups, call.grant.allowedAdminRoles))) {
      throw new ToolActionPolicyError("The requesting identity no longer satisfies the tool grant.");
    }
    const args = jsonObject(call.arguments);
    const documentId = typeof args.documentId === "string" ? args.documentId : "";
    if (Object.keys(args).length !== 1 || !UUID.test(documentId)) {
      throw new ToolActionPolicyError("The approved action contains invalid document arguments.");
    }
    const document = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        ownerSubject: call.run.ownerSubject,
        status: "READY",
        deletedAt: null,
        stagingKey: { not: null },
        stagingPurgedAt: null,
        stagingExpiresAt: { gt: new Date() },
      },
      select: { id: true, ownerSubject: true, processingGeneration: true },
    });
    if (!document) {
      throw new ToolActionPolicyError("The target document is no longer publishable within owner-only scope.");
    }
    return document;
  }

  private async requesterMatchesGrant(requestedBy: string, groups: string[], roles: string[]): Promise<boolean> {
    const now = new Date();
    const administrator = await this.prisma.administratorSession.findFirst({
      where: { id: requestedBy, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      select: { role: true },
    });
    if (administrator) return roles.includes(administrator.role);
    const enterprise = await this.prisma.enterpriseUserSession.findFirst({
      where: {
        id: requestedBy,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
        user: { enabled: true },
      },
      select: { user: { select: { groups: true } } },
    });
    return enterprise ? enterprise.user.groups.some((group) => groups.includes(group)) : false;
  }

  private async cancelDispatch(dispatchId: string, claimToken: string, reason: string, workerId: string): Promise<void> {
    const dispatch = await this.prisma.toolActionDispatch.findUnique({ where: { id: dispatchId }, select: { callId: true } });
    if (!dispatch) return;
    const completedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const cancelled = await transaction.toolActionDispatch.updateMany({
        where: { id: dispatchId, status: "PROCESSING", claimToken },
        data: {
          status: "CANCELLED", lastError: reason, completedAt,
          claimedAt: null, claimedBy: null, claimToken: null,
        },
      });
      if (cancelled.count !== 1) return;
      await transaction.governedToolCall.updateMany({
        where: { id: dispatch.callId, status: "EXECUTING" },
        data: { status: "DENIED", errorCode: "AUTHORIZATION_REVOKED_AFTER_APPROVAL", errorMessage: reason, completedAt },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: "tool.approved_action_cancelled",
          resourceType: "GovernedToolCall",
          resourceId: dispatch.callId,
          outcome: "FAILURE",
          metadata: { dispatchId, reason, workerId },
        },
      });
    });
  }

  private async retryOrFail(dispatchId: string, claimToken: string, attemptCount: number, message: string, workerId: string): Promise<void> {
    const dispatch = await this.prisma.toolActionDispatch.findUnique({ where: { id: dispatchId }, select: { callId: true } });
    if (!dispatch) return;
    const terminal = attemptCount >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, attemptCount - 1));
    const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000);
    const completedAt = terminal ? new Date() : null;
    await this.prisma.$transaction(async (transaction) => {
      const released = await transaction.toolActionDispatch.updateMany({
        where: { id: dispatchId, status: "PROCESSING", claimToken },
        data: terminal
          ? {
              status: "FAILED", lastError: message, completedAt,
              claimedAt: null, claimedBy: null, claimToken: null,
            }
          : {
              status: "PENDING", lastError: message, nextAttemptAt,
              claimedAt: null, claimedBy: null, claimToken: null,
            },
      });
      if (released.count !== 1) return;
      await transaction.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: terminal ? "tool.approved_action_failed" : "tool.approved_action_retry_scheduled",
          resourceType: "GovernedToolCall",
          resourceId: dispatch.callId,
          outcome: "FAILURE",
          metadata: { dispatchId, attemptCount, message, workerId, ...(terminal ? {} : { nextAttemptAt }) },
        },
      });
      if (terminal) {
        await transaction.governedToolCall.updateMany({
          where: { id: dispatch.callId, status: "EXECUTING" },
          data: { status: "FAILED", errorCode: "APPROVED_ACTION_SUBMISSION_FAILED", errorMessage: message, completedAt },
        });
      }
    });
  }
}
