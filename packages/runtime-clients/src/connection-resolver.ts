import type { ServiceKind } from "@orcasynapse/contracts";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";

export interface RuntimeConnection {
  id: string;
  kind: ServiceKind;
  baseUrl: string;
  configuration: Record<string, unknown>;
  secrets: Record<string, string>;
}

export class RuntimeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConnectionError";
  }
}

export class PrismaRuntimeConnectionResolver {
  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly encryption: EnvelopeEncryption,
  ) {}

  async resolveOne(kind: ServiceKind): Promise<RuntimeConnection> {
    const candidates = await this.prisma.serviceConnection.findMany({
      where: { kind, enabled: true },
      select: { id: true, status: true },
      take: 2,
    });
    if (candidates.length !== 1 || candidates[0]?.status !== "HEALTHY") {
      throw new RuntimeConnectionError(
        `Exactly one enabled and healthy ${kind} connection is required.`,
      );
    }
    const connection = await this.prisma.serviceConnection.findUniqueOrThrow({
      where: { id: candidates[0].id },
      select: {
        id: true,
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
    if (!connection.baseUrl) {
      throw new RuntimeConnectionError(`${kind} endpoint URL is required.`);
    }
    const configuration = connection.configuration &&
      typeof connection.configuration === "object" &&
      !Array.isArray(connection.configuration)
      ? connection.configuration as Record<string, unknown>
      : {};
    const secrets: Record<string, string> = {};
    for (const secret of connection.secrets) {
      if (secret.encryptionVersion !== 1) {
        throw new RuntimeConnectionError("An encrypted connection credential uses an unsupported version.");
      }
      secrets[secret.fieldName] = this.encryption.decrypt({
        algorithm: "AES-256-GCM",
        encryptionVersion: 1,
        masterKeyVersion: secret.masterKeyVersion,
        encryptedValue: secret.encryptedValue,
        valueNonce: secret.valueNonce,
        valueAuthTag: secret.valueAuthTag,
        wrappedDataKey: secret.wrappedDataKey,
        keyNonce: secret.keyNonce,
        keyAuthTag: secret.keyAuthTag,
      }, `${connection.id}:${secret.fieldName}`);
    }
    return {
      id: connection.id,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      configuration,
      secrets,
    };
  }
}
