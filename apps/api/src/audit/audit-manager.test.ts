import { randomUUID } from "node:crypto";
import {
  auditEvent,
  auditForwardingState,
  createTestDatabase,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAuditManager } from "./audit-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

function manager() {
  return new DrizzleAuditManager(context.database);
}

const base = new Date("2026-08-01T12:00:00.000Z");

async function record(overrides: Record<string, unknown> = {}) {
  const [row] = await context.database
    .insert(auditEvent)
    .values({
      actorType: "USER",
      actorId: randomUUID(),
      action: "connection.created",
      resourceType: "ServiceConnection",
      resourceId: randomUUID(),
      outcome: "SUCCESS",
      occurredAt: base,
      metadata: {},
      ...overrides,
    })
    .returning({ id: auditEvent.id, cursor: auditEvent.cursor });
  return row!;
}

describe("DrizzleAuditManager", () => {
  it("returns the newest events first", async () => {
    await record({ action: "oldest", occurredAt: new Date(base.getTime() - 2_000) });
    await record({ action: "newest", occurredAt: new Date(base.getTime() + 2_000) });
    await record({ action: "middle" });

    const { items } = await manager().list({ limit: 50 } as never);

    expect(items.map(({ action }) => action)).toEqual(["newest", "middle", "oldest"]);
  });

  it("filters on each indexed dimension exactly", async () => {
    const actorId = randomUUID();
    const resourceId = randomUUID();
    await record({ action: "administrator.session_created", actorId, resourceId, outcome: "SUCCESS" });
    await record({ action: "administrator.local_login_failed", outcome: "FAILED", actorType: "SERVICE" });

    expect((await manager().list({ action: "administrator.session_created", limit: 50 } as never)).items).toHaveLength(1);
    expect((await manager().list({ actorId, limit: 50 } as never)).items).toHaveLength(1);
    expect((await manager().list({ resourceId, limit: 50 } as never)).items).toHaveLength(1);
    expect((await manager().list({ outcome: "FAILED", limit: 50 } as never)).items).toHaveLength(1);
    expect((await manager().list({ actorType: "SERVICE", limit: 50 } as never)).items).toHaveLength(1);
    // Exact match only: a prefix must not match.
    expect((await manager().list({ action: "administrator.", limit: 50 } as never)).items).toHaveLength(0);
  });

  it("bounds results to an occurrence window", async () => {
    await record({ action: "before", occurredAt: new Date(base.getTime() - 60_000) });
    await record({ action: "inside" });
    await record({ action: "after", occurredAt: new Date(base.getTime() + 60_000) });

    const { items } = await manager().list({
      occurredFrom: new Date(base.getTime() - 1_000).toISOString(),
      occurredTo: new Date(base.getTime() + 1_000).toISOString(),
      limit: 50,
    } as never);

    expect(items.map(({ action }) => action)).toEqual(["inside"]);
  });

  it("pages by keyset without skipping or repeating events that share a timestamp", async () => {
    // Every event carries the same occurredAt, which is exactly the case an
    // offset-paged or timestamp-only cursor gets wrong.
    for (let index = 0; index < 5; index += 1) await record({ action: `event-${index}` });

    const first = await manager().list({ limit: 2 } as never);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await manager().list({ ...first.nextCursor, limit: 2 } as never);
    const third = await manager().list({ ...second.nextCursor, limit: 2 } as never);

    const seen = [...first.items, ...second.items, ...third.items].map(({ id }) => id);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("carries the recorded metadata through unchanged", async () => {
    await record({ action: "guardrail.request_blocked", metadata: { reason: "CONTROL_CHARACTERS", observedCharacters: 42 } });

    const [event] = (await manager().list({ action: "guardrail.request_blocked", limit: 50 } as never)).items;

    expect(event?.metadata).toEqual({ reason: "CONTROL_CHARACTERS", observedCharacters: 42 });
    expect(event?.occurredAt).toBe(base.toISOString());
  });

  it("reports an empty page rather than failing when nothing matches", async () => {
    expect(await manager().list({ action: "never.happened", limit: 50 } as never))
      .toEqual({ items: [], nextCursor: null });
  });
});

describe("DrizzleAuditManager forwarding health", () => {
  async function enableSiem() {
    await context.database.insert(serviceConnection).values({
      slug: `siem-${randomUUID().slice(0, 8)}`,
      displayName: "SIEM",
      kind: "SIEM",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "HEALTHY",
      baseUrl: "https://siem.internal",
      configuration: {},
    });
  }

  it("says the trail is local-only when no SIEM is enabled", async () => {
    await record();

    const state = await manager().forwarding();

    expect(state).toMatchObject({ status: "NOT_CONFIGURED", pendingCount: 1, deliveredCount: 0 });
    expect(state.summary).toContain("retained locally");
  });

  it("counts everything as undelivered before the first pass", async () => {
    await enableSiem();
    await record();
    await record();

    expect(await manager().forwarding()).toMatchObject({ status: "HEALTHY", pendingCount: 2 });
  });

  it("counts only what follows the cursor once forwarding has run", async () => {
    await enableSiem();
    const first = await record({ occurredAt: base });
    await record({ occurredAt: new Date(base.getTime() + 1_000) });
    await context.database.insert(auditForwardingState).values({
      id: "global", lastForwardedCursor: first.cursor, lastForwardedAt: base, lastForwardedId: first.id, deliveredCount: 1,
    });

    const state = await manager().forwarding();

    expect(state).toMatchObject({ status: "HEALTHY", pendingCount: 1, deliveredCount: 1 });
    expect(state.lastForwardedAt).toBe(base.toISOString());
  });

  it("counts an event recorded out of timestamp order as still pending", async () => {
    await enableSiem();
    // The forwarder has delivered up to `delivered`. The event after it carries
    // an earlier occurredAt, which is what a transaction that started earlier
    // and committed later leaves behind - counting the backlog by timestamp
    // would report it as delivered and the trail as complete.
    const delivered = await record({ action: "delivered", occurredAt: new Date(base.getTime() + 1_000) });
    await record({ action: "committed late", occurredAt: base });
    await context.database.insert(auditForwardingState).values({
      id: "global",
      lastForwardedCursor: delivered.cursor,
      lastForwardedAt: new Date(base.getTime() + 1_000),
      lastForwardedId: delivered.id,
      deliveredCount: 1,
    });

    const state = await manager().forwarding();

    expect(state.pendingCount).toBe(1);
    expect(state.summary).not.toContain("Every recorded event has been accepted");
  });

  it("reports a rejecting destination as failing, not merely behind", async () => {
    await enableSiem();
    await record();
    await context.database.insert(auditForwardingState).values({
      id: "global", lastAttemptAt: new Date(), lastError: "The SIEM endpoint returned 503.",
    });

    const state = await manager().forwarding();

    expect(state.status).toBe("FAILING");
    expect(state.lastError).toContain("503");
    expect(state.summary).toContain("rejecting batches");
  });

  it("reports a healthy destination with a large backlog as behind", async () => {
    await enableSiem();
    // The threshold is 500; seed past it without inserting them one by one.
    await context.database.insert(auditEvent).values(
      Array.from({ length: 501 }, () => ({
        actorType: "SERVICE" as const,
        action: "inference.gateway_requested",
        resourceType: "ServiceConnection",
        outcome: "SUCCESS",
        occurredAt: base,
        metadata: {},
      })),
    );

    const state = await manager().forwarding();

    expect(state.status).toBe("BEHIND");
    expect(state.pendingCount).toBe(501);
    expect(state.lastError).toBeNull();
  });
});
