import { randomUUID } from "node:crypto";
import {
  auditEvent,
  createTestDatabase,
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

