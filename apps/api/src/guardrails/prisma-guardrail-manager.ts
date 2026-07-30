import type {
  ChangeGuardrailPolicyState,
  CreateGuardrailPolicy,
  GuardrailPolicy,
  GuardrailPolicyList,
  UpdateGuardrailPolicy,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { GuardrailConflictError, GuardrailNotFoundError, type GuardrailManager } from "./guardrail-manager.js";

type StoredPolicy = Prisma.GuardrailPolicyGetPayload<Record<string, never>>;

function dto(policy: StoredPolicy): GuardrailPolicy {
  return {
    id: policy.id,
    slug: policy.slug,
    displayName: policy.displayName,
    description: policy.description,
    version: policy.version,
    status: policy.status,
    liteLLMGuardrails: policy.liteLLMGuardrails,
    maxInputCharacters: policy.maxInputCharacters,
    activationEvaluationId: policy.activationEvaluationId,
    firstActivatedAt: policy.firstActivatedAt?.toISOString() ?? null,
    revision: policy.revision,
    createdBy: policy.createdBy,
    updatedBy: policy.updatedBy,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export class PrismaGuardrailManager implements GuardrailManager {
  constructor(private readonly prisma: AIHubPrismaClient) {}

  async list(): Promise<GuardrailPolicyList> {
    const items = await this.prisma.guardrailPolicy.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: 100,
    });
    return { items: items.map(dto) };
  }

  async create(principal: AdminPrincipal, input: CreateGuardrailPolicy): Promise<GuardrailPolicy> {
    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const policy = await transaction.guardrailPolicy.create({
          data: { ...input, createdBy: principal.id, updatedBy: principal.id },
        });
        await transaction.auditEvent.create({ data: {
          actorType: "USER",
          actorId: principal.id,
          action: "guardrail.policy_created",
          resourceType: "GuardrailPolicy",
          resourceId: policy.id,
          outcome: "SUCCESS",
          metadata: { slug: policy.slug, version: policy.version, guardrailCount: policy.liteLLMGuardrails.length },
        } });
        return policy;
      });
      return dto(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new GuardrailConflictError("A guardrail policy already uses this slug.");
      }
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdateGuardrailPolicy): Promise<GuardrailPolicy> {
    return this.prisma.$transaction(async (transaction) => {
      const { expectedRevision, ...changes } = input;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-guardrail:${id}`}, 0))`;
      const current = await transaction.guardrailPolicy.findUnique({ where: { id } });
      if (!current) throw new GuardrailNotFoundError();
      if (current.status === "ACTIVE") {
        throw new GuardrailConflictError("Suspend the active policy before changing it.");
      }
      const materialChange = (
        (changes.version !== undefined && changes.version !== current.version)
        || (changes.maxInputCharacters !== undefined && changes.maxInputCharacters !== current.maxInputCharacters)
        || (changes.liteLLMGuardrails !== undefined && !sameNames(changes.liteLLMGuardrails, current.liteLLMGuardrails))
      );
      if (materialChange && (!changes.version || changes.version === current.version)) {
        throw new GuardrailConflictError("Guardrail or input-limit changes require a new policy version.");
      }
      const updateData: Prisma.GuardrailPolicyUncheckedUpdateManyInput = {
        status: materialChange ? "DRAFT" : current.status,
        activationEvaluationId: materialChange ? null : current.activationEvaluationId,
        revision: { increment: 1 },
        updatedBy: principal.id,
      };
      if (changes.displayName !== undefined) updateData.displayName = changes.displayName;
      if (changes.description !== undefined) updateData.description = changes.description;
      if (changes.version !== undefined) updateData.version = changes.version;
      if (changes.liteLLMGuardrails !== undefined) updateData.liteLLMGuardrails = changes.liteLLMGuardrails;
      if (changes.maxInputCharacters !== undefined) updateData.maxInputCharacters = changes.maxInputCharacters;
      const updated = await transaction.guardrailPolicy.updateMany({
        where: { id, revision: expectedRevision, status: current.status },
        data: updateData,
      });
      if (updated.count !== 1) {
        throw new GuardrailConflictError("The policy changed in another session. Refresh and try again.");
      }
      const saved = await transaction.guardrailPolicy.findUniqueOrThrow({ where: { id } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "guardrail.policy_updated",
        resourceType: "GuardrailPolicy",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { revision: saved.revision, materialChange, version: saved.version },
      } });
      return dto(saved);
    });
  }

  async activate(principal: AdminPrincipal, id: string, input: ChangeGuardrailPolicyState): Promise<GuardrailPolicy> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-guardrail:${id}`}, 0))`;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('aihub-guardrail-active', 0))`;
      const current = await transaction.guardrailPolicy.findUnique({ where: { id } });
      if (!current) throw new GuardrailNotFoundError();
      if (current.status === "ACTIVE") throw new GuardrailConflictError("The policy is already active.");
      const existing = await transaction.guardrailPolicy.findFirst({
        where: { status: "ACTIVE", id: { not: id } },
        select: { displayName: true },
      });
      if (existing) throw new GuardrailConflictError(`Suspend '${existing.displayName}' before activating another chat policy.`);

      const catalogueEnforced = await transaction.modelDeployment.count({
        where: { workload: "CHAT", firstActivatedAt: { not: null } },
      }) > 0;
      const modelRoute = catalogueEnforced ? await transaction.modelDeployment.findFirst({
        where: { workload: "CHAT", status: "ACTIVE", isDefault: true },
        select: { connection: { select: { kind: true, enabled: true, status: true } } },
      }) : null;
      const legacyConnections = catalogueEnforced ? [] : await transaction.serviceConnection.findMany({
        where: { kind: "LITELLM", enabled: true },
        select: { kind: true, enabled: true, status: true },
        take: 2,
      });
      const servingConnection = modelRoute?.connection ?? (legacyConnections.length === 1 ? legacyConnections[0] : null);
      if (!servingConnection || servingConnection.kind !== "LITELLM" || !servingConnection.enabled || servingConnection.status !== "HEALTHY") {
        throw new GuardrailConflictError("One effective LiteLLM chat connection must be enabled and healthy before policy activation.");
      }

      const evaluation = await transaction.evaluationRun.findFirst({
        where: {
          targetType: "POLICY",
          targetReference: `policy:${current.slug}`,
          targetVersion: current.version,
          status: "PROMOTED",
          requiredCategories: { has: "SAFETY" },
        },
        orderBy: { promotedAt: "desc" },
        select: { id: true },
      });
      if (!evaluation) {
        throw new GuardrailConflictError(`Activation requires promoted safety evaluation evidence for policy:${current.slug} version ${current.version}.`);
      }
      const activated = await transaction.guardrailPolicy.updateMany({
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
        throw new GuardrailConflictError("The policy changed in another session. Refresh and try again.");
      }
      const saved = await transaction.guardrailPolicy.findUniqueOrThrow({ where: { id } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "guardrail.policy_activated",
        resourceType: "GuardrailPolicy",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, evaluationRunId: evaluation.id, version: current.version, liteLLMGuardrails: current.liteLLMGuardrails },
      } });
      return dto(saved);
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new GuardrailConflictError("Only one chat guardrail policy can be active.");
      }
      throw error;
    });
  }

  async suspend(principal: AdminPrincipal, id: string, input: ChangeGuardrailPolicyState): Promise<GuardrailPolicy> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-guardrail:${id}`}, 0))`;
      const current = await transaction.guardrailPolicy.findUnique({ where: { id } });
      if (!current) throw new GuardrailNotFoundError();
      if (current.status !== "ACTIVE") throw new GuardrailConflictError("Only the active policy can be suspended.");
      const suspended = await transaction.guardrailPolicy.updateMany({
        where: { id, revision: input.expectedRevision, status: "ACTIVE" },
        data: { status: "SUSPENDED", revision: { increment: 1 }, updatedBy: principal.id },
      });
      if (suspended.count !== 1) {
        throw new GuardrailConflictError("The policy changed in another session. Refresh and try again.");
      }
      const saved = await transaction.guardrailPolicy.findUniqueOrThrow({ where: { id } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "guardrail.policy_suspended",
        resourceType: "GuardrailPolicy",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, version: current.version },
      } });
      return dto(saved);
    });
  }
}
