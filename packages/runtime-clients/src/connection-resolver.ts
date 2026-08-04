import type { ServiceKind } from "@orcasynapse/contracts";
import { and, eq } from "drizzle-orm";
import { secretRecord, serviceConnection, type OrcaSynapseDatabase } from "@orcasynapse/database";
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

export class DrizzleRuntimeConnectionResolver {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly encryption: EnvelopeEncryption,
  ) {}

  async resolveOne(kind: ServiceKind): Promise<RuntimeConnection> {
    // Two rows, not one: an unexpected second enabled connection must fail
    // closed rather than let this silently pick whichever came back first.
    const candidates = await this.database
      .select({ id: serviceConnection.id, status: serviceConnection.status, baseUrl: serviceConnection.baseUrl, kind: serviceConnection.kind, configuration: serviceConnection.configuration })
      .from(serviceConnection)
      .where(and(eq(serviceConnection.kind, kind), eq(serviceConnection.enabled, true)))
      .limit(2);

    const connection = candidates.length === 1 ? candidates[0] : undefined;
    if (!connection || connection.status !== "HEALTHY") {
      throw new RuntimeConnectionError(
        `Exactly one enabled and healthy ${kind} connection is required.`,
      );
    }
    if (!connection.baseUrl) {
      throw new RuntimeConnectionError(`${kind} endpoint URL is required.`);
    }

    const storedSecrets = await this.database
      .select({
        fieldName: secretRecord.fieldName,
        encryptedValue: secretRecord.encryptedValue,
        valueNonce: secretRecord.valueNonce,
        valueAuthTag: secretRecord.valueAuthTag,
        wrappedDataKey: secretRecord.wrappedDataKey,
        keyNonce: secretRecord.keyNonce,
        keyAuthTag: secretRecord.keyAuthTag,
        encryptionVersion: secretRecord.encryptionVersion,
        masterKeyVersion: secretRecord.masterKeyVersion,
      })
      .from(secretRecord)
      .where(
        and(eq(secretRecord.serviceConnectionId, connection.id), eq(secretRecord.active, true)),
      );

    const configuration =
      connection.configuration && typeof connection.configuration === "object" && !Array.isArray(connection.configuration)
        ? (connection.configuration as Record<string, unknown>)
        : {};

    const secrets: Record<string, string> = {};
    for (const secret of storedSecrets) {
      if (secret.encryptionVersion !== 1) {
        throw new RuntimeConnectionError("An encrypted connection credential uses an unsupported version.");
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
        `${connection.id}:${secret.fieldName}`,
      );
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
