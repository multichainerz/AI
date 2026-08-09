import { sql, type SQL } from "drizzle-orm";
import { openChannelListener, type ChannelListener } from "./channel-listener.js";

/**
 * A wake channel between the worker and every open chat stream.
 *
 * A subscriber finds new events with a cursor query on a timer, which is correct
 * and was also the floor on how quickly a token could reach a reader. This lets
 * the worker say "there is something now" the moment its transaction commits.
 *
 * It is deliberately only an accelerator. The listener holds its own connection,
 * which can drop, and PostgreSQL makes no delivery guarantee across one -- so the
 * timer stays exactly as it was and remains what guarantees a frame is found.
 * Losing a notification costs a poll interval, never a frame.
 */
export const CHAT_RUN_WAKE_CHANNEL = "orcasynapse_chat_run";

/**
 * Emitted inside the same transaction that writes the row a subscriber is
 * waiting for, so a wake can never point at a row the reader cannot yet see.
 *
 * The run id is the payload rather than the channel name because NOTIFY takes a
 * literal identifier; `pg_notify` is an ordinary function, so the id binds as a
 * parameter. The payload is routing only -- what was written is always read back
 * through the cursor query. A wake says "look now", never "here is what
 * happened".
 */
export function chatRunWakeStatement(runId: string): SQL {
  return sql`SELECT pg_notify(${CHAT_RUN_WAKE_CHANNEL}::text, ${runId}::text)`;
}

export interface ChatRunWatch {
  /**
   * Resolves at once if a notification is already latched, otherwise on the
   * next one, on abort, or when `timeoutMs` elapses -- whichever comes first.
   */
  wait(timeoutMs: number): Promise<void>;
  /** Releases the registration. Safe to call more than once. */
  close(): void;
}

export interface ChatRunWakeHub {
  watch(runId: string, signal: AbortSignal): ChatRunWatch;
  /** Whether the channel is listening right now. */
  readonly connected: boolean;
  /** Registered watchers, so a leak has something to assert against. */
  readonly size: number;
  stop(): Promise<void>;
}

/**
 * One watcher, holding the two things a wake needs.
 *
 * `latched` is what removes the "arm the wake before you query" step every
 * design of this reaches for: a notification either lands in a query that has
 * not run yet, or sets this and forces the next `wait` to return immediately.
 * There is no ordering between registering and querying that can lose one.
 */
interface Watcher {
  latched: boolean;
  resolve: (() => void) | null;
}

/**
 * A hub that never wakes anybody.
 *
 * Every subscriber falls back to its own poll interval, which is the same path
 * a dropped listen connection takes -- so this is a real, supported mode rather
 * than a test double, and it is what makes the hub a *required* argument
 * everywhere it is used. An optional accelerator is one a refactor can delete
 * without a single test going red, which is exactly what happened the first time
 * this shipped.
 */
export const NO_CHAT_RUN_WAKE: ChatRunWakeHub = {
  connected: false,
  size: 0,
  watch: () => ({ wait: async () => undefined, close: () => undefined }),
  stop: async () => undefined,
};

/**
 * One LISTEN connection per process, fanned out in memory by run.
 *
 * A connection per stream would cap an installation near the server's
 * `max_connections`, and a connection from the pool would starve every other
 * query -- pooled connections multiplex, so the subscription would be dropped
 * the moment the client was reused.
 *
 * Synchronous and non-throwing, and with no readiness promise to hand back: the
 * API composes its services in a plain function, and a promise that rejects with
 * nothing attached to it takes the process down. Until the channel is up -- and
 * again if it drops -- `wait` only ever times out, which is the same path as
 * `NO_CHAT_RUN_WAKE`. Ask `connected` for health.
 */
export function createChatRunWakeHub(
  connectionString: string,
  onError?: (error: unknown) => void,
): ChatRunWakeHub {
  const waiters = new Map<string, Set<Watcher>>();

  const release = (watcher: Watcher): void => {
    watcher.latched = true;
    watcher.resolve?.();
  };

  const listener: ChannelListener = openChannelListener(connectionString, CHAT_RUN_WAKE_CHANNEL, {
    // O(1) and synchronous by contract: nothing is queried here and nothing is
    // ever emitted from here. A frame produced outside the subscribe loop's
    // awaited chain would escape the backpressure the SSE route depends on.
    onNotification(payload) {
      if (!payload) return;
      const registered = waiters.get(payload);
      if (!registered) return;
      for (const watcher of registered) release(watcher);
    },
    onConnected() {
      // Whatever was published while the socket was down was never queued for
      // this connection and is gone. Reconnecting is therefore itself the
      // signal: everyone re-reads their cursor rather than waiting out a poll.
      for (const registered of waiters.values()) {
        for (const watcher of registered) release(watcher);
      }
    },
    ...(onError ? { onError } : {}),
  });

  return {
    get connected() {
      return listener.connected;
    },
    get size() {
      let total = 0;
      for (const registered of waiters.values()) total += registered.size;
      return total;
    },

    watch(runId: string, signal: AbortSignal): ChatRunWatch {
      const watcher: Watcher = { latched: false, resolve: null };
      let registered = waiters.get(runId);
      if (!registered) {
        registered = new Set<Watcher>();
        waiters.set(runId, registered);
      }
      registered.add(watcher);
      let closed = false;

      return {
        wait(timeoutMs: number): Promise<void> {
          if (closed || signal.aborted) return Promise.resolve();
          if (watcher.latched) {
            watcher.latched = false;
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            const settle = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", settle);
              watcher.resolve = null;
              // Cleared on every settle, including a timeout. This is safe
              // because the watcher stays registered: a notification arriving
              // after this and before the next query re-latches, and one
              // arriving during the query is found by that query.
              watcher.latched = false;
              resolve();
            };
            watcher.resolve = settle;
            const timer = setTimeout(settle, timeoutMs);
            // The loop that owns this is the thing keeping the process alive,
            // not the wait inside it.
            timer.unref();
            signal.addEventListener("abort", settle, { once: true });
          });
        },

        close(): void {
          if (closed) return;
          closed = true;
          const current = waiters.get(runId);
          if (current) {
            current.delete(watcher);
            if (current.size === 0) waiters.delete(runId);
          }
          watcher.resolve?.();
        },
      };
    },

    async stop(): Promise<void> {
      for (const registered of waiters.values()) {
        for (const watcher of registered) watcher.resolve?.();
      }
      waiters.clear();
      await listener.stop();
    },
  };
}
