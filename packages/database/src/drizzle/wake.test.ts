import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing.js";
import { agentRunWakeStatement, listenForAgentRunWake } from "./wake.js";

/**
 * Against a real PostgreSQL, because every property that matters here is the
 * server's: that NOTIFY is held until commit, that a pooled connection would
 * lose the subscription, and that the payload arrives on the right channel.
 * A fake would prove none of it.
 */

let context: TestDatabase;
let url: string;

beforeAll(async () => {
  context = await createTestDatabase();
  // The listener needs its own connection to the same database the test writes
  // to; createTestDatabase provisions a uniquely named one per file.
  const [row] = await context.database.execute<{ name: string }>(sql`SELECT current_database() AS name`)
    .then((result) => result.rows);
  const parsed = new URL(testDatabaseUrl());
  parsed.pathname = `/${row!.name}`;
  url = parsed.toString();
}, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);

/** Resolves on the next wake, or rejects rather than hanging the suite. */
function nextWake(timeoutMs = 5_000): { promise: Promise<void>; onWake: () => void } {
  let settle: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    setTimeout(() => reject(new Error("no wake arrived")), timeoutMs).unref();
  });
  return { promise, onWake: () => settle() };
}

describe("the agent-run wake channel", () => {
  it("wakes a listener when a transaction commits", async () => {
    const { promise, onWake } = nextWake();
    const listener = await listenForAgentRunWake(url, onWake);
    try {
      await context.database.transaction(async (transaction) => {
        await transaction.execute(sql.raw(agentRunWakeStatement()));
      });
      await expect(promise).resolves.toBeUndefined();
    } finally {
      await listener.stop();
    }
  });

  it("does not wake for a transaction that rolls back", async () => {
    // PostgreSQL holds NOTIFY until commit, which is why the statement belongs
    // inside the same transaction as the insert: the worker can never be woken
    // for a run that is not yet visible to it.
    let woke = false;
    const listener = await listenForAgentRunWake(url, () => { woke = true; });
    try {
      await context.database.transaction(async (transaction) => {
        await transaction.execute(sql.raw(agentRunWakeStatement()));
        throw new Error("deliberate rollback");
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(woke).toBe(false);
    } finally {
      await listener.stop();
    }
  });

  it("stops delivering once stopped, so shutdown cannot be woken", async () => {
    let woke = false;
    const listener = await listenForAgentRunWake(url, () => { woke = true; });
    await listener.stop();
    await context.database.transaction(async (transaction) => {
      await transaction.execute(sql.raw(agentRunWakeStatement()));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(woke).toBe(false);
  });

  it("reports a connection it cannot open instead of throwing into the worker", async () => {
    // The worker treats this as non-fatal and keeps running on its timer, so
    // the failure has to be a rejected promise it can catch, not a crash.
    const unreachable = new URL(testDatabaseUrl());
    unreachable.port = "1";
    await expect(listenForAgentRunWake(unreachable.toString(), () => undefined)).rejects.toThrow();
  });
});
