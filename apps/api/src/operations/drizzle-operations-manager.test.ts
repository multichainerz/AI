import { randomUUID } from "node:crypto";
import { AGENT_RUN_ENDED_EVENT_TYPE } from "@orcasynapse/contracts";
import { asc, eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunEvent,
  chatConversation,
  chatMessage,
  createTestDatabase,
  workerNode,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleOperationsManager } from "./drizzle-operations-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
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

describe("DrizzleOperationsManager reconciliation", () => {
  async function seedExecutor(lastSeenAt: Date) {
    const id = `worker-${randomUUID().slice(0, 8)}`;
    const [node] = await context.database
      .insert(workerNode)
      .values({
        id,
        name: id,
        status: "ONLINE",
        startedAt: new Date(Date.now() - 600_000),
        lastSeenAt,
        version: "v1.23.2",
        workloads: ["hermes-runs"],
      })
      .returning({ id: workerNode.id });
    return node!.id;
  }

  it("marks an executor stopped once its heartbeat goes stale", async () => {
    const alive = await seedExecutor(new Date());
    const dead = await seedExecutor(new Date(Date.now() - 120_000));

    const stopped = await new DrizzleOperationsManager(context.database).reconcile();

    expect(stopped).toBe(1);
    const rows = await context.database.select().from(workerNode);
    expect(rows.find(({ id }) => id === dead)?.status).toBe("STOPPED");
    expect(rows.find(({ id }) => id === alive)?.status).toBe("ONLINE");
  });

  it("reaps without anyone requesting a snapshot", async () => {
    const dead = await seedExecutor(new Date(Date.now() - 120_000));
    const manager = new DrizzleOperationsManager(context.database, 20);

    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 90));
    await manager.stop();

    const [row] = await context.database.select().from(workerNode).where(eq(workerNode.id, dead));
    expect(row?.status).toBe("STOPPED");
  });

  it("stops reconciling once the manager is stopped", async () => {
    const manager = new DrizzleOperationsManager(context.database, 20);
    await manager.start();
    await manager.stop();
    const dead = await seedExecutor(new Date(Date.now() - 120_000));

    await new Promise((resolve) => setTimeout(resolve, 90));

    // A stopped manager must leave the row alone; the timer was cleared.
    const [row] = await context.database.select().from(workerNode).where(eq(workerNode.id, dead));
    expect(row?.status).toBe("ONLINE");
  });
});

describe("DrizzleOperationsManager abandoned runs", () => {
  const TIMEOUT_SECONDS = 60;

  async function seedRun(overrides: Partial<typeof agentRun.$inferInsert> = {}) {
    const [profile] = await context.database.insert(agentProfile).values({
      slug: `profile-${randomUUID().slice(0, 8)}`,
      status: "ACTIVE",
      activeVersion: 1,
    }).returning({ id: agentProfile.id });
    const [version] = await context.database.insert(agentProfileVersion).values({
      profileId: profile!.id,
      version: 1,
      displayName: "Analyst v1",
      purpose: "Answer internal policy questions with approved evidence.",
      maxConcurrentRuns: 1,
      instructions: "Answer with approved evidence.",
      soulMd: "You are a careful internal analyst.",
      modelAlias: "hermes-agent",
      maxTurns: 1,
      timeoutSeconds: TIMEOUT_SECONDS,
      safeMode: true,
    }).returning({ id: agentProfileVersion.id });

    const [run] = await context.database.insert(agentRun).values({
      profileId: profile!.id,
      profileVersionId: version!.id,
      profileVersion: 1,
      ownerSubject: "user:pilot",
      requestedBy: randomUUID(),
      sessionId: randomUUID(),
      input: "Summarize the policy.",
      status: "QUEUED",
      jobId: randomUUID(),
      outputCharacterLimit: 200_000,
      // Older than its own timeout unless a case says otherwise.
      queuedAt: new Date(Date.now() - (TIMEOUT_SECONDS + 30) * 1_000),
      ...overrides,
    }).returning({ id: agentRun.id });

    const [conversation] = await context.database.insert(chatConversation).values({
      ownerSubject: "user:pilot",
      title: "Policy",
      modelAlias: "hermes-agent",
      profileId: profile!.id,
      profileName: "Analyst v1",
    }).returning({ id: chatConversation.id });
    const messageId = randomUUID();
    await context.database.insert(chatMessage).values([
      { conversationId: conversation!.id, ordinal: 1, role: "USER", status: "COMPLETED", content: "Summarize the policy." },
      { id: messageId, conversationId: conversation!.id, ordinal: 2, role: "ASSISTANT", status: "PENDING", content: "", agentRunId: run!.id },
    ]);
    return { runId: run!.id, messageId };
  }

  it("ends a run that outlived its own timeout with nobody executing it", async () => {
    const { runId, messageId } = await seedRun();

    expect(await new DrizzleOperationsManager(context.database).reconcileAbandonedRuns()).toBe(1);

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("FAILED");
    expect(run?.failureCode).toBe("HERMES_RUN_ABANDONED");
    expect(run?.completedAt).not.toBeNull();
    expect(run?.processorLeaseOwner).toBeNull();

    /*
     * The marker is what ends the subscriber's stream, so without it the
     * browser holds "Hermes is working" open on a run that is already over --
     * and it has to be in the same transaction as the status flip, never a
     * second write that can land alone.
     */
    const written = await context.database.select().from(agentRunEvent)
      .where(eq(agentRunEvent.runId, runId)).orderBy(asc(agentRunEvent.cursor));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      type: AGENT_RUN_ENDED_EVENT_TYPE,
      status: "FAILED",
      errorCode: "HERMES_RUN_ABANDONED",
    });
    expect(run?.lastEventCursor).toBeNull();

    // And the conversation is released: a PENDING assistant row is what refuses
    // every further message for STALE_PENDING_AFTER_MS.
    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message).toMatchObject({ status: "FAILED", errorCode: "HERMES_RUN_ABANDONED" });
  });

  it("ends a run stranded in an approval no runtime can decide", async () => {
    // Nothing writes this status under a native Hermes session and no worker
    // will execute it, so the reconcile is the only thing that can end it.
    const { runId } = await seedRun({ status: "WAITING_FOR_APPROVAL", startedAt: new Date(Date.now() - 120_000) });

    expect(await new DrizzleOperationsManager(context.database).reconcileAbandonedRuns()).toBe(1);

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("FAILED");
  });

  it("leaves a run alone while a worker still holds its lease", async () => {
    const { runId, messageId } = await seedRun({
      status: "RUNNING",
      startedAt: new Date(Date.now() - 600_000),
      processorLeaseOwner: "live-worker",
      processorLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(await new DrizzleOperationsManager(context.database).reconcileAbandonedRuns()).toBe(0);

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("RUNNING");
    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message?.status).toBe("PENDING");
    expect(await context.database.select().from(agentRunEvent).where(eq(agentRunEvent.runId, runId))).toHaveLength(0);
  });

  it("leaves a lease that lapsed moments ago to the worker that may still renew it", async () => {
    /*
     * A worker whose event loop stalls lets its lease lapse and then renews it
     * successfully -- the renewal matches on owner and status, not on expiry.
     * Finalising on expiry alone would take a run away from a worker that is
     * about to answer it.
     */
    const { runId } = await seedRun({
      status: "RUNNING",
      startedAt: new Date(Date.now() - 600_000),
      processorLeaseOwner: "stalled-worker",
      processorLeaseExpiresAt: new Date(Date.now() - 5_000),
    });

    expect(await new DrizzleOperationsManager(context.database).reconcileAbandonedRuns()).toBe(0);

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("RUNNING");
  });

  it("leaves the run to a worker that claims it while the sweep is deciding", async () => {
    /*
     * The race the guarded update inside the finaliser exists for, run for real.
     *
     * The claim below is uncommitted while the sweep scans, so the scan sees a
     * run nobody holds and decides to end it; its update then blocks on this
     * row's lock. When the claim commits, PostgreSQL re-evaluates that update's
     * WHERE against the committed row -- which now carries a live lease -- and
     * it matches nothing. Repeating the predicate inside the transaction is
     * what makes that true; a scan-time check alone would end a run a worker
     * had already picked up, and write a marker over the top of a live turn.
     */
    const { runId, messageId } = await seedRun({ status: "RUNNING", startedAt: new Date(Date.now() - 600_000) });
    let sweep: Promise<number> | undefined;
    await context.database.transaction(async (transaction) => {
      await transaction.update(agentRun)
        .set({ processorLeaseOwner: "late-worker", processorLeaseExpiresAt: new Date(Date.now() + 90_000) })
        .where(eq(agentRun.id, runId));
      sweep = new DrizzleOperationsManager(context.database).reconcileAbandonedRuns();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(await sweep).toBe(0);
    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("RUNNING");
    expect(run?.processorLeaseOwner).toBe("late-worker");
    expect(await context.database.select().from(agentRunEvent).where(eq(agentRunEvent.runId, runId))).toHaveLength(0);
    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message?.status).toBe("PENDING");
  });

  it("leaves a run that is still inside its own timeout", async () => {
    const { runId } = await seedRun({ queuedAt: new Date() });

    expect(await new DrizzleOperationsManager(context.database).reconcileAbandonedRuns()).toBe(0);

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("QUEUED");
  });

  it("ends abandoned runs without anyone requesting a snapshot", async () => {
    const { runId } = await seedRun();
    const manager = new DrizzleOperationsManager(context.database, 20);

    await manager.start();
    await vi.waitFor(async () => {
      const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
      expect(run?.status).toBe("FAILED");
    }, { timeout: 2_000, interval: 20 });
    await manager.stop();
  });
});
