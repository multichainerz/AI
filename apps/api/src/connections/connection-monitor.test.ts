import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditEvent,
  connectionMonitoringControl,
  createTestDatabase,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionMonitorRuntime } from "./connection-monitor.js";
import type { ConnectionTestService } from "./diagnostics/connection-test-service.js";

let context: TestDatabase;
const actor = { id: randomUUID(), subject: "platform-admin" } as never;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

/**
 * Stands in for ConnectionTestService, which stamps lastHealthcheckAt as part of
 * recording a result. Without that the connection stays due and the monitor
 * correctly re-claims it, so a fake that skips the stamp misreports a cycle.
 */
function tester(behaviour?: () => Promise<void>): ConnectionTestService {
  return {
    test: vi.fn(async (id: string) => {
      if (behaviour) await behaviour();
      await context.database
        .update(serviceConnection)
        .set({ lastHealthcheckAt: new Date(), status: "HEALTHY" })
        .where(eq(serviceConnection.id, id));
    }),
  } as unknown as ConnectionTestService;
}

function monitor(service: ConnectionTestService, instanceId = randomUUID()) {
  return new ConnectionMonitorRuntime(context.database, service, { error: vi.fn() }, instanceId, 60_000);
}

async function connection(overrides: Partial<typeof serviceConnection.$inferInsert> = {}): Promise<string> {
  const [row] = await context.database
    .insert(serviceConnection)
    .values({
      slug: `conn-${randomUUID().slice(0, 8)}`,
      displayName: "Inference",
      kind: "INFERENCE",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "NOT_TESTED",
      baseUrl: "http://127.0.0.1:8000",
      configuration: {},
      ...overrides,
    })
    .returning({ id: serviceConnection.id });
  return row!.id;
}

// The schema enforces a 30 second floor, so a connection is made due by
// backdating its last healthcheck rather than by shortening the interval.
async function enableMonitoring(intervalSeconds = 30) {
  await context.database
    .insert(connectionMonitoringControl)
    .values({ id: "global", enabled: true, intervalSeconds, reason: "Enabled for acceptance." })
    .onConflictDoUpdate({
      target: connectionMonitoringControl.id,
      set: { enabled: true, intervalSeconds },
    });
}

async function leaseOf(id: string) {
  const [row] = await context.database
    .select({
      token: serviceConnection.monitoringClaimToken,
      by: serviceConnection.monitoringClaimedBy,
      status: serviceConnection.status,
    })
    .from(serviceConnection)
    .where(eq(serviceConnection.id, id));
  return row;
}

describe("ConnectionMonitorRuntime", () => {
  it("does not claim a connection while scheduled monitoring is disabled", async () => {
    await connection({ lastHealthcheckAt: new Date(Date.now() - 3_600_000) });
    const service = tester();

    expect(await monitor(service).processOneDueConnection()).toBe(false);
    expect(service.test).not.toHaveBeenCalled();
  });

  it("claims one due connection and releases its exact lease after testing", async () => {
    const id = await connection({ lastHealthcheckAt: new Date(Date.now() - 3_600_000) });
    await enableMonitoring();
    const service = tester();

    expect(await monitor(service).processOneDueConnection()).toBe(true);
    expect(service.test).toHaveBeenCalledWith(id);

    const lease = await leaseOf(id);
    expect(lease?.token).toBeNull();
    expect(lease?.by).toBeNull();
  });

  it("drains multiple due connections in a bounded concurrent cycle", async () => {
    await Promise.all([connection(), connection(), connection()]);
    await enableMonitoring();
    const service = tester();

    const processed = await monitor(service).processDueConnections(10, 3);

    expect(processed).toBe(3);
    expect(service.test).toHaveBeenCalledTimes(3);
  });

  it("stops at the configured limit even when more connections are due", async () => {
    await Promise.all([connection(), connection(), connection(), connection()]);
    await enableMonitoring();
    const service = tester();

    expect(await monitor(service).processDueConnections(2, 2)).toBeLessThanOrEqual(2);
  });

  it("records a sanitized degraded result and releases the lease when resolution fails", async () => {
    const id = await connection({ lastHealthcheckAt: new Date(Date.now() - 3_600_000) });
    await enableMonitoring();
    const service = tester(async () => {
      throw new Error("postgres://user:secret@host/db unreachable");
    });

    expect(await monitor(service).processOneDueConnection()).toBe(true);

    const lease = await leaseOf(id);
    expect(lease?.status).toBe("DEGRADED");
    expect(lease?.token).toBeNull();

    const [event] = await context.database
      .select({ action: auditEvent.action, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, id));
    expect(event?.action).toBe("connection.monitor_failed");
    // The recorded reason must not carry the credential from the thrown error.
    expect(JSON.stringify(event?.metadata)).not.toContain("secret");
  });

  it("does not claim a connection whose healthcheck is still inside the interval", async () => {
    await connection({ lastHealthcheckAt: new Date(), status: "HEALTHY" });
    await enableMonitoring(3_600);

    expect(await monitor(tester()).processOneDueConnection()).toBe(false);
  });

  it("leaves a connection claimed by another instance alone until its lease expires", async () => {
    const id = await connection({
      monitoringClaimedAt: new Date(),
      monitoringClaimedBy: "other-instance",
      monitoringClaimToken: randomUUID(),
    });
    await enableMonitoring();

    expect(await monitor(tester()).processOneDueConnection()).toBe(false);
    expect((await leaseOf(id))?.by).toBe("other-instance");
  });

  it("persists dashboard control changes and clears leases when monitoring is disabled", async () => {
    const id = await connection({
      monitoringClaimedAt: new Date(),
      monitoringClaimedBy: "stale-instance",
      monitoringClaimToken: randomUUID(),
    });
    const subject = monitor(tester());

    const enabled = await subject.updateControl(actor, {
      enabled: true,
      intervalSeconds: 120,
      reason: "Acceptance monitoring.",
    } as never);
    expect(enabled).toMatchObject({ enabled: true, intervalSeconds: 120 });

    await subject.updateControl(actor, {
      enabled: false,
      intervalSeconds: 120,
      reason: "Paused for maintenance.",
    } as never);

    const lease = await leaseOf(id);
    expect(lease?.token).toBeNull();
    expect(lease?.by).toBeNull();
    expect((await subject.getControl()).enabled).toBe(false);
  });

  it("reports a safe default control before an administrator has configured one", async () => {
    const control = await monitor(tester()).getControl();

    expect(control.enabled).toBe(false);
    expect(control.reason).toMatch(/has not been enabled/);
  });
});
