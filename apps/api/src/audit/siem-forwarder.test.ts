import { randomUUID } from "node:crypto";
import {
  auditEvent,
  auditForwardingState,
  createTestDatabase,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnosticStore } from "../connections/diagnostics/types.js";
import { DrizzleAuditManager } from "./audit-manager.js";
import { SiemForwarder } from "./siem-forwarder.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const logger = { error: vi.fn() };

const accepted = () => vi.fn(async () => new Response("", { status: 202 })) as unknown as typeof fetch;

async function seedSiem(configuration: Record<string, unknown> = {}) {
  const [connection] = await context.database
    .insert(serviceConnection)
    .values({
      slug: `siem-${randomUUID().slice(0, 8)}`,
      displayName: "SIEM",
      kind: "SIEM",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "HEALTHY",
      baseUrl: "https://siem.internal",
      configuration,
    })
    .returning({ id: serviceConnection.id });
  return connection!.id;
}

function connections(id: string, configuration: Record<string, unknown> = {}) {
  return {
    resolveForDiagnostic: vi.fn(async () => ({
      id,
      activeRevision: 1,
      kind: "SIEM" as const,
      baseUrl: "https://siem.internal",
      configuration,
      secrets: { apiKey: "siem-secret" },
    })),
    recordDiagnostic: vi.fn(),
  } as unknown as ConnectionDiagnosticStore;
}

function event(action: string, occurredAt: Date | SQL) {
  return {
    actorType: "USER" as const,
    actorId: randomUUID(),
    action,
    resourceType: "ServiceConnection",
    resourceId: randomUUID(),
    outcome: "SUCCESS",
    occurredAt,
    metadata: { note: action },
  };
}

async function record(action: string, occurredAt: Date) {
  await context.database.insert(auditEvent).values(event(action, occurredAt));
}

/**
 * Records an event inside a transaction that stays open until it is released.
 *
 * This is how insert order and commit order come apart in production: audit
 * events are written inside the transaction doing the governed work, and
 * occurredAt defaults to CURRENT_TIMESTAMP, which PostgreSQL freezes at the
 * start of that transaction.
 */
async function recordInHeldTransaction(action: string, occurredAt: Date) {
  let reached!: () => void;
  let release!: () => void;
  const inserted = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const committed = context.database.transaction(async (transaction) => {
    await transaction.insert(auditEvent).values(event(action, occurredAt));
    reached();
    await held;
  });
  const commit = async () => { openTransactions.delete(commit); release(); await committed; };
  openTransactions.add(commit);
  // Racing the transaction surfaces a failed insert instead of hanging here.
  await Promise.race([inserted, committed]);
  return { commit };
}

// A held transaction keeps a lock on the trail, so a test that fails before
// releasing one would otherwise hang the next test's TRUNCATE rather than
// report its own failure.
const openTransactions = new Set<() => Promise<void>>();
afterEach(async () => { for (const commit of openTransactions) await commit(); });

/**
 * Waits until nothing older than this event is still running on the cluster.
 *
 * Stepping over a hole is the one thing the forwarder cannot decide from the
 * trail alone: it needs pg_snapshot_xmin to pass the event, and that horizon is
 * computed across every backend in the cluster rather than across this database
 * alone, so a migration another test file is running in its own database pins
 * it. Retrying forward() a fixed number of times instead asserts that the
 * horizon moves within a few hundred milliseconds, which nothing promises -
 * under a concurrent run it does not, and the test failed on a machine that was
 * merely busy. Waiting for the condition the behaviour actually needs is what
 * makes the answer the same on a loaded machine as on an idle one.
 */
async function waitUntilSettled(action: string): Promise<void> {
  await vi.waitFor(async () => {
    const { rows } = await context.database.execute<{ settled: boolean }>(
      sql`SELECT age(xmin) > age(pg_snapshot_xmin(pg_current_snapshot())::xid) AS settled
          FROM ${auditEvent} WHERE ${auditEvent.action} = ${action}`,
    );
    expect(rows[0]?.settled).toBe(true);
  }, { timeout: 45_000, interval: 100 });
}

/** Every event handed to the destination across every cycle, in delivery order. */
function delivered(fetcher: typeof fetch): Array<{ id: string; action: string }> {
  return vi.mocked(fetcher).mock.calls.flatMap(
    ([, init]) => JSON.parse(String(init!.body)).events as Array<{ id: string; action: string }>,
  );
}

const base = new Date("2026-08-01T12:00:00.000Z");

describe("SiemForwarder", () => {
  it("does nothing when no SIEM connection is configured", async () => {
    await record("first", base);

    const forwarder = new SiemForwarder(context.database, connections(randomUUID()), logger, accepted());

    expect(await forwarder.forward()).toMatchObject({ forwarded: 0, reason: /No enabled SIEM/ as never });
  });

  it("refuses to guess when two SIEM connections are enabled", async () => {
    const id = await seedSiem();
    await seedSiem();
    await record("first", base);

    const result = await new SiemForwarder(context.database, connections(id), logger, accepted()).forward();

    expect(result.reason).toContain("More than one SIEM");
    expect(result.forwarded).toBe(0);
  });

  it("posts a batch and advances the cursor", async () => {
    const id = await seedSiem();
    await record("first", base);
    await record("second", new Date(base.getTime() + 1_000));
    const fetcher = accepted();

    const result = await new SiemForwarder(context.database, connections(id), logger, fetcher).forward();

    expect(result.forwarded).toBe(2);
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(url)).toBe("https://siem.internal/events");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer siem-secret");
    const body = JSON.parse(String(init!.body));
    expect(body.source).toBe("orcasynapse");
    expect(body.events.map((event: { action: string }) => event.action)).toEqual(["first", "second"]);

    const [state] = await context.database.select().from(auditForwardingState);
    expect(state).toMatchObject({ deliveredCount: 2, lastError: null });
  });

  it("forwards only what is new on the next pass", async () => {
    const id = await seedSiem();
    await record("first", base);
    const forwarder = new SiemForwarder(context.database, connections(id), logger, accepted());
    await forwarder.forward();

    await record("second", new Date(base.getTime() + 1_000));
    const fetcher = accepted();
    const result = await new SiemForwarder(context.database, connections(id), logger, fetcher).forward();

    expect(result.forwarded).toBe(1);
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]!.body));
    expect(body.events.map((event: { action: string }) => event.action)).toEqual(["second"]);
  });

  it("does not skip events that share a timestamp", async () => {
    const id = await seedSiem({ forwardBatchSize: 2 });
    for (const action of ["a", "b", "c", "d"]) await record(action, base);

    const first = await new SiemForwarder(context.database, connections(id, { forwardBatchSize: 2 }), logger, accepted()).forward();
    const fetcher = accepted();
    const second = await new SiemForwarder(context.database, connections(id, { forwardBatchSize: 2 }), logger, fetcher).forward();

    expect(first.forwarded).toBe(2);
    expect(second.forwarded).toBe(2);
    // Four distinct events across two batches, none repeated.
    const delivered = JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]!.body)).events;
    expect(new Set(delivered.map((event: { id: string }) => event.id)).size).toBe(2);
    const [state] = await context.database.select().from(auditForwardingState);
    expect(state?.deliveredCount).toBe(4);
  });

  it("does not skip an event whose transaction commits after a later one's", async () => {
    const id = await seedSiem();
    const fetcher = accepted();
    const forward = () => new SiemForwarder(context.database, connections(id), logger, fetcher).forward();

    // The slow transaction records first and commits last, so its event carries
    // the earlier timestamp while becoming visible after the later one.
    const slow = await recordInHeldTransaction("slow", new Date(base.getTime() + 248));
    await record("fast", new Date(base.getTime() + 669));

    // A cycle runs while the slow transaction is still open. The later event is
    // no evidence that nothing earlier is outstanding.
    await forward();
    await slow.commit();
    await forward();

    expect(delivered(fetcher).map((entry) => entry.action).sort()).toEqual(["fast", "slow"]);
    expect(new Set(delivered(fetcher).map((entry) => entry.id)).size).toBe(2);
  });

  it("forwards up to the outstanding event and no further", async () => {
    const id = await seedSiem();
    const fetcher = accepted();
    const forward = () => new SiemForwarder(context.database, connections(id), logger, fetcher).forward();

    await record("before", base);
    const slow = await recordInHeldTransaction("during", new Date(base.getTime() + 1));
    await record("after", new Date(base.getTime() + 2));

    // Everything up to the open transaction is safe to send; nothing past it is,
    // because the batch is delivered and the position advanced as one.
    expect(await forward()).toMatchObject({ forwarded: 1 });
    await slow.commit();
    expect(await forward()).toMatchObject({ forwarded: 2 });

    expect(delivered(fetcher).map((entry) => entry.action)).toEqual(["before", "during", "after"]);
  });

  it("does not report a trail with an undelivered event as fully forwarded", async () => {
    const id = await seedSiem();
    const slow = await recordInHeldTransaction("slow", new Date(base.getTime() + 248));
    await record("fast", new Date(base.getTime() + 669));

    await new SiemForwarder(context.database, connections(id), logger, accepted()).forward();
    await slow.commit();

    // The operator reads completeness off this surface; it must not claim the
    // trail is fully delivered while an event of it has never been sent.
    const health = await new DrizzleAuditManager(context.database).forwarding();
    expect(health.pendingCount).toBeGreaterThan(0);
    expect(health.summary).not.toContain("Every recorded event has been accepted");
  });

  it("delivers an event recorded with microsecond precision exactly once", async () => {
    const id = await seedSiem();
    // PostgreSQL keeps microseconds; a JavaScript Date does not. A position
    // that round-trips through a Date lands before the event it just sent.
    await context.database
      .insert(auditEvent)
      .values(event("precise", sql`TIMESTAMPTZ '2026-08-01T12:00:00.919532Z'`));
    const fetcher = accepted();
    const forward = () => new SiemForwarder(context.database, connections(id), logger, fetcher).forward();

    const first = await forward();
    const second = await forward();

    expect(first.forwarded).toBe(1);
    expect(second.forwarded).toBe(0);
    expect(delivered(fetcher)).toHaveLength(1);
    const [state] = await context.database.select().from(auditForwardingState);
    expect(state?.deliveredCount).toBe(1);
  });

  it("does not stall when a rolled-back write leaves a hole in the trail", async () => {
    const id = await seedSiem();
    // A position is claimed inside the transaction and is not returned when it
    // fails, so a hole in the order is permanent and cannot be waited out.
    await expect(context.database.transaction(async (transaction) => {
      await transaction.insert(auditEvent).values(event("doomed", base));
      throw new Error("the surrounding work failed");
    })).rejects.toThrow("the surrounding work failed");
    await record("survivor", new Date(base.getTime() + 1_000));

    // Resolving a hole means waiting out the writes that were in flight around
    // it, which other tests on this cluster may still be holding open. Once
    // they are gone one cycle has to clear it, so this asserts on a single
    // pass rather than on however many a busy machine happens to need.
    await waitUntilSettled("survivor");
    const fetcher = accepted();
    const result = await new SiemForwarder(context.database, connections(id), logger, fetcher).forward();

    expect(result.forwarded).toBe(1);
    expect(delivered(fetcher).map((entry) => entry.action)).toEqual(["survivor"]);
  }, 60_000);

  it("retries a rejected batch rather than losing it", async () => {
    const id = await seedSiem();
    await record("first", base);
    const rejecting = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;

    const failed = await new SiemForwarder(context.database, connections(id), logger, rejecting).forward();

    expect(failed).toMatchObject({ forwarded: 0 });
    const [state] = await context.database.select().from(auditForwardingState);
    // The cursor must not move, or the event would never be delivered.
    expect(state?.lastForwardedId).toBeNull();
    expect(state?.lastError).toContain("503");

    const retried = await new SiemForwarder(context.database, connections(id), logger, accepted()).forward();
    expect(retried.forwarded).toBe(1);
    const [recovered] = await context.database.select().from(auditForwardingState);
    expect(recovered?.lastError).toBeNull();
  });

  it("records an unreachable endpoint without advancing", async () => {
    const id = await seedSiem();
    await record("first", base);
    const unreachable = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;

    await new SiemForwarder(context.database, connections(id), logger, unreachable).forward();

    const [state] = await context.database.select().from(auditForwardingState);
    expect(state?.lastError).toContain("ECONNREFUSED");
    expect(state?.lastForwardedId).toBeNull();
  });

  it("honours a configured events path", async () => {
    const id = await seedSiem({ eventsPath: "/ingest/v1" });
    await record("first", base);
    const fetcher = accepted();

    await new SiemForwarder(context.database, connections(id, { eventsPath: "/ingest/v1" }), logger, fetcher).forward();

    expect(String(vi.mocked(fetcher).mock.calls[0]![0])).toBe("https://siem.internal/ingest/v1");
  });

  it("stops forwarding once stopped", async () => {
    const id = await seedSiem();
    await record("first", base);
    const fetcher = accepted();
    const forwarder = new SiemForwarder(context.database, connections(id), logger, fetcher, 20);

    await forwarder.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await forwarder.stop();
    const callsWhileRunning = vi.mocked(fetcher).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(callsWhileRunning).toBeGreaterThan(0);
    expect(vi.mocked(fetcher).mock.calls.length).toBe(callsWhileRunning);
  });

  it("refuses an events path that would leave the configured origin", async () => {
    const id = await seedSiem();
    await record("first", base);
    const fetcher = accepted();

    // relativeHealthPathSchema blocks this at write time; the forwarder checks
    // again at use, because a row can reach the database another way.
    const result = await new SiemForwarder(
      context.database,
      connections(id, { eventsPath: "//exfiltration.example/ingest" }),
      logger,
      fetcher,
    ).forward();

    expect(result).toMatchObject({ forwarded: 0, reason: "The SIEM connection endpoint is invalid." });
    expect(fetcher).not.toHaveBeenCalled();
    const [state] = await context.database.select().from(auditForwardingState);
    expect(state?.lastForwardedId ?? null).toBeNull();
  });
});
