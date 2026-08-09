import { openChannelListener, type ChannelListener } from "./channel-listener.js";

/**
 * A wake channel between the API and the worker.
 *
 * Queued work is found by a one-second timer, which is correct and was also the
 * floor on how fast a chat message could start: an idle installation still made
 * every message wait for the next tick before any work began. This lets the API
 * say "there is something now" the moment its transaction commits.
 *
 * It is deliberately only an accelerator. The listener holds its own connection,
 * which can drop, and NOTIFY has no delivery guarantee across a restart -- so the
 * timer stays exactly as it was and remains the thing that guarantees work is
 * picked up. Losing a notification costs a second, never a run.
 */
export const AGENT_RUN_WAKE_CHANNEL = "orcasynapse_agent_run";

/**
 * Emitted inside the same transaction that inserts the run.
 *
 * PostgreSQL holds NOTIFY until commit, so a listener can never be woken for a
 * run that is not yet visible to it -- which a nudge sent after the transaction
 * would not guarantee.
 */
export function agentRunWakeStatement(): string {
  return `NOTIFY ${AGENT_RUN_WAKE_CHANNEL}`;
}

export type WakeListener = ChannelListener;

/**
 * Calls `onWake` whenever the API announces new work.
 *
 * Synchronous and non-throwing: a channel that cannot connect yet retries in the
 * background, including on its very first attempt. The caller keeps running on
 * its timer either way, which is the arrangement this channel has always claimed
 * to have -- it just used to be untrue for exactly one case, a failed first
 * connect, which left the channel dead for the life of the process.
 */
export function listenForAgentRunWake(
  connectionString: string,
  onWake: () => void,
  onError?: (error: unknown) => void,
): WakeListener {
  return openChannelListener(connectionString, AGENT_RUN_WAKE_CHANNEL, {
    onNotification: () => { onWake(); },
    // Deliberately no wake on reconnect here, unlike the chat hub. Whatever was
    // published while this socket was down costs the worker one tick of its
    // one-second reconcile timer, and a dispatch on every reconnect is a
    // behaviour change this channel does not need to buy that back.
    ...(onError ? { onError } : {}),
  });
}
