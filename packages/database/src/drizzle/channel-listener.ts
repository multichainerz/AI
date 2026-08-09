import { Client } from "pg";

/**
 * One PostgreSQL LISTEN connection, kept open and reconnected on its own.
 *
 * `pg` pools multiplex, so a LISTEN issued on a pooled connection would be
 * silently dropped the moment that client was reused -- and holding a pooled
 * client for the life of a process starves everything else that needs one. This
 * takes a connection of its own and keeps it.
 *
 * It is deliberately only an accelerator for whatever timer it sits beside. The
 * connection can drop and PostgreSQL makes no delivery guarantee across one, so
 * a lost notification must always cost latency and never a unit of work.
 */
export interface ChannelListenerHandlers {
  /** The NOTIFY payload, which PostgreSQL leaves null when none was sent. */
  onNotification(payload: string | null): void;
  /** Called after every successful LISTEN, including after a reconnect. */
  onConnected?(): void;
  onError?(error: unknown): void;
}

export interface ChannelListener {
  /** Whether the channel is listening right now. */
  readonly connected: boolean;
  /**
   * Resolves once the channel is listening, or once it is stopped.
   *
   * Never rejects and never rejects late: a caller that wants to know the
   * channel came up gets to ask, and a caller that does not care is not handed
   * a promise it has to remember to catch.
   */
  whenConnected(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Opens `channel` and calls back on every notification delivered to it.
 *
 * `channel` is interpolated as a literal identifier because LISTEN takes one and
 * cannot be parameterised; every caller passes a compile-time constant from this
 * package, never anything a request supplied. Per-run addressing belongs in the
 * payload, which `pg_notify` does bind as a parameter.
 *
 * Synchronous, and never throws -- including on the very first attempt.
 *
 * That last part is the whole point of the shape. An earlier version awaited the
 * first connect and rejected if it failed, arming its retry only after one
 * success; a channel whose first connect lost a race with `max_connections` or
 * `pg_hba` was therefore dead for the entire life of the process, with no retry
 * and nothing to ask about it. Since the channel is only ever an accelerator,
 * "not up yet" and "dropped just now" are the same state and get the same
 * handling. Ask `connected` for health; nothing here is fatal.
 */
export function openChannelListener(
  connectionString: string,
  channel: string,
  handlers: ChannelListenerHandlers,
): ChannelListener {
  let stopped = false;
  let client: Client | null = null;
  let retryTimer: NodeJS.Timeout | undefined;
  const awaitingConnection = new Set<() => void>();

  const announceConnected = (): void => {
    for (const resolve of awaitingConnection) resolve();
    awaitingConnection.clear();
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const candidate = new Client({ connectionString });
    // A dropped listener must not take the host process with it: reconnect
    // quietly and keep running on the timer in the meantime.
    candidate.on("error", (error) => {
      handlers.onError?.(error);
      candidate.removeAllListeners();
      void candidate.end().catch(() => undefined);
      if (client === candidate) client = null;
      schedule();
    });
    candidate.on("notification", (message) => {
      if (message.channel === channel) handlers.onNotification(message.payload ?? null);
    });
    await candidate.connect();
    if (stopped) {
      await candidate.end().catch(() => undefined);
      return;
    }
    try {
      await candidate.query(`LISTEN ${channel}`);
    } catch (error) {
      // Connected but not subscribed. Without this the backend stays open for
      // the life of the process while nothing holds a reference to it -- a
      // connection leaked once per retry, against the very limit that is the
      // likeliest reason to be retrying.
      candidate.removeAllListeners();
      await candidate.end().catch(() => undefined);
      throw error;
    }
    client = candidate;
    handlers.onConnected?.();
    announceConnected();
  };

  const attempt = (): void => {
    void connect().catch((error: unknown) => {
      handlers.onError?.(error);
      schedule();
    });
  };

  const schedule = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      attempt();
    }, 5_000);
    // Without this a listener nobody stopped keeps the process -- and every test
    // run that leaked one -- alive for as long as it keeps retrying.
    retryTimer.unref();
  };

  attempt();

  return {
    get connected() {
      return client !== null;
    },
    whenConnected(): Promise<void> {
      if (client !== null || stopped) return Promise.resolve();
      return new Promise<void>((resolve) => { awaitingConnection.add(resolve); });
    },
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Anyone waiting on a connection that is never coming is released rather
      // than left holding a promise this process will not settle.
      announceConnected();
      const current = client;
      client = null;
      if (current) {
        current.removeAllListeners();
        await current.end().catch(() => undefined);
      }
    },
  };
}
