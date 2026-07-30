import { createHash } from "node:crypto";
import type {
  ChangePromptTemplateState,
  CreatePromptTemplate,
  PromptTemplate,
  PromptTemplateList,
  UpdatePromptTemplate,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { PromptConflictError, PromptNotFoundError, type PromptManager } from "./prompt-manager.js";

type StoredPrompt = Prisma.PromptTemplateGetPayload<Record<string, never>>;

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

export class PrismaPromptManager implements PromptManager {
  constructor(private readonly prisma: AIHubPrismaClient) {}

  async list(): Promise<PromptTemplateList> {
    const items = await this.prisma.promptTemplate.findMany({
      orderBy: [{ purpose: "asc" }, { status: "asc" }, { updatedAt: "desc" }],
      take: 100,
    });
    return { items: items.map(dto) };
  }

  async create(principal: AdminPrincipal, input: CreatePromptTemplate): Promise<PromptTemplate> {
    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const prompt = await transaction.promptTemplate.create({
          data: {
            ...input,
            contentChecksum: checksum(input.content),
            createdBy: principal.id,
            updatedBy: principal.id,
          },
        });
        await transaction.auditEvent.create({ data: {
          actorType: "USER",
          actorId: principal.id,
          action: "prompt.template_created",
          resourceType: "PromptTemplate",
          resourceId: prompt.id,
          outcome: "SUCCESS",
          metadata: { slug: prompt.slug, purpose: prompt.purpose, version: prompt.version, contentChecksum: prompt.contentChecksum },
        } });
        return prompt;
      });
      return dto(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new PromptConflictError("A prompt template already uses this slug.");
      }
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdatePromptTemplate): Promise<PromptTemplate> {
    return this.prisma.$transaction(async (transaction) => {
      const { expectedRevision, ...changes } = input;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-prompt:${id}`}, 0))`;
      const current = await transaction.promptTemplate.findUnique({ where: { id } });
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
      const updated = await transaction.promptTemplate.updateMany({
        where: { id, revision: expectedRevision, status: current.status },
        data: {
          ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.version === undefined ? {} : { version: changes.version }),
          ...(changes.content === undefined ? {} : { content: changes.content, contentChecksum: checksum(changes.content) }),
          status: materialChange ? "DRAFT" : current.status,
          activationEvaluationId: materialChange ? null : current.activationEvaluationId,
          revision: { increment: 1 },
          updatedBy: principal.id,
        },
      });
      if (updated.count !== 1) {
        throw new PromptConflictError("The prompt changed in another session. Refresh and try again.");
      }
      const saved = await transaction.promptTemplate.findUniqueOrThrow({ where: { id } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "prompt.template_updated",
        resourceType: "PromptTemplate",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { revision: saved.revision, materialChange, version: saved.version, contentChecksum: saved.contentChecksum },
      } });
      return dto(saved);
    });
  }

  async activate(principal: AdminPrincipal, id: string, input: ChangePromptTemplateState): Promise<PromptTemplate> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-prompt:${id}`}, 0))`;
      const current = await transaction.promptTemplate.findUnique({ where: { id } });
      if (!current) throw new PromptNotFoundError();
      if (current.status === "ACTIVE") throw new PromptConflictError("The prompt is already active.");
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-prompt-active:${current.purpose}`}, 0))`;
      const existing = await transaction.promptTemplate.findFirst({
        where: { purpose: current.purpose, status: "ACTIVE", id: { not: id } },
        select: { displayName: true },
      });
      if (existing) throw new PromptConflictError(`Suspend '${existing.displayName}' before activating another ${current.purpose.toLowerCase()} prompt.`);
      const evaluation = await transaction.evaluationRun.findFirst({
        where: {
          targetType: "PROMPT",
          targetReference: `prompt:${current.slug}`,
          targetVersion: current.version,
          status: "PROMOTED",
          requiredCategories: { hasEvery: ["CHAT", "SAFETY"] },
        },
        orderBy: { promotedAt: "desc" },
        select: { id: true },
      });
      if (!evaluation) {
        throw new PromptConflictError(`Activation requires promoted CHAT and SAFETY evaluation evidence for prompt:${current.slug} version ${current.version}.`);
      }
      const activated = await transaction.promptTemplate.updateMany({
        where: { id, revision: input.expectedRevision, status: current.status },
        data: {
          status: "ACTIVE",
          activationEvaluationId: evaluation.id,
          firstActivatedAt: current.firstActivatedAt ?? new Date(),
          revision: { increment: 1 },
          updatedBy: principal.id,
        },
      });
      if (activated.count !== 1) {
        throw new PromptConflictError("The prompt changed in another session. Refresh and try again.");
      }
      const saved = await transaction.promptTemplate.findUniqueOrThrow({ where: { id } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "prompt.template_activated",
        resourceType: "PromptTemplate",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, evaluationRunId: evaluation.id, purpose: current.purpose, version: current.version, contentChecksum: current.contentChecksum },
      } });
      return dto(saved);
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new PromptConflictError("Only one prompt can be active for each purpose.");
      }
      throw error;
    });
  }

  async suspend(principal: AdminPrincipal, id: string, input: ChangePromptTemplateState): Promise<PromptTemplate> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-prompt:${id}`}, 0))`;
      const current = await transaction.promptTemplate.findUnique({ where: { id } });
      if (!current) throw new PromptNotFoundError();
      if (current.status !== "ACTIVE") throw new PromptConflictError("Only an active prompt can be suspended.");
      const suspended = await transaction.promptTemplate.updateMany({
        where: { id, revision: input.expectedRevision, status: "ACTIVE" },
        data: { status: "SUSPENDED", revision: { increment: 1 }, updatedBy: principal.id },
      });
      if (suspended.count !== 1) throw new PromptConflictError("The prompt changed in another session. Refresh and try again.");
      const saved = await transaction.promptTemplate.findUniqueOrThrow({ where: { id } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "prompt.template_suspended",
        resourceType: "PromptTemplate",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, purpose: current.purpose, version: current.version, contentChecksum: current.contentChecksum },
      } });
      return dto(saved);
    });
  }
}
