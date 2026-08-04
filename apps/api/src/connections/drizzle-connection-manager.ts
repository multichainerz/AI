import { createHash, randomUUID } from "node:crypto";
import {
  parseServiceConnectionConfiguration,
  serviceConnectionConfigurationSchemaFor,
  createServiceConnectionSchema,
  type ConnectionTestResult,
  type ConfigurationRevisionList,
  type CreateServiceConnection,
  type RollbackConfigurationResult,
  type ServiceConnectionSummary,
  type UpdateServiceConnection,
} from "@orcasynapse/contracts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  auditEvent,
  configurationRevision,
  secretRecord,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { isUniqueViolation } from "../database-support.js";
import {
  ConnectionConflictError,
  ConnectionAuthorizationError,
  ConnectionRevisionConflictError,
  InvalidConnectionConfigurationError,
  ConnectionNotFoundError,
  type ConnectionManager,
  type AdminActor,
} from "./connection-manager.js";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "./diagnostics/types.js";

/** The database handle or a transaction opened from it. */
type Executor = OrcaSynapseDatabase | Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0];

type StoredConnectionRow = typeof serviceConnection.$inferSelect;
type StoredConnection = StoredConnectionRow & { secrets: Array<{ fieldName: string }> };

export function diagnosticTransitionForUpdate(
  existing: Pick<StoredConnectionRow, "status">,
  input: UpdateServiceConnection,
  nextEnabled: boolean,
): { status: ServiceConnectionSummary["status"]; clearEvidence: boolean } {
  const connectivityChanged = input.baseUrl !== undefined
    || input.configuration !== undefined
    || input.secrets !== undefined
    || input.removeSecretFields !== undefined;

  if (!nextEnabled) return { status: "DISABLED", clearEvidence: true };
  if (connectivityChanged || existing.status === "DISABLED") {
    return { status: "NOT_TESTED", clearEvidence: true };
  }
  return { status: existing.status, clearEvidence: false };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function summarize(connection: StoredConnection): ServiceConnectionSummary {
  const configuration = serviceConnectionConfigurationSchemaFor(connection.kind).safeParse(
    connection.configuration,
  );
  return {
    id: connection.id,
    slug: connection.slug,
    displayName: connection.displayName,
    kind: connection.kind,
    environment: connection.environment,
    baseUrl: connection.baseUrl,
    enabled: connection.enabled,
    status: connection.status,
    configuration: configuration.success ? configuration.data : {},
    activeRevision: connection.activeRevision,
    secretFieldNames: connection.secrets.map(({ fieldName }) => fieldName).sort(),
    lastHealthcheckAt: connection.lastHealthcheckAt?.toISOString() ?? null,
    lastHealthcheckMessage: connection.lastHealthcheckMessage,
    updatedAt: connection.updatedAt.toISOString(),
  };
}

function encryptedSecretData(
  connectionId: string,
  fieldName: string,
  value: string,
  encryption: EnvelopeEncryption,
) {
  const envelope = encryption.encrypt(value, `${connectionId}:${fieldName}`);
  return {
    fieldName,
    encryptedValue: envelope.encryptedValue,
    valueNonce: envelope.valueNonce,
    valueAuthTag: envelope.valueAuthTag,
    wrappedDataKey: envelope.wrappedDataKey,
    keyNonce: envelope.keyNonce,
    keyAuthTag: envelope.keyAuthTag,
    encryptionVersion: envelope.encryptionVersion,
    masterKeyVersion: envelope.masterKeyVersion,
  };
}

function auditActor(actor: AdminActor | undefined) {
  return actor
    ? { actorType: "USER" as const, actorId: actor.id }
    : { actorType: "SYSTEM" as const };
}

export function parseStoredRevision(value: unknown): CreateServiceConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConnectionConfigurationError("The stored revision is malformed.");
  }
  const candidate = value as Record<string, unknown>;
  const parsed = createServiceConnectionSchema.safeParse({
    slug: candidate.slug,
    displayName: candidate.displayName,
    kind: candidate.kind,
    environment: candidate.environment,
    baseUrl: candidate.baseUrl,
    enabled: candidate.enabled,
    configuration: candidate.configuration,
    secrets: {},
  });
  if (!parsed.success) {
    throw new InvalidConnectionConfigurationError("The stored revision is malformed.");
  }
  return parsed.data;
}

/** Active secret field names per connection; only names, never values. */
async function activeSecretFields(executor: Executor, ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ connectionId: secretRecord.serviceConnectionId, fieldName: secretRecord.fieldName })
    .from(secretRecord)
    .where(and(inArray(secretRecord.serviceConnectionId, ids), eq(secretRecord.active, true)));
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    grouped.set(row.connectionId, [...(grouped.get(row.connectionId) ?? []), row.fieldName]);
  }
  return grouped;
}

async function loadConnection(executor: Executor, id: string): Promise<StoredConnection | undefined> {
  const [row] = await executor.select().from(serviceConnection).where(eq(serviceConnection.id, id)).limit(1);
  if (!row) return undefined;
  const fields = await activeSecretFields(executor, [id]);
  return { ...row, secrets: (fields.get(id) ?? []).map((fieldName) => ({ fieldName })) };
}

export class DrizzleConnectionManager implements ConnectionManager, ConnectionDiagnosticStore {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly encryption: EnvelopeEncryption,
  ) {}

  async list(): Promise<ServiceConnectionSummary[]> {
    const rows = await this.database
      .select()
      .from(serviceConnection)
      .orderBy(asc(serviceConnection.kind), asc(serviceConnection.displayName));
    const fields = await activeSecretFields(this.database, rows.map(({ id }) => id));
    return rows.map((row) =>
      summarize({ ...row, secrets: (fields.get(row.id) ?? []).map((fieldName) => ({ fieldName })) }),
    );
  }

  async create(input: CreateServiceConnection, actor?: AdminActor): Promise<ServiceConnectionSummary> {
    if (input.kind === "OIDC" && actor?.role !== "PLATFORM_ADMIN") {
      throw new ConnectionAuthorizationError();
    }
    const connectionId = randomUUID();
    const secretFieldNames = Object.keys(input.secrets).sort();
    const revisionState = {
      slug: input.slug,
      displayName: input.displayName,
      kind: input.kind,
      environment: input.environment,
      baseUrl: input.baseUrl,
      enabled: input.enabled,
      configuration: input.configuration,
      secretFieldNames,
    };

    try {
      const connection = await this.database.transaction(async (transaction) => {
        await transaction.insert(serviceConnection).values({
          id: connectionId,
          slug: input.slug,
          displayName: input.displayName,
          kind: input.kind,
          environment: input.environment,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          status: input.enabled ? "NOT_TESTED" : "DISABLED",
          configuration: input.configuration,
        });

        const secrets = Object.entries(input.secrets);
        if (secrets.length > 0) {
          await transaction.insert(secretRecord).values(
            secrets.map(([fieldName, value]) => ({
              serviceConnectionId: connectionId,
              ...encryptedSecretData(connectionId, fieldName, value, this.encryption),
              createdBy: actor?.id ?? null,
            })),
          );
        }

        await transaction.insert(configurationRevision).values({
          serviceConnectionId: connectionId,
          revision: 1,
          configuration: revisionState,
          secretFieldNames,
          checksum: checksum(revisionState),
          createdBy: actor?.id ?? null,
          activatedAt: new Date(),
        });

        await transaction.insert(auditEvent).values({
          ...auditActor(actor),
          action: "connection.created",
          resourceType: "ServiceConnection",
          resourceId: connectionId,
          outcome: "SUCCESS",
          metadata: { kind: input.kind, environment: input.environment },
        });

        const created = await loadConnection(transaction, connectionId);
        if (!created) throw new ConnectionNotFoundError(connectionId);
        return created;
      });
      return summarize(connection);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConnectionConflictError(input.slug);
      throw error;
    }
  }

  async update(id: string, input: UpdateServiceConnection, actor?: AdminActor): Promise<ServiceConnectionSummary> {
    const connection = await this.database.transaction(async (transaction) => {
      const existing = await loadConnection(transaction, id);
      if (!existing) throw new ConnectionNotFoundError(id);
      if (existing.kind === "OIDC" && actor?.role !== "PLATFORM_ADMIN") {
        throw new ConnectionAuthorizationError();
      }

      const replacedSecretFields = Object.keys(input.secrets ?? {});
      const removedSecretFields = input.removeSecretFields ?? [];
      const retiredSecretFields = [...new Set([...replacedSecretFields, ...removedSecretFields])];

      let replacementConfiguration = input.configuration;
      if (replacementConfiguration !== undefined) {
        try {
          replacementConfiguration = parseServiceConnectionConfiguration(existing.kind, replacementConfiguration);
        } catch (error) {
          throw new InvalidConnectionConfigurationError(
            error instanceof Error ? error.message : "Connection configuration is invalid.",
          );
        }
      }

      // Retired rather than deleted: the envelope stays auditable, and only
      // active records are ever decrypted.
      if (retiredSecretFields.length > 0) {
        await transaction
          .update(secretRecord)
          .set({ active: false, retiredAt: new Date() })
          .where(
            and(
              eq(secretRecord.serviceConnectionId, id),
              eq(secretRecord.active, true),
              inArray(secretRecord.fieldName, retiredSecretFields),
            ),
          );
      }

      if (input.secrets && replacedSecretFields.length > 0) {
        await transaction.insert(secretRecord).values(
          Object.entries(input.secrets).map(([fieldName, value]) => ({
            serviceConnectionId: id,
            ...encryptedSecretData(id, fieldName, value, this.encryption),
            createdBy: actor?.id ?? null,
          })),
        );
      }

      const nextSecretFields = [
        ...new Set([
          ...existing.secrets
            .map(({ fieldName }) => fieldName)
            .filter((fieldName) => !removedSecretFields.includes(fieldName)),
          ...replacedSecretFields,
        ]),
      ].sort();
      const nextEnabled = input.enabled ?? existing.enabled;
      const diagnosticTransition = diagnosticTransitionForUpdate(existing, input, nextEnabled);
      const nextRevision = existing.activeRevision + 1;
      const nextState = {
        slug: existing.slug,
        displayName: input.displayName ?? existing.displayName,
        kind: existing.kind,
        environment: input.environment ?? existing.environment,
        baseUrl: input.baseUrl === undefined ? existing.baseUrl : input.baseUrl,
        enabled: nextEnabled,
        configuration: replacementConfiguration ?? existing.configuration,
        secretFieldNames: nextSecretFields,
      };

      const updated = await transaction
        .update(serviceConnection)
        .set({
          activeRevision: nextRevision,
          status: diagnosticTransition.status,
          ...(diagnosticTransition.clearEvidence
            ? { lastHealthcheckAt: null, lastHealthcheckMessage: null }
            : {}),
          monitoringClaimedAt: null,
          monitoringClaimedBy: null,
          monitoringClaimToken: null,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.environment === undefined ? {} : { environment: input.environment }),
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(replacementConfiguration === undefined ? {} : { configuration: replacementConfiguration }),
        })
        // Guarded on the revision the caller read, so a concurrent edit loses
        // rather than silently overwriting.
        .where(and(eq(serviceConnection.id, id), eq(serviceConnection.activeRevision, existing.activeRevision)))
        .returning({ id: serviceConnection.id });
      if (updated.length !== 1) throw new ConnectionRevisionConflictError();

      await transaction.insert(configurationRevision).values({
        serviceConnectionId: id,
        revision: nextRevision,
        configuration: nextState,
        secretFieldNames: nextSecretFields,
        checksum: checksum(nextState),
        createdBy: actor?.id ?? null,
        activatedAt: new Date(),
      });

      await transaction.insert(auditEvent).values({
        ...auditActor(actor),
        action: "connection.updated",
        resourceType: "ServiceConnection",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: {
          revision: nextRevision,
          rotatedSecretFields: replacedSecretFields,
          removedSecretFields,
        },
      });

      const saved = await loadConnection(transaction, id);
      if (!saved) throw new ConnectionNotFoundError(id);
      return saved;
    });

    return summarize(connection);
  }

  async listRevisions(id: string): Promise<ConfigurationRevisionList> {
    const [connection] = await this.database
      .select({ activeRevision: serviceConnection.activeRevision })
      .from(serviceConnection)
      .where(eq(serviceConnection.id, id))
      .limit(1);
    if (!connection) throw new ConnectionNotFoundError(id);

    const revisions = await this.database
      .select()
      .from(configurationRevision)
      .where(eq(configurationRevision.serviceConnectionId, id))
      .orderBy(desc(configurationRevision.revision));

    return {
      activeRevision: connection.activeRevision,
      items: revisions.map((revision) => {
        const parsed = parseStoredRevision(revision.configuration);
        return {
          id: revision.id,
          revision: revision.revision,
          checksum: revision.checksum,
          secretFieldNames: revision.secretFieldNames ?? [],
          displayName: parsed.displayName,
          environment: parsed.environment,
          baseUrl: parsed.baseUrl,
          enabled: parsed.enabled,
          configuration: parsed.configuration,
          createdBy: revision.createdBy,
          createdAt: revision.createdAt.toISOString(),
          activatedAt: revision.activatedAt?.toISOString() ?? null,
          active: revision.revision === connection.activeRevision,
        };
      }),
    };
  }

  async rollback(
    id: string,
    targetRevision: number,
    expectedActiveRevision: number,
    actor?: AdminActor,
  ): Promise<RollbackConfigurationResult> {
    const result = await this.database.transaction(async (transaction) => {
      const existing = await loadConnection(transaction, id);
      if (!existing) throw new ConnectionNotFoundError(id);
      if (existing.kind === "OIDC" && actor?.role !== "PLATFORM_ADMIN") {
        throw new ConnectionAuthorizationError();
      }
      if (existing.activeRevision !== expectedActiveRevision) throw new ConnectionRevisionConflictError();
      if (targetRevision === existing.activeRevision) {
        throw new ConnectionRevisionConflictError("The selected revision is already active.");
      }

      const [target] = await transaction
        .select()
        .from(configurationRevision)
        .where(
          and(
            eq(configurationRevision.serviceConnectionId, id),
            eq(configurationRevision.revision, targetRevision),
          ),
        )
        .limit(1);
      if (!target) throw new ConnectionNotFoundError(`${id}/revisions/${targetRevision}`);

      const restorable = parseStoredRevision(target.configuration);
      if (restorable.slug !== existing.slug || restorable.kind !== existing.kind) {
        throw new InvalidConnectionConfigurationError("The stored revision is malformed.");
      }

      const configuration = restorable.configuration;
      const currentSecretFields = existing.secrets.map(({ fieldName }) => fieldName).sort();
      const createdRevision = existing.activeRevision + 1;
      const nextState = {
        slug: existing.slug,
        displayName: restorable.displayName,
        kind: existing.kind,
        environment: restorable.environment,
        baseUrl: restorable.baseUrl,
        enabled: restorable.enabled,
        configuration,
        secretFieldNames: currentSecretFields,
      };

      const updated = await transaction
        .update(serviceConnection)
        .set({
          displayName: restorable.displayName,
          environment: restorable.environment,
          baseUrl: restorable.baseUrl,
          enabled: restorable.enabled,
          configuration,
          activeRevision: createdRevision,
          status: restorable.enabled ? "NOT_TESTED" : "DISABLED",
          lastHealthcheckAt: null,
          lastHealthcheckMessage: null,
          monitoringClaimedAt: null,
          monitoringClaimedBy: null,
          monitoringClaimToken: null,
        })
        .where(and(eq(serviceConnection.id, id), eq(serviceConnection.activeRevision, expectedActiveRevision)))
        .returning({ id: serviceConnection.id });
      if (updated.length !== 1) throw new ConnectionRevisionConflictError();

      await transaction.insert(configurationRevision).values({
        serviceConnectionId: id,
        revision: createdRevision,
        configuration: nextState,
        secretFieldNames: currentSecretFields,
        checksum: checksum(nextState),
        createdBy: actor?.id ?? null,
        activatedAt: new Date(),
      });

      await transaction.insert(auditEvent).values({
        ...auditActor(actor),
        action: "connection.configuration_rolled_back",
        resourceType: "ServiceConnection",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: {
          fromRevision: expectedActiveRevision,
          targetRevision,
          createdRevision,
          preservedSecretFields: currentSecretFields,
        },
      });

      const connection = await loadConnection(transaction, id);
      if (!connection) throw new ConnectionNotFoundError(id);
      return { connection, createdRevision, currentSecretFields };
    });

    return {
      connection: summarize(result.connection),
      rolledBackFromRevision: expectedActiveRevision,
      targetRevision,
      createdRevision: result.createdRevision,
      preservedSecretFields: result.currentSecretFields,
      message: `Configuration restored from revision ${targetRevision}; active credentials were preserved.`,
    };
  }

  async resolveForDiagnostic(id: string): Promise<ResolvedConnection> {
    const [connection] = await this.database
      .select({
        id: serviceConnection.id,
        activeRevision: serviceConnection.activeRevision,
        kind: serviceConnection.kind,
        baseUrl: serviceConnection.baseUrl,
        configuration: serviceConnection.configuration,
      })
      .from(serviceConnection)
      .where(eq(serviceConnection.id, id))
      .limit(1);
    if (!connection) throw new ConnectionNotFoundError(id);

    const storedSecrets = await this.database
      .select()
      .from(secretRecord)
      .where(and(eq(secretRecord.serviceConnectionId, id), eq(secretRecord.active, true)));

    const configuration =
      connection.configuration && typeof connection.configuration === "object" && !Array.isArray(connection.configuration)
        ? (connection.configuration as Record<string, unknown>)
        : {};

    const secrets: Record<string, string> = {};
    for (const secret of storedSecrets) {
      if (secret.encryptionVersion !== 1) throw new Error("Unsupported encrypted credential version.");
      secrets[secret.fieldName] = this.encryption.decrypt(
        {
          algorithm: "AES-256-GCM",
          encryptionVersion: 1,
          masterKeyVersion: secret.masterKeyVersion,
          encryptedValue: secret.encryptedValue,
          valueNonce: secret.valueNonce,
          valueAuthTag: secret.valueAuthTag,
          wrappedDataKey: secret.wrappedDataKey,
          keyNonce: secret.keyNonce,
          keyAuthTag: secret.keyAuthTag,
        },
        `${id}:${secret.fieldName}`,
      );
    }

    return {
      id: connection.id,
      activeRevision: connection.activeRevision,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      configuration,
      secrets,
    };
  }

  async recordDiagnostic(
    result: ConnectionTestResult,
    actor?: AdminActor,
    expectedRevision?: number,
  ): Promise<boolean> {
    const checkedAt = new Date(result.checkedAt);
    return this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(serviceConnection)
        .set({
          status: result.status,
          lastHealthcheckAt: checkedAt,
          lastHealthcheckMessage: result.message,
        })
        .where(
          and(
            eq(serviceConnection.id, result.connectionId),
            ...(expectedRevision === undefined ? [] : [eq(serviceConnection.activeRevision, expectedRevision)]),
          ),
        )
        .returning({ id: serviceConnection.id });
      const applied = updated.length === 1;

      // A discarded result is still recorded, so an operator can see that a
      // diagnostic raced a configuration change rather than silently vanishing.
      await transaction.insert(auditEvent).values({
        ...auditActor(actor),
        action: applied ? "connection.tested" : "connection.test_discarded",
        resourceType: "ServiceConnection",
        resourceId: result.connectionId,
        outcome: applied && result.status === "HEALTHY" ? "SUCCESS" : "FAILURE",
        metadata: {
          status: result.status,
          latencyMs: result.latencyMs,
          details: result.details,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          stale: !applied,
        },
      });
      return applied;
    });
  }
}
