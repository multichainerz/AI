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

  it("stores OpenRouter-shaped observation context and vision/file modalities", async () => {
    const connectionId = await connection();
    const seenAt = new Date("2026-08-22T00:00:00.000Z");
    await manager().replaceObservations(connectionId, [{
      alias: "anthropic/claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      observedContextWindowTokens: 200_000,
      observedMaxOutputTokens: 8_192,
      inputModalities: ["text", "image", "file"],
      ownedBy: null,
    }], seenAt);

    const listed = await manager().listObservations(connectionId);
    expect(listed.items).toEqual([expect.objectContaining({
      alias: "anthropic/claude-sonnet-4",
      observedContextWindowTokens: 200_000,
      observedMaxOutputTokens: 8_192,
      inputModalities: ["text", "image", "file"],
      missingFromUpstream: false,
      admittedWorkloads: [],
    })]);
  });

  it("stores unknown capabilities for a generic id-only observation", async () => {
    const connectionId = await connection();
    await manager().replaceObservations(connectionId, [{
      alias: "hermes-agent",
      displayName: null,
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: "vllm",
    }], new Date("2026-08-22T00:00:00.000Z"));

    const [item] = (await manager().listObservations(connectionId)).items;
    expect(item).toMatchObject({
      alias: "hermes-agent",
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: "vllm",
    });
  });

  it("marks vanished ids missing instead of deleting them, and does not activate drafts", async () => {
    const connectionId = await connection();
    const created = await manager().create(principal, draft(connectionId, { modelAlias: "hermes-agent" }));
    expect(created.status).toBe("DRAFT");

    await manager().replaceObservations(connectionId, [{
      alias: "hermes-agent",
      displayName: null,
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: null,
    }], new Date("2026-08-22T00:00:00.000Z"));
    const vanished = await manager().replaceObservations(connectionId, [{
      alias: "other-model",
      displayName: null,
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: null,
    }], new Date("2026-08-22T01:00:00.000Z"));

    expect(vanished).toEqual({ upserted: 1, vanished: 1 });
    const listed = await manager().listObservations(connectionId);
    expect(listed.items.find((item) => item.alias === "hermes-agent")).toMatchObject({
      missingFromUpstream: true,
    });
    const [route] = (await manager().list()).items;
    expect(route).toMatchObject({
      id: created.id,
      status: "DRAFT",
      missingFromUpstream: true,
    });
  });

  it("keeps GET refreshedAt as the empty-refresh time after prior ids vanish", async () => {
    const connectionId = await connection();
    await manager().replaceObservations(connectionId, [{
      alias: "hermes-agent",
      displayName: null,
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: null,
    }], new Date("2026-08-22T00:00:00.000Z"));

    await manager().replaceObservations(connectionId, [], new Date("2026-08-22T02:00:00.000Z"));

    const listed = await manager().listObservations(connectionId);
    expect(listed.refreshedAt).toBe("2026-08-22T02:00:00.000Z");
    expect(listed.items).toEqual([expect.objectContaining({
      alias: "hermes-agent",
      missingFromUpstream: true,
      lastSeenAt: "2026-08-22T02:00:00.000Z",
    })]);
  });

  it("does not backfill a DRAFT from a legacy alias when observed limits are unknown", async () => {
    const connectionId = await connection({
      configuration: { modelAlias: "hermes-agent" },
    });
    await manager().replaceObservations(connectionId, [{
      alias: "hermes-agent",
      displayName: null,
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: null,
    }], new Date("2026-08-22T00:00:00.000Z"));

    await expect(manager().maybeBackfillLegacyAlias(principal, connectionId, "hermes-agent")).resolves.toBeNull();
    expect((await manager().list()).items).toEqual([]);
  });

  it("backfills a DRAFT AGENT from a unique legacy alias only when observed limits are known", async () => {
    const connectionId = await connection({
      configuration: { modelAlias: "hermes-agent" },
    });
    await manager().replaceObservations(connectionId, [{
      alias: "hermes-agent",
      displayName: "Hermes",
      observedContextWindowTokens: 32_768,
      observedMaxOutputTokens: 4_096,
      inputModalities: ["text"],
      ownedBy: null,
    }], new Date("2026-08-22T00:00:00.000Z"));

    const backfill = await manager().maybeBackfillLegacyAlias(principal, connectionId, "hermes-agent");
    expect(backfill).toMatchObject({
      modelAlias: "hermes-agent",
      workload: "AGENT",
      status: "DRAFT",
      isDefault: false,
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
    });
    await expect(manager().maybeBackfillLegacyAlias(principal, connectionId, "hermes-agent")).resolves.toBeNull();
  });
});
