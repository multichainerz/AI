import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestDatabase, secretRecord, serviceConnection, type TestDatabase } from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DrizzleConnectionManager,
  diagnosticTransitionForUpdate,
  parseStoredRevision,
} from "./drizzle-connection-manager.js";
import {
  ConnectionAuthorizationError,
  ConnectionConflictError,
  ConnectionNotFoundError,
  ConnectionRevisionConflictError,
  InvalidConnectionConfigurationError,
} from "./connection-manager.js";

let context: TestDatabase;
const encryption = new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) });

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const platformAdmin = { id: randomUUID(), role: "PLATFORM_ADMIN" } as never;
const securityAdmin = { id: randomUUID(), role: "SECURITY_ADMIN" } as never;

function manager() {
  return new DrizzleConnectionManager(context.database, encryption);
}

function inferenceInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: `inference-${randomUUID().slice(0, 8)}`,
    displayName: "Local inference",
    kind: "INFERENCE" as const,
    environment: "DEVELOPMENT" as const,
    baseUrl: "http://127.0.0.1:8000",
    enabled: true,
    configuration: { modelAlias: "hermes-agent" },
    secrets: { apiKey: "upstream-secret" },
    ...overrides,
  } as never;
}

describe("DrizzleConnectionManager", () => {
  it("stores credentials encrypted and never returns their values", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);

    expect(created.secretFieldNames).toEqual(["apiKey"]);
    expect(JSON.stringify(created)).not.toContain("upstream-secret");

    const [stored] = await context.database
      .select({ encryptedValue: secretRecord.encryptedValue, fieldName: secretRecord.fieldName })
      .from(secretRecord)
      .where(eq(secretRecord.serviceConnectionId, created.id));
    expect(stored?.fieldName).toBe("apiKey");
    expect(Buffer.from(stored!.encryptedValue).toString("utf8")).not.toContain("upstream-secret");
  });

  it("decrypts credentials only through the diagnostic resolver", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);

    const resolved = await manager().resolveForDiagnostic(created.id);
    expect(resolved.secrets.apiKey).toBe("upstream-secret");
    expect(resolved.kind).toBe("INFERENCE");
  });

  it("rejects a duplicate slug as a conflict", async () => {
    const input = inferenceInput();
    await manager().create(input, platformAdmin);

    await expect(manager().create(input, platformAdmin)).rejects.toBeInstanceOf(ConnectionConflictError);
  });

  it("reserves OIDC connections for a Platform Administrator", async () => {
    const oidc = inferenceInput({
      kind: "OIDC",
      baseUrl: "https://login.example",
      configuration: { issuer: "https://login.example", clientId: "orcasynapse" },
      secrets: { clientSecret: "oidc-secret" },
    });

    await expect(manager().create(oidc, securityAdmin)).rejects.toBeInstanceOf(ConnectionAuthorizationError);
    await expect(manager().create(oidc, platformAdmin)).resolves.toMatchObject({ kind: "OIDC" });
  });

  it("retires a rotated credential instead of deleting it", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);

    await manager().update(created.id, { secrets: { apiKey: "rotated-secret" } } as never, platformAdmin);

    const rows = await context.database
      .select({ active: secretRecord.active, retiredAt: secretRecord.retiredAt })
      .from(secretRecord)
      .where(eq(secretRecord.serviceConnectionId, created.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter(({ active }) => active)).toHaveLength(1);
    expect(rows.find(({ active }) => !active)?.retiredAt).not.toBeNull();

    const resolved = await manager().resolveForDiagnostic(created.id);
    expect(resolved.secrets.apiKey).toBe("rotated-secret");
  });

  it("invalidates health evidence when connectivity changes", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);
    await context.database
      .update(serviceConnection)
      .set({ status: "HEALTHY", lastHealthcheckAt: new Date(), lastHealthcheckMessage: "ok" })
      .where(eq(serviceConnection.id, created.id));

    const updated = await manager().update(
      created.id,
      { baseUrl: "http://127.0.0.1:9000" } as never,
      platformAdmin,
    );

    expect(updated.status).toBe("NOT_TESTED");
    expect(updated.lastHealthcheckAt).toBeNull();
  });

  it("keeps health evidence when only a label changes", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);
    await context.database
      .update(serviceConnection)
      .set({ status: "HEALTHY", lastHealthcheckAt: new Date(), lastHealthcheckMessage: "ok" })
      .where(eq(serviceConnection.id, created.id));

    const updated = await manager().update(created.id, { displayName: "Renamed" } as never, platformAdmin);

    expect(updated.status).toBe("HEALTHY");
    expect(updated.lastHealthcheckAt).not.toBeNull();
  });

  it("records an immutable revision for every change", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);
    await manager().update(created.id, { displayName: "Renamed" } as never, platformAdmin);

    const revisions = await manager().listRevisions(created.id);
    expect(revisions.activeRevision).toBe(2);
    expect(revisions.items.map(({ revision }) => revision)).toEqual([2, 1]);
    expect(revisions.items.find(({ revision }) => revision === 2)?.active).toBe(true);
    // Checksums differ because the stored state differs; equal checksums would
    // mean a revision was recorded without capturing the change.
    expect(new Set(revisions.items.map(({ checksum }) => checksum)).size).toBe(2);
  });

  it("restores configuration on rollback while preserving live credentials", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);
    await manager().update(created.id, { displayName: "Renamed" } as never, platformAdmin);

    const result = await manager().rollback(created.id, 1, 2, platformAdmin);

    expect(result.connection.displayName).toBe("Local inference");
    expect(result.createdRevision).toBe(3);
    expect(result.preservedSecretFields).toEqual(["apiKey"]);
    // Rolling back configuration must never roll back a credential.
    expect((await manager().resolveForDiagnostic(created.id)).secrets.apiKey).toBe("upstream-secret");
  });

  it("refuses a rollback whose expected revision is stale", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);
    await manager().update(created.id, { displayName: "Renamed" } as never, platformAdmin);

    await expect(manager().rollback(created.id, 1, 1, platformAdmin))
      .rejects.toBeInstanceOf(ConnectionRevisionConflictError);
  });

  it("records a discarded diagnostic when it races a configuration change", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);

    const applied = await manager().recordDiagnostic(
      {
        connectionId: created.id,
        status: "HEALTHY",
        message: "reachable",
        latencyMs: 12,
        checkedAt: new Date().toISOString(),
        details: {},
      } as never,
      platformAdmin,
      99,
    );

    expect(applied).toBe(false);
    const [stored] = await context.database
      .select({ status: serviceConnection.status })
      .from(serviceConnection)
      .where(eq(serviceConnection.id, created.id));
    expect(stored?.status).not.toBe("HEALTHY");
  });

  it("applies a diagnostic that matches the active revision", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);

    const applied = await manager().recordDiagnostic(
      {
        connectionId: created.id,
        status: "HEALTHY",
        message: "reachable",
        latencyMs: 12,
        checkedAt: new Date().toISOString(),
        details: {},
      } as never,
      platformAdmin,
      created.activeRevision,
    );

    expect(applied).toBe(true);
    const [stored] = await context.database
      .select({ status: serviceConnection.status })
      .from(serviceConnection)
      .where(eq(serviceConnection.id, created.id));
    expect(stored?.status).toBe("HEALTHY");
  });

  it("reports a missing connection distinctly", async () => {
    await expect(manager().resolveForDiagnostic(randomUUID())).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(manager().listRevisions(randomUUID())).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("removes a credential field on request", async () => {
    const created = await manager().create(inferenceInput(), platformAdmin);

    const updated = await manager().update(
      created.id,
      { removeSecretFields: ["apiKey"] } as never,
      platformAdmin,
    );

    expect(updated.secretFieldNames).toEqual([]);
    const active = await context.database
      .select({ id: secretRecord.id })
      .from(secretRecord)
      .where(and(eq(secretRecord.serviceConnectionId, created.id), eq(secretRecord.active, true)));
    expect(active).toHaveLength(0);
  });
});

describe("diagnosticTransitionForUpdate", () => {
  it("preserves fresh health evidence when a tested connection is enabled", () => {
    expect(diagnosticTransitionForUpdate({ status: "HEALTHY" }, { displayName: "x" } as never, true))
      .toEqual({ status: "HEALTHY", clearEvidence: false });
  });

  it("invalidates health evidence when connectivity settings change", () => {
    expect(diagnosticTransitionForUpdate({ status: "HEALTHY" }, { baseUrl: "http://x" } as never, true))
      .toEqual({ status: "NOT_TESTED", clearEvidence: true });
  });

  it("keeps a connection disabled when activation validation has not passed", () => {
    expect(diagnosticTransitionForUpdate({ status: "HEALTHY" }, {} as never, false))
      .toEqual({ status: "DISABLED", clearEvidence: true });
  });

  it("retests a connection returning from disabled", () => {
    expect(diagnosticTransitionForUpdate({ status: "DISABLED" }, {} as never, true))
      .toEqual({ status: "NOT_TESTED", clearEvidence: true });
  });
});

describe("parseStoredRevision", () => {
  it("reads an immutable revision for a supported connection kind", () => {
    const parsed = parseStoredRevision({
      slug: "inference-primary",
      displayName: "Local inference",
      kind: "INFERENCE",
      environment: "DEVELOPMENT",
      baseUrl: "http://127.0.0.1:8000",
      enabled: true,
      configuration: { modelAlias: "hermes-agent" },
    });

    expect(parsed).toMatchObject({ slug: "inference-primary", kind: "INFERENCE" });
  });

  it("rejects a malformed revision", () => {
    expect(() => parseStoredRevision(null)).toThrow(InvalidConnectionConfigurationError);
    expect(() => parseStoredRevision({ slug: "x" })).toThrow(InvalidConnectionConfigurationError);
  });
});
