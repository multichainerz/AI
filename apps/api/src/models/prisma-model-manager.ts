import type {
  ChangeModelDeploymentState,
  CreateModelDeployment,
  ModelDeployment,
  ModelDeploymentList,
  ModelWorkload,
  ServiceKind,
  UpdateModelDeployment,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { ModelConflictError, ModelNotFoundError, type ModelManager } from "./model-manager.js";

const connectionSelect = {
  id: true,
  displayName: true,
  kind: true,
  environment: true,
  enabled: true,
  status: true,
} as const;

const modelInclude = { connection: { select: connectionSelect } } as const;

type StoredModel = Prisma.ModelDeploymentGetPayload<{ include: typeof modelInclude }>;
type StoredConnection = StoredModel["connection"];

const permittedKinds: Readonly<Record<ModelWorkload, readonly ServiceKind[]>> = {
  CHAT: ["VLLM"],
  AGENT: ["VLLM"],
};

function dto(model: StoredModel): ModelDeployment {
  return {
    id: model.id,
    slug: model.slug,
    displayName: model.displayName,
    modelAlias: model.modelAlias,
    workload: model.workload,
    status: model.status,
    connection: model.connection,
    version: model.version,
    license: model.license,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    maxConcurrentRequests: model.maxConcurrentRequests,
    isDefault: model.isDefault,
    activationEvaluationId: model.activationEvaluationId,
    firstActivatedAt: model.firstActivatedAt?.toISOString() ?? null,
    revision: model.revision,
    createdBy: model.createdBy,
    updatedBy: model.updatedBy,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function assertConnectionKind(workload: ModelWorkload, connection: StoredConnection): void {
  if (!permittedKinds[workload].includes(connection.kind)) {
    throw new ModelConflictError(`${workload.toLowerCase()} routes cannot use a ${connection.kind} connection.`);
  }
}

function assertLimits(contextWindowTokens: number, maxOutputTokens: number): void {
  if (maxOutputTokens > contextWindowTokens) {
    throw new ModelConflictError("Maximum output tokens cannot exceed the context window.");
  }
}

export class PrismaModelManager implements ModelManager {
  constructor(private readonly prisma: AIHubPrismaClient) {}

  async list(): Promise<ModelDeploymentList> {
    const items = await this.prisma.modelDeployment.findMany({
      include: modelInclude,
      orderBy: [{ workload: "asc" }, { isDefault: "desc" }, { updatedAt: "desc" }],
      take: 200,
    });
    return { items: items.map(dto) };
  }

  async create(principal: AdminPrincipal, input: CreateModelDeployment): Promise<ModelDeployment> {
    const connection = await this.prisma.serviceConnection.findUnique({
      where: { id: input.connectionId },
      select: connectionSelect,
    });
    if (!connection) throw new ModelConflictError("The selected service connection does not exist.");
    assertConnectionKind(input.workload, connection);
    assertLimits(input.contextWindowTokens, input.maxOutputTokens);
    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const model = await transaction.modelDeployment.create({
          data: { ...input, createdBy: principal.id, updatedBy: principal.id },
          include: modelInclude,
        });
        await transaction.auditEvent.create({ data: {
          actorType: "USER",
          actorId: principal.id,
          action: "model.route_created",
          resourceType: "ModelDeployment",
          resourceId: model.id,
          outcome: "SUCCESS",
          metadata: { slug: model.slug, workload: model.workload, version: model.version },
        } });
        return model;
      });
      return dto(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ModelConflictError("A model route already uses this slug or workload alias.");
      }
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdateModelDeployment): Promise<ModelDeployment> {
    return this.prisma.$transaction(async (transaction) => {
      const { expectedRevision, ...changes } = input;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-model:${id}`}, 0))`;
      const current = await transaction.modelDeployment.findUnique({ where: { id }, include: modelInclude });
      if (!current) throw new ModelNotFoundError();
      if (current.status === "ACTIVE") {
        throw new ModelConflictError("Suspend an active model route before changing its configuration.");
      }
      const connection = input.connectionId && input.connectionId !== current.connectionId
        ? await transaction.serviceConnection.findUnique({ where: { id: input.connectionId }, select: connectionSelect })
        : current.connection;
      if (!connection) throw new ModelConflictError("The selected service connection does not exist.");
      assertConnectionKind(current.workload, connection);
      const contextWindowTokens = input.contextWindowTokens ?? current.contextWindowTokens;
      const maxOutputTokens = input.maxOutputTokens ?? current.maxOutputTokens;
      assertLimits(contextWindowTokens, maxOutputTokens);
      const materialChange = (
        (input.modelAlias !== undefined && input.modelAlias !== current.modelAlias)
        || (input.connectionId !== undefined && input.connectionId !== current.connectionId)
        || (input.contextWindowTokens !== undefined && input.contextWindowTokens !== current.contextWindowTokens)
        || (input.maxOutputTokens !== undefined && input.maxOutputTokens !== current.maxOutputTokens)
        || (input.maxConcurrentRequests !== undefined && input.maxConcurrentRequests !== current.maxConcurrentRequests)
        || (input.version !== undefined && input.version !== current.version)
      );
      if (materialChange && (!input.version || input.version === current.version)) {
        throw new ModelConflictError("Material route changes require a new model version.");
      }
      const updateData: Prisma.ModelDeploymentUncheckedUpdateManyInput = {
        status: materialChange ? "DRAFT" : current.status,
        isDefault: false,
        activationEvaluationId: materialChange ? null : current.activationEvaluationId,
        revision: { increment: 1 },
        updatedBy: principal.id,
      };
      if (changes.displayName !== undefined) updateData.displayName = changes.displayName;
      if (changes.modelAlias !== undefined) updateData.modelAlias = changes.modelAlias;
      if (changes.connectionId !== undefined) updateData.connectionId = changes.connectionId;
      if (changes.version !== undefined) updateData.version = changes.version;
      if (changes.license !== undefined) updateData.license = changes.license;
      if (changes.contextWindowTokens !== undefined) updateData.contextWindowTokens = changes.contextWindowTokens;
      if (changes.maxOutputTokens !== undefined) updateData.maxOutputTokens = changes.maxOutputTokens;
      if (changes.maxConcurrentRequests !== undefined) updateData.maxConcurrentRequests = changes.maxConcurrentRequests;
      const updated = await transaction.modelDeployment.updateMany({
        where: { id, revision: expectedRevision, status: current.status },
        data: updateData,
      });
      if (updated.count !== 1) throw new ModelConflictError("The model route changed in another session. Refresh and try again.");
      const saved = await transaction.modelDeployment.findUniqueOrThrow({ where: { id }, include: modelInclude });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "model.route_updated",
        resourceType: "ModelDeployment",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { revision: saved.revision, materialChange, version: saved.version },
      } });
      return dto(saved);
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ModelConflictError("A model route already uses this workload alias.");
      }
      throw error;
    });
  }

  async activate(principal: AdminPrincipal, id: string, input: ChangeModelDeploymentState): Promise<ModelDeployment> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-model:${id}`}, 0))`;
      const current = await transaction.modelDeployment.findUnique({ where: { id }, include: modelInclude });
      if (!current) throw new ModelNotFoundError();
      if (current.status === "ACTIVE") throw new ModelConflictError("The model route is already active.");
      assertConnectionKind(current.workload, current.connection);
      if (!current.connection.enabled || current.connection.status !== "HEALTHY") {
        throw new ModelConflictError("The selected serving connection must be enabled and healthy before activation.");
      }
      const evaluation = await transaction.evaluationRun.findFirst({
        where: {
          targetType: "MODEL",
          targetReference: `model:${current.slug}`,
          targetVersion: current.version,
          status: "PROMOTED",
        },
        orderBy: { promotedAt: "desc" },
        select: { id: true },
      });
      if (!evaluation) {
        throw new ModelConflictError(`Activation requires promoted evaluation evidence for model:${current.slug} version ${current.version}.`);
      }
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-model-default:${current.workload}`}, 0))`;
      if (input.makeDefault) {
        await transaction.modelDeployment.updateMany({
          where: { workload: current.workload, isDefault: true },
          data: { isDefault: false, revision: { increment: 1 } },
        });
      }
      const activated = await transaction.modelDeployment.updateMany({
        where: { id, revision: input.expectedRevision, status: current.status },
        data: {
          status: "ACTIVE",
          isDefault: input.makeDefault,
          activationEvaluationId: evaluation.id,
          firstActivatedAt: current.firstActivatedAt ?? new Date(),
          revision: { increment: 1 },
          updatedBy: principal.id,
        },
      });
      if (activated.count !== 1) throw new ModelConflictError("The model route changed in another session. Refresh and try again.");
      const saved = await transaction.modelDeployment.findUniqueOrThrow({ where: { id }, include: modelInclude });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "model.route_activated",
        resourceType: "ModelDeployment",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, evaluationRunId: evaluation.id, version: current.version, makeDefault: input.makeDefault },
      } });
      return dto(saved);
    });
  }

  async suspend(principal: AdminPrincipal, id: string, input: ChangeModelDeploymentState): Promise<ModelDeployment> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-model:${id}`}, 0))`;
      const current = await transaction.modelDeployment.findUnique({ where: { id }, include: modelInclude });
      if (!current) throw new ModelNotFoundError();
      if (current.status !== "ACTIVE") throw new ModelConflictError("Only an active model route can be suspended.");
      const suspended = await transaction.modelDeployment.updateMany({
        where: { id, revision: input.expectedRevision, status: "ACTIVE" },
        data: { status: "SUSPENDED", isDefault: false, revision: { increment: 1 }, updatedBy: principal.id },
      });
      if (suspended.count !== 1) throw new ModelConflictError("The model route changed in another session. Refresh and try again.");
      const saved = await transaction.modelDeployment.findUniqueOrThrow({ where: { id }, include: modelInclude });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "model.route_suspended",
        resourceType: "ModelDeployment",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, version: current.version },
      } });
      return dto(saved);
    });
  }
}
