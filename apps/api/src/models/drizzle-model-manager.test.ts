import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  modelDeployment,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleModelManager } from "./drizzle-model-manager.js";
import { ModelConflictError, ModelNotFoundError } from "./model-manager.js";

let context: TestDatabase;
const principal = { id: randomUUID(), subject: "platform-admin" } as never;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

function manager() {
  return new DrizzleModelManager(context.database);
}

async function connection(
  overrides: Partial<typeof serviceConnection.$inferInsert> = {},
): Promise<string> {
  const [row] = await context.database
    .insert(serviceConnection)
    .values({
      slug: `conn-${randomUUID().slice(0, 8)}`,
      displayName: "Local inference",
      kind: "INFERENCE",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "HEALTHY",
      baseUrl: "http://127.0.0.1:8000",
      configuration: {},
      ...overrides,
    })
    .returning({ id: serviceConnection.id });
  return row!.id;
}

function draft(connectionId: string, overrides: Record<string, unknown> = {}) {
  return {
    slug: `chat-route-${randomUUID().slice(0, 6)}`,
    displayName: "Chat route",
    modelAlias: `hermes-chat-${randomUUID().slice(0, 6)}`,
    workload: "CHAT" as const,
    connectionId,
    version: "1.0.0",
    license: "Apache-2.0",
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    maxConcurrentRequests: 8,
    ...overrides,
  } as never;
}

describe("DrizzleModelManager", () => {
  it("creates a route and returns it joined to its serving connection", async () => {
    const connectionId = await connection();
    const created = await manager().create(principal, draft(connectionId));

    expect(created.status).toBe("DRAFT");
    expect(created.connection).toMatchObject({ id: connectionId, kind: "INFERENCE", status: "HEALTHY" });
  });

  it("refuses a connection of the wrong kind for the workload", async () => {
    const hermes = await connection({ kind: "HERMES" });
    await expect(manager().create(principal, draft(hermes))).rejects.toThrow(
      /cannot use a HERMES connection/,
    );
  });

  it("refuses output tokens larger than the context window", async () => {
    const connectionId = await connection();
    await expect(
      manager().create(principal, draft(connectionId, { contextWindowTokens: 2_048, maxOutputTokens: 4_096 })),
    ).rejects.toThrow(/cannot exceed the context window/);
  });

  it("refuses a route pointing at a connection that does not exist", async () => {
    await expect(manager().create(principal, draft(randomUUID()))).rejects.toThrow(/does not exist/);
  });

  it("requires a new version for a material route change", async () => {
    const connectionId = await connection();
    const created = await manager().create(principal, draft(connectionId));

    await expect(
      manager().update(principal, created.id, { expectedRevision: created.revision, maxOutputTokens: 8_192 }),
    ).rejects.toThrow(/require a new model version/i);
  });

  it("requires an enabled and healthy serving connection before activation", async () => {
    const degraded = await connection({ status: "DEGRADED" });
    const created = await manager().create(principal, draft(degraded));

    await expect(
      manager().activate(principal, created.id, {
        expectedRevision: created.revision,
        reason: "Release",
        makeDefault: true,
      }),
    ).rejects.toThrow(/enabled and healthy before activation/);
  });

  it("activates a route on its own merits, with no evaluation evidence", async () => {
    const connectionId = await connection();
    const created = await manager().create(principal, draft(connectionId));
    expect(created.status).toBe("DRAFT");

    const activated = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
      makeDefault: true,
    });

    expect(activated.status).toBe("ACTIVE");
    expect(activated.isDefault).toBe(true);
    expect(activated.firstActivatedAt).not.toBeNull();
  });

  it("demotes the incumbent default when a new route becomes default", async () => {
    const connectionId = await connection();

    const first = await manager().create(principal, draft(connectionId));
    const firstActive = await manager().activate(principal, first.id, {
      expectedRevision: first.revision,
      reason: "Release",
      makeDefault: true,
    });
    expect(firstActive.isDefault).toBe(true);

    const second = await manager().create(principal, draft(connectionId));
    const secondActive = await manager().activate(principal, second.id, {
      expectedRevision: second.revision,
      reason: "Release",
      makeDefault: true,
    });

    expect(secondActive.isDefault).toBe(true);
    const [incumbent] = await context.database
      .select({ isDefault: modelDeployment.isDefault })
      .from(modelDeployment)
      .where(eq(modelDeployment.id, first.id));
    expect(incumbent?.isDefault).toBe(false);
  });

  it("clears the default flag when a route is suspended", async () => {
    const connectionId = await connection();
    const created = await manager().create(principal, draft(connectionId));
    const active = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
      makeDefault: true,
    });

    const suspended = await manager().suspend(principal, created.id, {
      expectedRevision: active.revision,
      reason: "Rollback",
      makeDefault: false,
    });

    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.isDefault).toBe(false);
  });

  it("blocks editing an active route until it is suspended", async () => {
    const connectionId = await connection();
    const created = await manager().create(principal, draft(connectionId));
    const active = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
      makeDefault: false,
    });

    await expect(
      manager().update(principal, created.id, { expectedRevision: active.revision, displayName: "Renamed" }),
    ).rejects.toThrow(/Suspend an active model route/);
  });

  it("reports a missing route distinctly from a conflict", async () => {
    await expect(
      manager().update(principal, randomUUID(), { expectedRevision: 1, displayName: "x" }),
    ).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it("refuses a stale expected revision", async () => {
    const connectionId = await connection();
    const created = await manager().create(principal, draft(connectionId));
    await expect(
      manager().update(principal, created.id, { expectedRevision: created.revision + 4, displayName: "x" }),
    ).rejects.toBeInstanceOf(ModelConflictError);
  });
});
