import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditEvent,
  auditForwardingState,
  createTestDatabase,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnosticStore } from "../connections/diagnostics/types.js";
import { SiemForwarder } from "./siem-forwarder.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
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

async function record(action: string, occurredAt: Date) {
  await context.database.insert(auditEvent).values({
    actorType: "USER",
    actorId: randomUUID(),
    action,
    resourceType: "ServiceConnection",
    resourceId: randomUUID(),
    outcome: "SUCCESS",
    occurredAt,
    metadata: { note: action },
  });
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
});
