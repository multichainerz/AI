import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDatabase, workerNode, type TestDatabase } from "@orcasynapse/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleOperationsManager } from "./drizzle-operations-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });
afterEach(() => vi.useRealTimers());

function executor(overrides: Partial<typeof workerNode.$inferInsert> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    name: "runtime.local",
    version: "0.1.0",
    status: "ONLINE" as const,
    workloads: ["hermes-runs"],
    metadata: {},
    startedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

describe("DrizzleOperationsManager", () => {
  it("prunes executor history beyond the retention window and keeps the rest", async () => {
    const stale = executor({ lastSeenAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000) });
    const recent = executor();
    await context.database.insert(workerNode).values([stale, recent]);

    await new DrizzleOperationsManager(context.database).start();

    const remaining = await context.database.select({ id: workerNode.id }).from(workerNode);
    expect(remaining.map(({ id }) => id)).toEqual([recent.id]);
  });

  it("persists an expired heartbeat as stopped rather than only reporting it", async () => {
    const expired = executor({ lastSeenAt: new Date(Date.now() - 60_000) });
    await context.database.insert(workerNode).values(expired);

    await new DrizzleOperationsManager(context.database).snapshot();

    const [row] = await context.database
      .select({ status: workerNode.status })
      .from(workerNode)
      .where(eq(workerNode.id, expired.id));
    expect(row?.status).toBe("STOPPED");
  });

  it("reports executor liveness and drops workloads it does not recognise", async () => {
    await context.database.insert(workerNode).values(
      executor({ workloads: ["hermes-runs", "legacy-unknown"] }),
    );

    const snapshot = await new DrizzleOperationsManager(context.database).snapshot();

    expect(snapshot).toMatchObject({ engine: "postgresql-state", status: "ONLINE" });
    expect(snapshot.executors).toHaveLength(1);
    expect(snapshot.executors[0]?.workloads).toEqual(["hermes-runs"]);
  });

  it("degrades when no executor has a current heartbeat", async () => {
    const snapshot = await new DrizzleOperationsManager(context.database).snapshot();

    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.statusReasons[0]).toContain("No online PostgreSQL runtime executor");
    expect(snapshot.workloads[0]).toMatchObject({ name: "hermes-runs", totalCount: 0 });
  });

  it("hides executors older than the visible history window without deleting them", async () => {
    const old = executor({ lastSeenAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) });
    await context.database.insert(workerNode).values(old);

    const snapshot = await new DrizzleOperationsManager(context.database).snapshot();

    expect(snapshot.executors).toHaveLength(0);
    const stored = await context.database.select({ id: workerNode.id }).from(workerNode);
    expect(stored).toHaveLength(1);
  });
});
