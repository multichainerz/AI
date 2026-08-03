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
import { Prisma, type OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import {
  ConnectionConflictError,
  ConnectionAuthorizationError,
  ConnectionRevisionConflictError,
  InvalidConnectionConfigurationError,
  ConnectionNotFoundError,
  type ConnectionManager,
  type AdminActor,
} from "./connection-manager.js";
import type {
  ConnectionDiagnosticStore,
  ResolvedConnection,
} from "./diagnostics/types.js";

interface StoredConnection {
  id: string;
  slug: string;
  displayName: string;
  kind: ServiceConnectionSummary["kind"];
  environment: ServiceConnectionSummary["environment"];
  baseUrl: string | null;
  enabled: boolean;
  status: ServiceConnectionSummary["status"];
  configuration: unknown;
  activeRevision: number;
  lastHealthcheckAt: Date | null;
  lastHealthcheckMessage: string | null;
  updatedAt: Date;
  secrets: Array<{ fieldName: string }>;
}

export function diagnosticTransitionForUpdate(
  existing: Pick<StoredConnection, "status">,
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
  const databaseBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
  };
  return {
    fieldName,
    encryptedValue: databaseBytes(envelope.encryptedValue),
    valueNonce: databaseBytes(envelope.valueNonce),
    valueAuthTag: databaseBytes(envelope.valueAuthTag),
    wrappedDataKey: databaseBytes(envelope.wrappedDataKey),
    keyNonce: databaseBytes(envelope.keyNonce),
    keyAuthTag: databaseBytes(envelope.keyAuthTag),
    encryptionVersion: envelope.encryptionVersion,
    masterKeyVersion: envelope.masterKeyVersion,
  };
}

const connectionInclude = {
  secrets: {
    where: { active: true },
    select: { fieldName: true },
  },
} as const;

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

export class PrismaConnectionManager implements ConnectionManager, ConnectionDiagnosticStore {
  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly encryption: EnvelopeEncryption,
  ) {}

  async list(): Promise<ServiceConnectionSummary[]> {
    const connections = await this.prisma.serviceConnection.findMany({
      include: connectionInclude,
      orderBy: [{ kind: "asc" }, { displayName: "asc" }],
    });
    return connections.map((connection) => summarize(connection as StoredConnection));
  }

  async create(
    input: CreateServiceConnection,
    actor?: AdminActor,
  ): Promise<ServiceConnectionSummary> {
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

    let connection: StoredConnection;
    try {
      connection = (await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.serviceConnection.create({
          data: {
            id: connectionId,
            slug: input.slug,
            displayName: input.displayName,
            kind: input.kind,
            environment: input.environment,
            baseUrl: input.baseUrl,
            enabled: input.enabled,
            status: input.enabled ? "NOT_TESTED" : "DISABLED",
            configuration: input.configuration as Prisma.InputJsonValue,
            secrets: {
              create: Object.entries(input.secrets).map(([fieldName, value]) => ({
                ...encryptedSecretData(connectionId, fieldName, value, this.encryption),
                createdBy: actor?.id ?? null,
              })),
            },
            revisions: {
              create: {
                revision: 1,
                configuration: revisionState as Prisma.InputJsonValue,
                secretFieldNames,
                checksum: checksum(revisionState),
                createdBy: actor?.id ?? null,
                activatedAt: new Date(),
              },
            },
          },
          include: connectionInclude,
        });

        await transaction.auditEvent.create({
          data: {
            ...auditActor(actor),
            action: "connection.created",
            resourceType: "ServiceConnection",
            resourceId: connectionId,
            outcome: "SUCCESS",
            metadata: { kind: input.kind, environment: input.environment },
          },
        });

        return created;
      })) as StoredConnection;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConnectionConflictError(input.slug);
      }
      throw error;
    }

    return summarize(connection);
  }

  async update(
    id: string,
    input: UpdateServiceConnection,
    actor?: AdminActor,
  ): Promise<ServiceConnectionSummary> {
    const connection = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.serviceConnection.findUnique({
        where: { id },
        include: connectionInclude,
      });
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
          replacementConfiguration = parseServiceConnectionConfiguration(
            existing.kind,
            replacementConfiguration,
          );
        } catch (error) {
          throw new InvalidConnectionConfigurationError(
            error instanceof Error ? error.message : "Connection configuration is invalid.",
          );
        }
      }

      if (retiredSecretFields.length > 0) {
        await transaction.secretRecord.updateMany({
          where: { serviceConnectionId: id, active: true, fieldName: { in: retiredSecretFields } },
          data: { active: false, retiredAt: new Date() },
        });
      }

      if (input.secrets && replacedSecretFields.length > 0) {
        await transaction.secretRecord.createMany({
          data: Object.entries(input.secrets).map(([fieldName, value]) => ({
            serviceConnectionId: id,
            ...encryptedSecretData(id, fieldName, value, this.encryption),
            createdBy: actor?.id ?? null,
          })),
        });
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

      const updateData: Prisma.ServiceConnectionUpdateManyMutationInput = {
        activeRevision: nextRevision,
        status: diagnosticTransition.status,
        ...(diagnosticTransition.clearEvidence ? {
          lastHealthcheckAt: null,
          lastHealthcheckMessage: null,
        } : {}),
        monitoringClaimedAt: null,
        monitoringClaimedBy: null,
        monitoringClaimToken: null,
      };
      if (input.displayName !== undefined) updateData.displayName = input.displayName;
      if (input.environment !== undefined) updateData.environment = input.environment;
      if (input.baseUrl !== undefined) updateData.baseUrl = input.baseUrl;
      if (input.enabled !== undefined) updateData.enabled = input.enabled;
      if (replacementConfiguration !== undefined) {
        updateData.configuration = replacementConfiguration as Prisma.InputJsonValue;
      }

      const updated = await transaction.serviceConnection.updateMany({
        where: { id, activeRevision: existing.activeRevision },
        data: updateData,
      });
      if (updated.count !== 1) throw new ConnectionRevisionConflictError();

      await transaction.configurationRevision.create({
        data: {
          serviceConnectionId: id,
          revision: nextRevision,
          configuration: nextState as Prisma.InputJsonValue,
          secretFieldNames: nextSecretFields,
          checksum: checksum(nextState),
          createdBy: actor?.id ?? null,
          activatedAt: new Date(),
        },
      });

      await transaction.auditEvent.create({
        data: {
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
        },
      });

      return transaction.serviceConnection.findUniqueOrThrow({
        where: { id },
        include: connectionInclude,
      });
    });

    return summarize(connection as StoredConnection);
  }

  async listRevisions(id: string): Promise<ConfigurationRevisionList> {
    const connection = await this.prisma.serviceConnection.findUnique({
      where: { id },
      select: {
        activeRevision: true,
        revisions: {
          orderBy: { revision: "desc" },
          select: {
            id: true,
            revision: true,
            checksum: true,
            configuration: true,
            secretFieldNames: true,
            createdBy: true,
            createdAt: true,
            activatedAt: true,
          },
        },
      },
    });
    if (!connection) throw new ConnectionNotFoundError(id);
    return {
      activeRevision: connection.activeRevision,
      items: connection.revisions.map((revision) => {
        const parsed = parseStoredRevision(revision.configuration);
        return {
          id: revision.id,
          revision: revision.revision,
          checksum: revision.checksum,
          secretFieldNames: revision.secretFieldNames,
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
    const result = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.serviceConnection.findUnique({
        where: { id },
        include: {
          ...connectionInclude,
          revisions: { where: { revision: targetRevision }, take: 1 },
        },
      });
      if (!existing) throw new ConnectionNotFoundError(id);
      if (existing.kind === "OIDC" && actor?.role !== "PLATFORM_ADMIN") {
        throw new ConnectionAuthorizationError();
      }
      if (existing.activeRevision !== expectedActiveRevision) {
        throw new ConnectionRevisionConflictError();
      }
      if (targetRevision === existing.activeRevision) {
        throw new ConnectionRevisionConflictError("The selected revision is already active.");
      }
      const target = existing.revisions[0];
      if (!target) throw new ConnectionNotFoundError(`${id}/revisions/${targetRevision}`);
      const restorable = parseStoredRevision(target.configuration);
      if (
        restorable.slug !== existing.slug ||
        restorable.kind !== existing.kind
      ) {
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
      const updated = await transaction.serviceConnection.updateMany({
        where: { id, activeRevision: expectedActiveRevision },
        data: {
          displayName: restorable.displayName,
          environment: restorable.environment,
          baseUrl: restorable.baseUrl,
          enabled: restorable.enabled,
          configuration: configuration as Prisma.InputJsonValue,
          activeRevision: createdRevision,
          status: restorable.enabled ? "NOT_TESTED" : "DISABLED",
          lastHealthcheckAt: null,
          lastHealthcheckMessage: null,
          monitoringClaimedAt: null,
          monitoringClaimedBy: null,
          monitoringClaimToken: null,
        },
      });
      if (updated.count !== 1) throw new ConnectionRevisionConflictError();

      await transaction.configurationRevision.create({
        data: {
          serviceConnectionId: id,
          revision: createdRevision,
          configuration: nextState as Prisma.InputJsonValue,
          secretFieldNames: currentSecretFields,
          checksum: checksum(nextState),
          createdBy: actor?.id ?? null,
          activatedAt: new Date(),
        },
      });
      await transaction.auditEvent.create({
        data: {
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
        },
      });
      const connection = await transaction.serviceConnection.findUniqueOrThrow({
        where: { id },
        include: connectionInclude,
      });
      return { connection, createdRevision, currentSecretFields };
    });

    return {
      connection: summarize(result.connection as StoredConnection),
      rolledBackFromRevision: expectedActiveRevision,
      targetRevision,
      createdRevision: result.createdRevision,
      preservedSecretFields: result.currentSecretFields,
      message: `Configuration restored from revision ${targetRevision}; active credentials were preserved.`,
    };
  }

  async resolveForDiagnostic(id: string): Promise<ResolvedConnection> {
    const connection = await this.prisma.serviceConnection.findUnique({
      where: { id },
      select: {
        id: true,
        activeRevision: true,
        kind: true,
        baseUrl: true,
        configuration: true,
        secrets: {
          where: { active: true },
          select: {
            fieldName: true,
            encryptedValue: true,
            valueNonce: true,
            valueAuthTag: true,
            wrappedDataKey: true,
            keyNonce: true,
            keyAuthTag: true,
            encryptionVersion: true,
            masterKeyVersion: true,
          },
        },
      },
    });
    if (!connection) throw new ConnectionNotFoundError(id);

    const configuration =
      connection.configuration &&
      typeof connection.configuration === "object" &&
      !Array.isArray(connection.configuration)
        ? (connection.configuration as Record<string, unknown>)
        : {};
    const secrets: Record<string, string> = {};

    for (const secret of connection.secrets) {
      if (secret.encryptionVersion !== 1) {
        throw new Error("Unsupported encrypted credential version.");
      }
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

  async recordDiagnostic(result: ConnectionTestResult, actor?: AdminActor, expectedRevision?: number): Promise<boolean> {
    const checkedAt = new Date(result.checkedAt);
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.serviceConnection.updateMany({
        where: {
          id: result.connectionId,
          ...(expectedRevision === undefined ? {} : { activeRevision: expectedRevision }),
        },
        data: {
          status: result.status,
          lastHealthcheckAt: checkedAt,
          lastHealthcheckMessage: result.message,
        },
      });
      await transaction.auditEvent.create({
        data: {
          ...auditActor(actor),
          action: updated.count === 1 ? "connection.tested" : "connection.test_discarded",
          resourceType: "ServiceConnection",
          resourceId: result.connectionId,
          outcome: updated.count === 1 && result.status === "HEALTHY" ? "SUCCESS" : "FAILURE",
          metadata: {
            status: result.status,
            latencyMs: result.latencyMs,
            details: result.details,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            stale: updated.count !== 1,
          } as Prisma.InputJsonValue,
        },
      });
      return updated.count === 1;
    });
  }
}
