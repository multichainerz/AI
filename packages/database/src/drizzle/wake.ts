import { Client } from "pg";

/**
 * A wake channel between the API and the worker.
 *
 * Queued work is found by a one-second timer, which is correct and was also the
 * floor on how fast a chat message could start: an idle installation still made
 * every message wait for the next tick before any work began. This lets the API
 * say "there is something now" the moment its transaction commits.
 *
 * It is deliberately only an accelerator. The listener holds its own connection,
 * which can drop, and NOTIFY has no delivery guarantee across a restart — so the
 * timer stays exactly as it was and remains the thing that guarantees work is
 * picked up. Losing a notification costs a second, never a run.
 */
export const AGENT_RUN_WAKE_CHANNEL = "orcasynapse_agent_run";

/**
 * Emitted inside the same transaction that inserts the run.
 *
 * PostgreSQL holds NOTIFY until commit, so a listener can never be woken for a
 * run that is not yet visible to it — which a nudge sent after the transaction
 * would not guarantee.
 */
export function agentRunWakeStatement(): string {
  return `NOTIFY ${AGENT_RUN_WAKE_CHANNEL}`;
}

export interface WakeListener {
  stop(): Promise<void>;
}

/**
 * Calls `onWake` whenever the API announces new work.
 *
 * `pg` pools multiplex, so a LISTEN issued on a pooled connection would be
 * silently dropped the moment that connection was reused. This takes a
 * connection of its own and keeps it.
 */
export async function listenForAgentRunWake(
  connectionString: string,
  onWake: () => void,
  onError?: (error: unknown) => void,
): Promise<WakeListener> {
  let stopped = false;
  let client: Client | null = null;
  let retryTimer: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const candidate = new Client({ connectionString });
    // A dropped listener must not take the worker with it: reconnect quietly and
    // keep running on the timer in the meantime.
    candidate.on("error", (error) => {
      onError?.(error);
      candidate.removeAllListeners();
      void candidate.end().catch(() => undefined);
      if (client === candidate) client = null;
      schedule();
    });
    candidate.on("notification", (message) => {
      if (message.channel === AGENT_RUN_WAKE_CHANNEL) onWake();
    });
    await candidate.connect();
    if (stopped) {
      await candidate.end().catch(() => undefined);
      return;
    }
    await candidate.query(`LISTEN ${AGENT_RUN_WAKE_CHANNEL}`);
    client = candidate;
  };

  const schedule = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect().catch((error) => { onError?.(error); schedule(); });
    }, 5_000);
    retryTimer.unref();
  };

  await connect();
  return {
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      const current = client;
      client = null;
      if (current) {
        current.removeAllListeners();
        await current.end().catch(() => undefined);
      }
    },
  };
}
