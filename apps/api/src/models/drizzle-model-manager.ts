import type {
  ChangeModelDeploymentState,
  CreateModelDeployment,
  ModelDeployment,
  ModelDeploymentList,
  ModelWorkload,
  ServiceKind,
  UpdateModelDeployment,
} from "@orcasynapse/contracts";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  auditEvent,
  modelDeployment,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import { ModelConflictError, ModelNotFoundError, type ModelManager } from "./model-manager.js";

/** The database handle or a transaction opened from it. */
type Executor = OrcaSynapseDatabase | Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0];

interface RoutedConnection {
  id: string;
  displayName: string;
  kind: ServiceKind;
  environment: "DEVELOPMENT" | "STAGING" | "PRODUCTION";
  enabled: boolean;
  status: "NOT_TESTED" | "HEALTHY" | "DEGRADED" | "UNREACHABLE" | "DISABLED";
}

type StoredModel = typeof modelDeployment.$inferSelect & { connection: RoutedConnection };

const connectionColumns = {
  id: serviceConnection.id,
  displayName: serviceConnection.displayName,
  kind: serviceConnection.kind,
  environment: serviceConnection.environment,
  enabled: serviceConnection.enabled,
  status: serviceConnection.status,
} as const;

const permittedKinds: Readonly<Record<ModelWorkload, readonly ServiceKind[]>> = {
  CHAT: ["INFERENCE"],
  AGENT: ["INFERENCE"],
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
    firstActivatedAt: model.firstActivatedAt?.toISOString() ?? null,
    revision: model.revision,
    createdBy: model.createdBy,
    updatedBy: model.updatedBy,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function assertConnectionKind(workload: ModelWorkload, connection: RoutedConnection): void {
  if (!permittedKinds[workload].includes(connection.kind)) {
    throw new ModelConflictError(`${workload.toLowerCase()} routes cannot use a ${connection.kind} connection.`);
  }
}

function assertLimits(contextWindowTokens: number, maxOutputTokens: number): void {
  if (maxOutputTokens > contextWindowTokens) {
    throw new ModelConflictError("Maximum output tokens cannot exceed the context window.");
  }
}

/** A route is only meaningful with the connection it serves through, so every
 *  read joins rather than leaving callers to fetch it separately. */
async function routeWithConnection(executor: Executor, id: string): Promise<StoredModel | undefined> {
  const [row] = await executor
    .select({ model: modelDeployment, connection: connectionColumns })
    .from(modelDeployment)
    .innerJoin(serviceConnection, eq(serviceConnection.id, modelDeployment.connectionId))
    .where(eq(modelDeployment.id, id))
    .limit(1);
  return row ? { ...row.model, connection: row.connection } : undefined;
}

export class DrizzleModelManager implements ModelManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async list(): Promise<ModelDeploymentList> {
    const rows = await this.database
      .select({ model: modelDeployment, connection: connectionColumns })
      .from(modelDeployment)
      .innerJoin(serviceConnection, eq(serviceConnection.id, modelDeployment.connectionId))
      .orderBy(asc(modelDeployment.workload), desc(modelDeployment.isDefault), desc(modelDeployment.updatedAt))
      .limit(200);
    return { items: rows.map((row) => dto({ ...row.model, connection: row.connection })) };
  }

  async create(principal: AdminPrincipal, input: CreateModelDeployment): Promise<ModelDeployment> {
    const [connection] = await this.database
      .select(connectionColumns)
      .from(serviceConnection)
      .where(eq(serviceConnection.id, input.connectionId))
      .limit(1);
    if (!connection) throw new ModelConflictError("The selected service connection does not exist.");
    assertConnectionKind(input.workload, connection);
    assertLimits(input.contextWindowTokens, input.maxOutputTokens);

    try {
      const created = await this.database.transaction(async (transaction) => {
        const [model] = await transaction
          .insert(modelDeployment)
          .values({ ...input, createdBy: principal.id, updatedBy: principal.id })
          .returning();
        if (!model) throw new ModelConflictError("The model route could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "model.route_created",
          resourceType: "ModelDeployment",
          resourceId: model.id,
          outcome: "SUCCESS",
          metadata: { slug: model.slug, workload: model.workload, version: model.version },
        });
        return { ...model, connection };
      });
      return dto(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ModelConflictError("A model route already uses this slug or workload alias.");
      }
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdateModelDeployment): Promise<ModelDeployment> {
    try {
      return await this.database.transaction(async (transaction) => {
        const { expectedRevision, ...changes } = input;
        await transaction.execute(advisoryLock(`orcasynapse-model:${id}`));
        const current = await routeWithConnection(transaction, id);
        if (!current) throw new ModelNotFoundError();
        if (current.status === "ACTIVE") {
          throw new ModelConflictError("Suspend an active model route before changing its configuration.");
        }

        let connection = current.connection;
        if (input.connectionId && input.connectionId !== current.connectionId) {
          const [replacement] = await transaction
            .select(connectionColumns)
            .from(serviceConnection)
            .where(eq(serviceConnection.id, input.connectionId))
            .limit(1);
          if (!replacement) throw new ModelConflictError("The selected service connection does not exist.");
          connection = replacement;
        }
        assertConnectionKind(current.workload, connection);

        const contextWindowTokens = input.contextWindowTokens ?? current.contextWindowTokens;
        const maxOutputTokens = input.maxOutputTokens ?? current.maxOutputTokens;
        assertLimits(contextWindowTokens, maxOutputTokens);

        const materialChange =
          (input.modelAlias !== undefined && input.modelAlias !== current.modelAlias)
          || (input.connectionId !== undefined && input.connectionId !== current.connectionId)
          || (input.contextWindowTokens !== undefined && input.contextWindowTokens !== current.contextWindowTokens)
          || (input.maxOutputTokens !== undefined && input.maxOutputTokens !== current.maxOutputTokens)
          || (input.maxConcurrentRequests !== undefined && input.maxConcurrentRequests !== current.maxConcurrentRequests)
          || (input.version !== undefined && input.version !== current.version);
        if (materialChange && (!input.version || input.version === current.version)) {
          throw new ModelConflictError("Material route changes require a new model version.");
        }

        const updated = await transaction
          .update(modelDeployment)
          .set({
            ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
            ...(changes.modelAlias === undefined ? {} : { modelAlias: changes.modelAlias }),
            ...(changes.connectionId === undefined ? {} : { connectionId: changes.connectionId }),
            ...(changes.version === undefined ? {} : { version: changes.version }),
            ...(changes.license === undefined ? {} : { license: changes.license }),
            ...(changes.contextWindowTokens === undefined ? {} : { contextWindowTokens: changes.contextWindowTokens }),
            ...(changes.maxOutputTokens === undefined ? {} : { maxOutputTokens: changes.maxOutputTokens }),
            ...(changes.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: changes.maxConcurrentRequests }),
            status: materialChange ? "DRAFT" : current.status,
            isDefault: false,
            revision: increment(modelDeployment.revision),
            updatedBy: principal.id,
          })
          .where(
            and(
              eq(modelDeployment.id, id),
              eq(modelDeployment.revision, expectedRevision),
              eq(modelDeployment.status, current.status),
            ),
          )
          .returning();

        if (!updated[0]) {
          throw new ModelConflictError("The model route changed in another session. Refresh and try again.");
        }
        const saved = await routeWithConnection(transaction, id);
        if (!saved) throw new ModelNotFoundError();
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "model.route_updated",
          resourceType: "ModelDeployment",
          resourceId: id,
          outcome: "SUCCESS",
          metadata: { revision: saved.revision, materialChange, version: saved.version },
        });
        return dto(saved);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ModelConflictError("A model route already uses this workload alias.");
      }
      throw error;
    }
  }

  async activate(principal: AdminPrincipal, id: string, input: ChangeModelDeploymentState): Promise<ModelDeployment> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-model:${id}`));
      const current = await routeWithConnection(transaction, id);
      if (!current) throw new ModelNotFoundError();
      if (current.status === "ACTIVE") throw new ModelConflictError("The model route is already active.");
      assertConnectionKind(current.workload, current.connection);
      if (!current.connection.enabled || current.connection.status !== "HEALTHY") {
        throw new ModelConflictError("The selected serving connection must be enabled and healthy before activation.");
      }

      // Held for the rest of the transaction so demoting the incumbent default
      // and promoting this route cannot interleave with a concurrent activation.
      await transaction.execute(advisoryLock(`orcasynapse-model-default:${current.workload}`));
      if (input.makeDefault) {
        await transaction
          .update(modelDeployment)
          .set({ isDefault: false, revision: increment(modelDeployment.revision) })
          .where(and(eq(modelDeployment.workload, current.workload), eq(modelDeployment.isDefault, true)));
      }

      const activated = await transaction
        .update(modelDeployment)
        .set({
          status: "ACTIVE",
          isDefault: input.makeDefault,
          firstActivatedAt: current.firstActivatedAt ?? new Date(),
          revision: increment(modelDeployment.revision),
          updatedBy: principal.id,
        })
        .where(
          and(
            eq(modelDeployment.id, id),
            eq(modelDeployment.revision, input.expectedRevision),
            eq(modelDeployment.status, current.status),
          ),
        )
        .returning();
      if (!activated[0]) {
        throw new ModelConflictError("The model route changed in another session. Refresh and try again.");
      }

      const saved = await routeWithConnection(transaction, id);
      if (!saved) throw new ModelNotFoundError();
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "model.route_activated",
        resourceType: "ModelDeployment",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: {
          reason: input.reason,
          version: current.version,
          makeDefault: input.makeDefault,
        },
      });
      return dto(saved);
    });
  }

  async suspend(principal: AdminPrincipal, id: string, input: ChangeModelDeploymentState): Promise<ModelDeployment> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-model:${id}`));
      const current = await routeWithConnection(transaction, id);
      if (!current) throw new ModelNotFoundError();
      if (current.status !== "ACTIVE") throw new ModelConflictError("Only an active model route can be suspended.");

      const suspended = await transaction
        .update(modelDeployment)
        .set({
          status: "SUSPENDED",
          isDefault: false,
          revision: increment(modelDeployment.revision),
          updatedBy: principal.id,
        })
        .where(
          and(
            eq(modelDeployment.id, id),
            eq(modelDeployment.revision, input.expectedRevision),
            eq(modelDeployment.status, "ACTIVE"),
          ),
        )
        .returning();
      if (!suspended[0]) {
        throw new ModelConflictError("The model route changed in another session. Refresh and try again.");
      }

      const saved = await routeWithConnection(transaction, id);
      if (!saved) throw new ModelNotFoundError();
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "model.route_suspended",
        resourceType: "ModelDeployment",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, version: current.version },
      });
      return dto(saved);
    });
  }
}
