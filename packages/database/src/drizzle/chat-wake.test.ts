import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing.js";
import type { ChatRunWakeHub } from "./chat-wake.js";

/** The hub connects in the background; publishing before LISTEN is issued loses it. */
async function whenListening(hub: ChatRunWakeHub): Promise<void> {
  for (let attempt = 0; attempt < 200 && !hub.connected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!hub.connected) throw new Error("the chat wake channel never connected");
}
import { CHAT_RUN_WAKE_CHANNEL, chatRunWakeStatement, createChatRunWakeHub } from "./chat-wake.js";

/**
 * Against a real PostgreSQL, because every property that matters here belongs
 * to the server: that a notification is held until commit and discarded with a
 * rollback, and that the payload arrives intact so one shared channel can be
 * fanned out per run. A fake would prove none of it.
 */

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);

/** Resolves true if the promise settles inside the budget, false otherwise. */
async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function notify(runId: string): Promise<void> {
  await context.database.transaction(async (transaction) => {
    await transaction.execute(chatRunWakeStatement(runId));
  });
}

describe("the chat run wake channel", () => {
  it("wakes a watcher when the transaction that wrote the row commits", async () => {
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const runId = randomUUID();
    const watch = hub.watch(runId, new AbortController().signal);
    try {
      const woken = watch.wait(5_000);
      await notify(runId);
      expect(await settlesWithin(woken, 2_000)).toBe(true);
    } finally {
      watch.close();
      await hub.stop();
    }
  });

  it("does not wake a watcher on another run's notification", async () => {
    // The property that makes one shared channel safe: the payload routes, so a
    // busy run in one conversation cannot spin every other open stream.
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const other = hub.watch(randomUUID(), new AbortController().signal);
    try {
      const woken = other.wait(5_000);
      await notify(randomUUID());
      expect(await settlesWithin(woken, 400)).toBe(false);
    } finally {
      other.close();
      await hub.stop();
    }
  });

  it("does not wake for a transaction that rolls back", async () => {
    // PostgreSQL holds the notification until commit, which is why the statement
    // belongs inside the same transaction as the write: a subscriber can never
    // be sent to look for a row that never landed.
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const runId = randomUUID();
    const watch = hub.watch(runId, new AbortController().signal);
    try {
      const woken = watch.wait(5_000);
      await context.database.transaction(async (transaction) => {
        await transaction.execute(chatRunWakeStatement(runId));
        throw new Error("deliberate rollback");
      }).catch(() => undefined);
      expect(await settlesWithin(woken, 400)).toBe(false);
    } finally {
      watch.close();
      await hub.stop();
    }
  });

  it("latches a notification that arrives before anyone is waiting", async () => {
    // The whole reason there is no "arm before you query" step. A notification
    // delivered between the cursor query and the next wait has to make that wait
    // return at once; if it does not, the frame it announced stalls for a full
    // poll interval and no happy-path test would ever see it.
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const runId = randomUUID();
    const watch = hub.watch(runId, new AbortController().signal);
    try {
      await notify(runId);
      // Let the notification land while nothing is waiting on it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const startedAt = Date.now();
      await watch.wait(5_000);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      watch.close();
      await hub.stop();
    }
  });

  it("consumes the latch, so the wait after it blocks again", async () => {
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const runId = randomUUID();
    const watch = hub.watch(runId, new AbortController().signal);
    try {
      await notify(runId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await watch.wait(5_000);
      expect(await settlesWithin(watch.wait(5_000), 400)).toBe(false);
    } finally {
      watch.close();
      await hub.stop();
    }
  });

  it("resolves on its own timeout with nothing pending", async () => {
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const watch = hub.watch(randomUUID(), new AbortController().signal);
    try {
      const startedAt = Date.now();
      await watch.wait(150);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      watch.close();
      await hub.stop();
    }
  });

  it("resolves when the subscription is aborted", async () => {
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const controller = new AbortController();
    const watch = hub.watch(randomUUID(), controller.signal);
    try {
      const woken = watch.wait(30_000);
      controller.abort();
      expect(await settlesWithin(woken, 1_000)).toBe(true);
      // An already-aborted subscription must not wait at all.
      expect(await settlesWithin(watch.wait(30_000), 1_000)).toBe(true);
    } finally {
      watch.close();
      await hub.stop();
    }
  });

  it("releases its registration on close, so a long-lived process cannot grow one", async () => {
    const hub = createChatRunWakeHub(context.connectionString);
    await whenListening(hub);
    const runId = randomUUID();
    const watch = hub.watch(runId, new AbortController().signal);
    expect(hub.size).toBe(1);
    watch.close();
    expect(hub.size).toBe(0);
    try {
      await notify(runId);
      // Nothing registered, so the notification is dropped rather than retained.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(hub.size).toBe(0);
    } finally {
      await hub.stop();
    }
  });

  it("latches every watcher when the connection comes back, because what was sent while it was down is gone", async () => {
    const hub = createChatRunWakeHub(context.connectionString, () => undefined);
    await whenListening(hub);
    const watch = hub.watch(randomUUID(), new AbortController().signal);
    try {
      await context.database.execute(sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE query LIKE ${`LISTEN ${CHAT_RUN_WAKE_CHANNEL}%`} AND pid <> pg_backend_pid()
      `);
      // No new notification is sent: reconnecting is itself the signal, because
      // anything published while the socket was down was never queued for it.
      expect(await settlesWithin(watch.wait(25_000), 20_000)).toBe(true);
    } finally {
      watch.close();
      await hub.stop();
    }
  }, 40_000);

  it("stays usable when it cannot open its connection at all", async () => {
    /*
     * The API composes this synchronously during startup, so a database that
     * will not take a second connection has to degrade to the poll interval
     * rather than take the control plane down with it.
     *
     * There is deliberately no readiness promise to await. An earlier version
     * reported the failure by rejecting one, which a composition root using only
     * `onError` would leave unhandled -- an unhandled rejection during startup,
     * from the code path whose entire job is to be survivable. Failures arrive
     * through `onError` and health is a question you ask, not a promise you are
     * handed.
     */
    const unreachable = new URL(testDatabaseUrl());
    unreachable.port = "1";
    const failures: unknown[] = [];
    const hub = createChatRunWakeHub(unreachable.toString(), (error) => failures.push(error));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(hub.connected).toBe(false);
      expect(failures.length).toBeGreaterThan(0);
      const watch = hub.watch(randomUUID(), new AbortController().signal);
      const startedAt = Date.now();
      // Every wait falls straight through to its timeout, exactly as it does
      // for a subscriber configured with no hub at all.
      await watch.wait(150);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
      expect(hub.size).toBe(1);
      watch.close();
      expect(hub.size).toBe(0);
    } finally {
      await hub.stop();
    }
  });
});
