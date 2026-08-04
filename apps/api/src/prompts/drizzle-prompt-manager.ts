import { createHash } from "node:crypto";
import type {
  ChangePromptTemplateState,
  CreatePromptTemplate,
  PromptTemplate,
  PromptTemplateList,
  UpdatePromptTemplate,
} from "@orcasynapse/contracts";
import { and, arrayContains, asc, desc, eq, ne, sql } from "drizzle-orm";
import {
  auditEvent,
  evaluationRun,
  promptTemplate,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { PromptConflictError, PromptNotFoundError, type PromptManager } from "./prompt-manager.js";

type StoredPrompt = typeof promptTemplate.$inferSelect;

/** PostgreSQL unique-violation SQLSTATE, the driver-level equivalent of Prisma P2002. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps driver failures, so the SQLSTATE can sit on the thrown error or
 * on its cause chain depending on where the statement failed.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function checksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function dto(prompt: StoredPrompt): PromptTemplate {
  return {
    id: prompt.id,
    slug: prompt.slug,
    displayName: prompt.displayName,
    description: prompt.description,
    purpose: prompt.purpose,
    version: prompt.version,
    status: prompt.status,
    content: prompt.content,
    contentChecksum: prompt.contentChecksum,
    activationEvaluationId: prompt.activationEvaluationId,
    firstActivatedAt: prompt.firstActivatedAt?.toISOString() ?? null,
    revision: prompt.revision,
    createdBy: prompt.createdBy,
    updatedBy: prompt.updatedBy,
    createdAt: prompt.createdAt.toISOString(),
    updatedAt: prompt.updatedAt.toISOString(),
  };
}

function advisoryLock(key: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export class DrizzlePromptManager implements PromptManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async list(): Promise<PromptTemplateList> {
    const items = await this.database
      .select()
      .from(promptTemplate)
      .orderBy(asc(promptTemplate.purpose), asc(promptTemplate.status), desc(promptTemplate.updatedAt))
      .limit(100);
    return { items: items.map(dto) };
  }

  async create(principal: AdminPrincipal, input: CreatePromptTemplate): Promise<PromptTemplate> {
    try {
      const created = await this.database.transaction(async (transaction) => {
        const [prompt] = await transaction
          .insert(promptTemplate)
          .values({
            ...input,
            contentChecksum: checksum(input.content),
            createdBy: principal.id,
            updatedBy: principal.id,
          })
          .returning();
        if (!prompt) throw new PromptConflictError("The prompt template could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "prompt.template_created",
          resourceType: "PromptTemplate",
          resourceId: prompt.id,
          outcome: "SUCCESS",
          metadata: {
            slug: prompt.slug,
            purpose: prompt.purpose,
            version: prompt.version,
            contentChecksum: prompt.contentChecksum,
          },
        });
        return prompt;
      });
      return dto(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PromptConflictError("A prompt template already uses this slug.");
      }
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdatePromptTemplate): Promise<PromptTemplate> {
    return this.database.transaction(async (transaction) => {
      const { expectedRevision, ...changes } = input;
      await transaction.execute(advisoryLock(`orcasynapse-prompt:${id}`));
      const [current] = await transaction.select().from(promptTemplate).where(eq(promptTemplate.id, id));
      if (!current) throw new PromptNotFoundError();
      if (current.status === "ACTIVE") {
        throw new PromptConflictError("Suspend the active prompt before changing it.");
      }
      const contentChanged = changes.content !== undefined && changes.content !== current.content;
      if (contentChanged && (!changes.version || changes.version === current.version)) {
        throw new PromptConflictError("Prompt content changes require a new version.");
      }
      const versionChanged = changes.version !== undefined && changes.version !== current.version;
      const materialChange = contentChanged || versionChanged;

      const updated = await transaction
        .update(promptTemplate)
        .set({
          ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.version === undefined ? {} : { version: changes.version }),
          ...(changes.content === undefined
            ? {}
            : { content: changes.content, contentChecksum: checksum(changes.content) }),
          status: materialChange ? "DRAFT" : current.status,
          activationEvaluationId: materialChange ? null : current.activationEvaluationId,
          revision: sql`${promptTemplate.revision} + 1`,
          updatedBy: principal.id,
        })
        .where(
          and(
            eq(promptTemplate.id, id),
            eq(promptTemplate.revision, expectedRevision),
            eq(promptTemplate.status, current.status),
          ),
        )
        .returning();

      const saved = updated[0];
      if (!saved) {
        throw new PromptConflictError("The prompt changed in another session. Refresh and try again.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "prompt.template_updated",
        resourceType: "PromptTemplate",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: {
          revision: saved.revision,
          materialChange,
          version: saved.version,
          contentChecksum: saved.contentChecksum,
        },
      });
      return dto(saved);
    });
  }

  async activate(principal: AdminPrincipal, id: string, input: ChangePromptTemplateState): Promise<PromptTemplate> {
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(advisoryLock(`orcasynapse-prompt:${id}`));
        const [current] = await transaction.select().from(promptTemplate).where(eq(promptTemplate.id, id));
        if (!current) throw new PromptNotFoundError();
        if (current.status === "ACTIVE") throw new PromptConflictError("The prompt is already active.");

        await transaction.execute(advisoryLock(`orcasynapse-prompt-active:${current.purpose}`));
        const [existing] = await transaction
          .select({ displayName: promptTemplate.displayName })
          .from(promptTemplate)
          .where(
            and(
              eq(promptTemplate.purpose, current.purpose),
              eq(promptTemplate.status, "ACTIVE"),
              ne(promptTemplate.id, id),
            ),
          )
          .limit(1);
        if (existing) {
          throw new PromptConflictError(
            `Suspend '${existing.displayName}' before activating another ${current.purpose.toLowerCase()} prompt.`,
          );
        }

        const [evaluation] = await transaction
          .select({ id: evaluationRun.id })
          .from(evaluationRun)
          .where(
            and(
              eq(evaluationRun.targetType, "PROMPT"),
              eq(evaluationRun.targetReference, `prompt:${current.slug}`),
              eq(evaluationRun.targetVersion, current.version),
              eq(evaluationRun.status, "PROMOTED"),
              arrayContains(evaluationRun.requiredCategories, ["CHAT", "SAFETY"]),
            ),
          )
          .orderBy(desc(evaluationRun.promotedAt))
          .limit(1);
        if (!evaluation) {
          throw new PromptConflictError(
            `Activation requires promoted CHAT and SAFETY evaluation evidence for prompt:${current.slug} version ${current.version}.`,
          );
        }

        const activated = await transaction
          .update(promptTemplate)
          .set({
            status: "ACTIVE",
            activationEvaluationId: evaluation.id,
            firstActivatedAt: current.firstActivatedAt ?? new Date(),
            revision: sql`${promptTemplate.revision} + 1`,
            updatedBy: principal.id,
          })
          .where(
            and(
              eq(promptTemplate.id, id),
              eq(promptTemplate.revision, input.expectedRevision),
              eq(promptTemplate.status, current.status),
            ),
          )
          .returning();

        const saved = activated[0];
        if (!saved) {
          throw new PromptConflictError("The prompt changed in another session. Refresh and try again.");
        }
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "prompt.template_activated",
          resourceType: "PromptTemplate",
          resourceId: id,
          outcome: "SUCCESS",
          metadata: {
            reason: input.reason,
            evaluationRunId: evaluation.id,
            purpose: current.purpose,
            version: current.version,
            contentChecksum: current.contentChecksum,
          },
        });
        return dto(saved);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PromptConflictError("Only one prompt can be active for each purpose.");
      }
      throw error;
    }
  }

  async suspend(principal: AdminPrincipal, id: string, input: ChangePromptTemplateState): Promise<PromptTemplate> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-prompt:${id}`));
      const [current] = await transaction.select().from(promptTemplate).where(eq(promptTemplate.id, id));
      if (!current) throw new PromptNotFoundError();
      if (current.status !== "ACTIVE") throw new PromptConflictError("Only an active prompt can be suspended.");

      const suspended = await transaction
        .update(promptTemplate)
        .set({ status: "SUSPENDED", revision: sql`${promptTemplate.revision} + 1`, updatedBy: principal.id })
        .where(
          and(
            eq(promptTemplate.id, id),
            eq(promptTemplate.revision, input.expectedRevision),
            eq(promptTemplate.status, "ACTIVE"),
          ),
        )
        .returning();

      const saved = suspended[0];
      if (!saved) throw new PromptConflictError("The prompt changed in another session. Refresh and try again.");
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "prompt.template_suspended",
        resourceType: "PromptTemplate",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: {
          reason: input.reason,
          purpose: current.purpose,
          version: current.version,
          contentChecksum: current.contentChecksum,
        },
      });
      return dto(saved);
    });
  }
}
