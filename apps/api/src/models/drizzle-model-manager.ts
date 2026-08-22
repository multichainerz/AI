import type {
  ChangeModelDeploymentState,
  CreateModelDeployment,
  ModelDeployment,
  ModelDeploymentList,
  ModelInputModality,
  ModelObservation,
  ModelObservationList,
  ModelWorkload,
  ServiceKind,
  UpdateModelDeployment,
} from "@orcasynapse/contracts";
import { MODEL_INPUT_MODALITIES } from "@orcasynapse/contracts";
import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import {
  auditEvent,
  modelDeployment,
  modelObservation,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import { ModelConflictError, ModelNotFoundError, type ModelManager, type ObservationSyncResult } from "./model-manager.js";
import { contractBoundedLimits, type ObservedModelSnapshot } from "./observed-catalogue.js";

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

type ObservationFields = {
  observedContextWindowTokens: number | null;
  observedMaxOutputTokens: number | null;
  inputModalities: string[] | null;
  missingFromUpstream: boolean | null;
  lastSeenAt: Date | null;
};

type StoredModel = typeof modelDeployment.$inferSelect & {
  connection: RoutedConnection;
  observation: ObservationFields | null;
};

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

function modalities(value: string[] | null | undefined): ModelInputModality[] {
  return (value ?? []).filter((item): item is ModelInputModality =>
    (MODEL_INPUT_MODALITIES as readonly string[]).includes(item),
  );
}

function observationDto(model: StoredModel): Pick<
  ModelDeployment,
  "observedContextWindowTokens" | "observedMaxOutputTokens" | "inputModalities" | "missingFromUpstream" | "lastSeenAt"
> {
  const observation = model.observation;
  return {
    observedContextWindowTokens: observation?.observedContextWindowTokens ?? null,
    observedMaxOutputTokens: observation?.observedMaxOutputTokens ?? null,
    inputModalities: modalities(observation?.inputModalities),
    missingFromUpstream: observation?.missingFromUpstream ?? false,
    lastSeenAt: observation?.lastSeenAt?.toISOString() ?? null,
  };
}

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
    ...observationDto(model),
  };
}

function slugFromAlias(alias: string): string {
  const slug = alias.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  return slug.length >= 2 ? slug : `m-${slug || "model"}`.slice(0, 64);
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
    .select({ model: modelDeployment, connection: connectionColumns, observation: modelObservation })
    .from(modelDeployment)
    .innerJoin(serviceConnection, eq(serviceConnection.id, modelDeployment.connectionId))
    .leftJoin(
      modelObservation,
      and(
        eq(modelObservation.connectionId, modelDeployment.connectionId),
        eq(modelObservation.alias, modelDeployment.modelAlias),
      ),
    )
    .where(eq(modelDeployment.id, id))
    .limit(1);
  return row ? { ...row.model, connection: row.connection, observation: row.observation } : undefined;
}

export class DrizzleModelManager implements ModelManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async list(): Promise<ModelDeploymentList> {
    const rows = await this.database
      .select({ model: modelDeployment, connection: connectionColumns, observation: modelObservation })
      .from(modelDeployment)
      .innerJoin(serviceConnection, eq(serviceConnection.id, modelDeployment.connectionId))
      .leftJoin(
        modelObservation,
        and(
          eq(modelObservation.connectionId, modelDeployment.connectionId),
          eq(modelObservation.alias, modelDeployment.modelAlias),
        ),
      )
      .orderBy(asc(modelDeployment.workload), desc(modelDeployment.isDefault), desc(modelDeployment.updatedAt))
      .limit(200);
    return { items: rows.map((row) => dto({ ...row.model, connection: row.connection, observation: row.observation })) };
  }

  async listObservations(connectionId: string): Promise<ModelObservationList> {
    const rows = await this.database
      .select()
      .from(modelObservation)
      .where(eq(modelObservation.connectionId, connectionId))
      .orderBy(asc(modelObservation.missingFromUpstream), asc(modelObservation.alias))
      .limit(2_000);
    const routes = rows.length === 0
      ? []
      : await this.database
        .select({ alias: modelDeployment.modelAlias, workload: modelDeployment.workload })
        .from(modelDeployment)
        .where(eq(modelDeployment.connectionId, connectionId));
    const admitted = new Map<string, ModelWorkload[]>();
    for (const route of routes) {
      const current = admitted.get(route.alias) ?? [];
      if (!current.includes(route.workload)) current.push(route.workload);
      admitted.set(route.alias, current);
    }
    const items: ModelObservation[] = rows.map((row) => ({
      id: row.id,
      connectionId: row.connectionId,
      alias: row.alias,
      displayName: row.displayName,
      observedContextWindowTokens: row.observedContextWindowTokens,
      observedMaxOutputTokens: row.observedMaxOutputTokens,
      inputModalities: modalities(row.inputModalities),
      ownedBy: row.ownedBy,
      lastSeenAt: row.lastSeenAt.toISOString(),
      missingFromUpstream: row.missingFromUpstream,
      admittedWorkloads: admitted.get(row.alias) ?? [],
    }));
    const refreshedAt = items.reduce<string | null>((latest, item) => {
      if (!latest || item.lastSeenAt > latest) return item.lastSeenAt;
      return latest;
    }, null);
    return { connectionId, refreshedAt, items };
  }

  async replaceObservations(
    connectionId: string,
    snapshots: ObservedModelSnapshot[],
    seenAt: Date,
  ): Promise<ObservationSyncResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-model-obs:${connectionId}`));
      const aliases = snapshots.map((snapshot) => snapshot.alias);
      if (snapshots.length > 0) {
        const chunkSize = 250;
        for (let offset = 0; offset < snapshots.length; offset += chunkSize) {
          const chunk = snapshots.slice(offset, offset + chunkSize);
          await transaction
            .insert(modelObservation)
            .values(chunk.map((snapshot) => ({
              connectionId,
              alias: snapshot.alias,
              displayName: snapshot.displayName,
              observedContextWindowTokens: snapshot.observedContextWindowTokens,
              observedMaxOutputTokens: snapshot.observedMaxOutputTokens,
              inputModalities: snapshot.inputModalities,
              ownedBy: snapshot.ownedBy,
              lastSeenAt: seenAt,
              missingFromUpstream: false,
            })))
            .onConflictDoUpdate({
              target: [modelObservation.connectionId, modelObservation.alias],
              set: {
                displayName: sql`excluded."displayName"`,
                observedContextWindowTokens: sql`excluded."observedContextWindowTokens"`,
                observedMaxOutputTokens: sql`excluded."observedMaxOutputTokens"`,
                inputModalities: sql`excluded."inputModalities"`,
                ownedBy: sql`excluded."ownedBy"`,
                lastSeenAt: sql`excluded."lastSeenAt"`,
                missingFromUpstream: sql`false`,
              },
            });
        }
      }
      const vanished = await transaction
        .update(modelObservation)
        .set({ missingFromUpstream: true, lastSeenAt: seenAt })
        .where(and(
          eq(modelObservation.connectionId, connectionId),
          eq(modelObservation.missingFromUpstream, false),
          ...(aliases.length > 0 ? [notInArray(modelObservation.alias, aliases)] : []),
        ))
        .returning({ alias: modelObservation.alias });
      return { upserted: snapshots.length, vanished: vanished.length };
    });
  }

  async maybeBackfillLegacyAlias(
    principal: AdminPrincipal,
    connectionId: string,
    modelAlias: string | undefined,
  ): Promise<ModelDeployment | null> {
    if (!modelAlias) return null;
    const existing = await this.database.select({ id: modelDeployment.id }).from(modelDeployment).limit(1);
    if (existing.length > 0) return null;

    const [observed] = await this.database
      .select()
      .from(modelObservation)
      .where(and(eq(modelObservation.connectionId, connectionId), eq(modelObservation.alias, modelAlias)))
      .limit(1);
    const limits = contractBoundedLimits({
      observedContextWindowTokens: observed?.observedContextWindowTokens ?? null,
      observedMaxOutputTokens: observed?.observedMaxOutputTokens ?? null,
    });
    if (!limits) return null;

    const displayName = (observed?.displayName ?? modelAlias).slice(0, 120);
    return this.create(principal, {
      slug: slugFromAlias(modelAlias),
      displayName: displayName.length >= 2 ? displayName : modelAlias.slice(0, 120).padEnd(2, "x"),
      modelAlias,
      workload: "AGENT",
      connectionId,
      version: "observed",
      license: null,
      contextWindowTokens: limits.contextWindowTokens,
      maxOutputTokens: limits.maxOutputTokens,
      maxConcurrentRequests: 2,
    });
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
        return routeWithConnection(transaction, model.id);
      });
      if (!created) throw new ModelConflictError("The model route could not be created.");
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
