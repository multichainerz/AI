import type {
  AgentMemoryQuery,
  AgentMemoryRecord,
  AgentMemoryRecordList,
  ChangeMemoryPolicyState,
  CreateMemoryPolicy,
  MemoryPolicy,
  MemoryPolicyList,
  PurgeAgentMemory,
  UpdateMemoryPolicy,
} from "@orcasynapse/contracts";
import {
  agentMemory,
  agentProfile,
  auditEvent,
  memoryPolicy,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, desc, eq, ne } from "drizzle-orm";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import type { AdminPrincipal } from "../auth/admin-session.js";
import {
  AgentMemoryNotFoundError,
  MemoryPolicyConflictError,
  MemoryPolicyNotFoundError,
  type MemoryManager,
} from "./memory-manager.js";

type StoredPolicy = typeof memoryPolicy.$inferSelect;

function dto(policy: StoredPolicy): MemoryPolicy {
  return {
    id: policy.id,
    slug: policy.slug,
    displayName: policy.displayName,
    description: policy.description,
    status: policy.status,
    maximumCaptureMode: policy.maximumCaptureMode,
    retentionDays: policy.retentionDays,
    maximumItemsPerOwner: policy.maximumItemsPerOwner,
    recallLimit: policy.recallLimit,
    recallMinimumScore: policy.recallMinimumScore,
    knowledgeRecallLimit: policy.knowledgeRecallLimit,
    knowledgeMinimumScore: policy.knowledgeMinimumScore,
    revision: policy.revision,
    firstActivatedAt: policy.firstActivatedAt?.toISOString() ?? null,
    createdBy: policy.createdBy,
    updatedBy: policy.updatedBy,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

/**
 * Governs what agents may remember, and lets an administrator see and delete it.
 *
 * The lifecycle follows the prompt-template pattern - draft, activate, suspend,
 * with optimistic concurrency on `revision` - but deliberately requires no
 * promoted evaluation evidence. Guardrails and prompts gate on evidence because
 * they change how the model behaves; this is a data-retention control, so it
 * gets the lifecycle and the audit trail without the evaluation machinery.
 */
export class DrizzleMemoryManager implements MemoryManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async list(): Promise<MemoryPolicyList> {
    const rows = await this.database.select().from(memoryPolicy).orderBy(desc(memoryPolicy.updatedAt));
    return { items: rows.map(dto) };
  }

  /** The active ceiling, or null when an installation has never set one. */
  async activePolicy(): Promise<MemoryPolicy | null> {
    const [row] = await this.database
      .select().from(memoryPolicy).where(eq(memoryPolicy.status, "ACTIVE")).limit(1);
    return row ? dto(row) : null;
  }

  async create(principal: AdminPrincipal, input: CreateMemoryPolicy): Promise<MemoryPolicy> {
    try {
      const [created] = await this.database.transaction(async (transaction) => {
        const inserted = await transaction
          .insert(memoryPolicy)
          .values({ ...input, createdBy: principal.id, updatedBy: principal.id })
          .returning();
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "memory.policy_created",
          resourceType: "MemoryPolicy",
          resourceId: inserted[0]!.id,
          outcome: "SUCCESS",
          metadata: { slug: input.slug, maximumCaptureMode: input.maximumCaptureMode },
        });
        return inserted;
      });
      return dto(created!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new MemoryPolicyConflictError("A memory policy with that slug already exists.");
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdateMemoryPolicy): Promise<MemoryPolicy> {
    const { expectedRevision, ...changes } = input;
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-memory-policy:${id}`));
      const [current] = await transaction.select().from(memoryPolicy).where(eq(memoryPolicy.id, id)).limit(1);
      if (!current) throw new MemoryPolicyNotFoundError();
      // An active ceiling is what every run is being measured against; editing
      // it in place would move the boundary under work already admitted.
      if (current.status === "ACTIVE") {
        throw new MemoryPolicyConflictError("Suspend the active policy before changing it.");
      }
      const updated = await transaction
        .update(memoryPolicy)
        .set({ ...changes, revision: increment(memoryPolicy.revision), updatedBy: principal.id })
        .where(and(
          eq(memoryPolicy.id, id),
          eq(memoryPolicy.revision, expectedRevision),
          eq(memoryPolicy.status, current.status),
        ))
        .returning();
      if (updated.length !== 1) {
        throw new MemoryPolicyConflictError("The policy changed in another session. Refresh and try again.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "memory.policy_updated",
        resourceType: "MemoryPolicy",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { changedFields: Object.keys(changes) },
      });
      return dto(updated[0]!);
    });
  }

  async activate(principal: AdminPrincipal, id: string, input: ChangeMemoryPolicyState): Promise<MemoryPolicy> {
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(advisoryLock(`orcasynapse-memory-policy:${id}`));
        await transaction.execute(advisoryLock("orcasynapse-memory-policy-active"));
        const [current] = await transaction.select().from(memoryPolicy).where(eq(memoryPolicy.id, id)).limit(1);
        if (!current) throw new MemoryPolicyNotFoundError();
        if (current.status === "ACTIVE") throw new MemoryPolicyConflictError("The policy is already active.");
        const [other] = await transaction
          .select({ slug: memoryPolicy.slug })
          .from(memoryPolicy)
          .where(and(eq(memoryPolicy.status, "ACTIVE"), ne(memoryPolicy.id, id)))
          .limit(1);
        if (other) {
          throw new MemoryPolicyConflictError(`Suspend '${other.slug}' before activating another memory policy.`);
        }
        const activated = await transaction
          .update(memoryPolicy)
          .set({
            status: "ACTIVE",
            firstActivatedAt: current.firstActivatedAt ?? new Date(),
            revision: increment(memoryPolicy.revision),
            updatedBy: principal.id,
          })
          .where(and(
            eq(memoryPolicy.id, id),
            eq(memoryPolicy.revision, input.expectedRevision),
            eq(memoryPolicy.status, current.status),
          ))
          .returning();
        if (activated.length !== 1) {
          throw new MemoryPolicyConflictError("The policy changed in another session. Refresh and try again.");
        }
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "memory.policy_activated",
          resourceType: "MemoryPolicy",
          resourceId: id,
          outcome: "SUCCESS",
          metadata: { reason: input.reason, maximumCaptureMode: activated[0]!.maximumCaptureMode },
        });
        return dto(activated[0]!);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new MemoryPolicyConflictError("Only one memory policy can be active.");
      throw error;
    }
  }

  async suspend(principal: AdminPrincipal, id: string, input: ChangeMemoryPolicyState): Promise<MemoryPolicy> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-memory-policy:${id}`));
      const [current] = await transaction.select().from(memoryPolicy).where(eq(memoryPolicy.id, id)).limit(1);
      if (!current) throw new MemoryPolicyNotFoundError();
      if (current.status !== "ACTIVE") throw new MemoryPolicyConflictError("Only an active policy can be suspended.");
      const suspended = await transaction
        .update(memoryPolicy)
        .set({ status: "SUSPENDED", revision: increment(memoryPolicy.revision), updatedBy: principal.id })
        .where(and(
          eq(memoryPolicy.id, id),
          eq(memoryPolicy.revision, input.expectedRevision),
          eq(memoryPolicy.status, "ACTIVE"),
        ))
        .returning();
      if (suspended.length !== 1) {
        throw new MemoryPolicyConflictError("The policy changed in another session. Refresh and try again.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "memory.policy_suspended",
        resourceType: "MemoryPolicy",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason },
      });
      return dto(suspended[0]!);
    });
  }

  async records(query: AgentMemoryQuery): Promise<AgentMemoryRecordList> {
    const rows = await this.database
      .select({
        id: agentMemory.id,
        ownerSubject: agentMemory.ownerSubject,
        agentProfileId: agentMemory.agentProfileId,
        agentProfileSlug: agentProfile.slug,
        content: agentMemory.content,
        sourceRunId: agentMemory.sourceRunId,
        retentionUntil: agentMemory.retentionUntil,
        createdAt: agentMemory.createdAt,
      })
      .from(agentMemory)
      .innerJoin(agentProfile, eq(agentProfile.id, agentMemory.agentProfileId))
      .where(and(
        query.ownerSubject ? eq(agentMemory.ownerSubject, query.ownerSubject) : undefined,
        query.agentProfileId ? eq(agentMemory.agentProfileId, query.agentProfileId) : undefined,
      ))
      .orderBy(desc(agentMemory.createdAt))
      .limit(query.limit);
    return { items: rows.map(toRecord) };
  }

  async recordsForOwner(ownerSubject: string, limit = 100): Promise<AgentMemoryRecordList> {
    // The owner predicate is applied here rather than by the caller, so an
    // enterprise principal can never widen this to another person's memory.
    return this.records({ ownerSubject, limit } as AgentMemoryQuery);
  }

  async forget(principal: { id: string; ownerSubject?: string }, memoryId: string, reason: string): Promise<void> {
    const removed = await this.database
      .delete(agentMemory)
      .where(and(
        eq(agentMemory.id, memoryId),
        // Present for an enterprise principal, absent for an administrator:
        // one deletes only their own memory, the other governs all of it.
        principal.ownerSubject ? eq(agentMemory.ownerSubject, principal.ownerSubject) : undefined,
      ))
      .returning({ ownerSubject: agentMemory.ownerSubject });
    if (removed.length !== 1) throw new AgentMemoryNotFoundError();
    await this.database.insert(auditEvent).values({
      actorType: principal.ownerSubject ? "USER" : "USER",
      actorId: principal.id,
      action: "memory.deleted",
      resourceType: "AgentMemory",
      resourceId: memoryId,
      outcome: "SUCCESS",
      // The reason and the owner, never the content that was deleted.
      metadata: { reason, ownerSubject: removed[0]!.ownerSubject, selfService: Boolean(principal.ownerSubject) },
    });
  }

  async purge(principal: AdminPrincipal, input: PurgeAgentMemory): Promise<number> {
    const removed = await this.database
      .delete(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, input.ownerSubject),
        input.agentProfileId ? eq(agentMemory.agentProfileId, input.agentProfileId) : undefined,
      ))
      .returning({ id: agentMemory.id });
    await this.database.insert(auditEvent).values({
      actorType: "USER",
      actorId: principal.id,
      action: "memory.purged",
      resourceType: "AgentMemory",
      resourceId: input.ownerSubject.slice(0, 160),
      outcome: "SUCCESS",
      metadata: {
        reason: input.reason,
        ownerSubject: input.ownerSubject,
        agentProfileId: input.agentProfileId ?? null,
        removed: removed.length,
      },
    });
    return removed.length;
  }
}

function toRecord(row: {
  id: string;
  ownerSubject: string;
  agentProfileId: string;
  agentProfileSlug: string;
  content: string;
  sourceRunId: string | null;
  retentionUntil: Date | null;
  createdAt: Date;
}): AgentMemoryRecord {
  return {
    id: row.id,
    ownerSubject: row.ownerSubject,
    agentProfileId: row.agentProfileId,
    agentProfileSlug: row.agentProfileSlug,
    content: row.content,
    sourceRunId: row.sourceRunId,
    retentionUntil: row.retentionUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
