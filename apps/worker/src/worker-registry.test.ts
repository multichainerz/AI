import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  createTestDatabase,
  workerNode,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzlePendingRunSource, DrizzleWorkerRegistry } from "./worker-registry.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const identity = { id: randomUUID(), name: "runtime.local", version: "1.0.0", workloads: ["hermes-runs"] };

async function profileVersion(): Promise<{ profileId: string; versionId: string }> {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({
      slug: `profile-${randomUUID().slice(0, 8)}`,
      status: "ACTIVE",
      activeVersion: 1,
    })
    .returning({ id: agentProfile.id });

  const [version] = await context.database
    .insert(agentProfileVersion)
    .values({
      profileId: profile!.id,
      version: 1,
      displayName: "Analyst v1",
      purpose: "Answer internal policy questions with approved evidence.",
      maxConcurrentRuns: 1,
      instructions: "Answer with approved evidence.",
      soulMd: "You are a careful internal analyst.",
      modelAlias: "hermes-agent",
      maxTurns: 1,
      timeoutSeconds: 60,
      safeMode: true,
    })
    .returning({ id: agentProfileVersion.id });

  return { profileId: profile!.id, versionId: version!.id };
}

async function run(overrides: Partial<typeof agentRun.$inferInsert> = {}): Promise<string> {
  const { profileId, versionId } = await profileVersion();
  const [row] = await context.database
    .insert(agentRun)
    .values({
      profileId,
      profileVersionId: versionId,
      profileVersion: 1,
      ownerSubject: "user:pilot",
      requestedBy: randomUUID(),
      sessionId: randomUUID(),
      memorySessionKey: randomUUID(),
      input: "Summarize the policy.",
      status: "QUEUED",
      jobId: randomUUID(),
      outputCharacterLimit: 200_000,
      ...overrides,
    })
    .returning({ id: agentRun.id });
  return row!.id;
}

describe("DrizzleWorkerRegistry", () => {
  it("registers an executor and reuses the row on restart", async () => {
    const registry = new DrizzleWorkerRegistry(context.database);

    await registry.markStarted(identity);
    await registry.markStopped(identity.id);
    await registry.markStarted(identity);

    const rows = await context.database
      .select({ status: workerNode.status, stoppedAt: workerNode.stoppedAt })
      .from(workerNode)
      .where(eq(workerNode.id, identity.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ONLINE");
    // Restarting must clear the previous shutdown marker, or the executor keeps
    // reporting as stopped while it is running.
    expect(rows[0]?.stoppedAt).toBeNull();
  });

  it("records a heartbeat and a shutdown distinctly", async () => {
    const registry = new DrizzleWorkerRegistry(context.database);
    await registry.markStarted(identity);
    await registry.markAlive(identity.id);

    const [alive] = await context.database
      .select({ status: workerNode.status })
      .from(workerNode)
      .where(eq(workerNode.id, identity.id));
    expect(alive?.status).toBe("ONLINE");

    await registry.markStopped(identity.id);
    const [stopped] = await context.database
      .select({ status: workerNode.status, stoppedAt: workerNode.stoppedAt })
      .from(workerNode)
      .where(eq(workerNode.id, identity.id));
    expect(stopped?.status).toBe("STOPPED");
    expect(stopped?.stoppedAt).not.toBeNull();
  });
});

describe("DrizzlePendingRunSource", () => {
  it("claims a queued run that no worker holds", async () => {
    const id = await run();
    const claimable = await new DrizzlePendingRunSource(context.database).claimable(5, []);

    expect(claimable.map(({ id: runId }) => runId)).toEqual([id]);
  });

  it("rediscovers a run left waiting on an approval decision", async () => {
    // The defining regression: a worker that restarted while an approval was
    // outstanding used to leave the run stranded forever.
    const id = await run({ status: "WAITING_FOR_APPROVAL" });

    const claimable = await new DrizzlePendingRunSource(context.database).claimable(5, []);
    expect(claimable.map(({ id: runId }) => runId)).toEqual([id]);
  });

  it("ignores a run whose lease has not expired", async () => {
    await run({
      processorLeaseOwner: "other-worker",
      processorLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(await new DrizzlePendingRunSource(context.database).claimable(5, [])).toHaveLength(0);
  });

  it("reclaims a run whose lease has expired", async () => {
    const id = await run({
      processorLeaseOwner: "dead-worker",
      processorLeaseExpiresAt: new Date(Date.now() - 1_000),
    });

    const claimable = await new DrizzlePendingRunSource(context.database).claimable(5, []);
    expect(claimable.map(({ id: runId }) => runId)).toEqual([id]);
  });

  it("ignores terminal runs", async () => {
    await run({ status: "COMPLETED" });
    await run({ status: "FAILED" });

    expect(await new DrizzlePendingRunSource(context.database).claimable(5, [])).toHaveLength(0);
  });

  it("excludes runs already in flight on this worker", async () => {
    const id = await run();

    expect(await new DrizzlePendingRunSource(context.database).claimable(5, [id])).toHaveLength(0);
  });

  it("returns nothing when there is no capacity", async () => {
    await run();

    expect(await new DrizzlePendingRunSource(context.database).claimable(0, [])).toHaveLength(0);
  });
});
