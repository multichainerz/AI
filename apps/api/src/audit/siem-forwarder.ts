import {
  auditEvent,
  auditForwardingState,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, eq, getTableColumns, gt, sql } from "drizzle-orm";
import { endpointUrl } from "../connections/diagnostics/http.js";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";

const TICK_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Whether nothing still running could have written an event before this one.
 *
 * A sequence value is claimed while the inserting transaction is still open, so
 * a position can be occupied by a transaction that has not committed yet - or
 * by one that never will, because a rolled-back insert does not give its
 * position back. This is true once the transaction that wrote the row is older
 * than every transaction still in flight, at which point anything that has not
 * landed yet claimed its position after this row claimed its own. age() is used
 * rather than a plain comparison so the answer survives transaction id
 * wraparound.
 */
const SETTLED = sql<boolean>`age(${auditEvent}.xmin) > age(pg_snapshot_xmin(pg_current_snapshot())::xid)`;

/**
 * The leading run of a batch that is provably complete.
 *
 * An unbroken run of positions is safe on its own: a position that is already
 * occupied cannot also be held by an uncommitted write, so nothing can still
 * arrive between these events. That covers the ordinary case without waiting on
 * unrelated transactions elsewhere in the cluster. Past a hole - a position
 * claimed by a write that is still open, or lost to one that was rolled back -
 * an event is only safe once it has settled, which is what keeps a permanent
 * hole from stalling forwarding forever.
 */
function deliverablePrefix<T extends { cursor: bigint; settled: boolean }>(
  batch: readonly T[],
  after: bigint,
): T[] {
  let expected = after + 1n;
  let count = 0;
  for (const candidate of batch) {
    if (candidate.cursor !== expected && !candidate.settled) break;
    expected = candidate.cursor + 1n;
    count += 1;
  }
  return batch.slice(0, count);
}

export interface SiemForwarderLogger {
  error(message: string, error: unknown): void;
}

export interface SiemForwardResult {
  forwarded: number;
  reason?: string;
}

/**
 * Ships the audit trail to a configured SIEM.
 *
 * OrcaSynapse models a SIEM as an HTTP service connection with a health path
 * and a timeout, so forwarding is an HTTP POST of a JSON batch rather than
 * syslog. Delivery position is AuditEvent.cursor, a sequence, rather than the
 * event's timestamp: occurredAt is transaction_timestamp(), so it orders events
 * by when their transaction began, and an event written by a transaction that
 * commits late carries a timestamp the cursor has already passed. It would be
 * skipped permanently, and the backlog query shares this predicate, so the
 * trail would report itself complete while missing an event.
 *
 * A sequence position is claimed inside the inserting transaction rather than
 * at commit, so the cursor advances only across events that no uncommitted
 * write can still precede; see deliverablePrefix. A failed batch leaves the
 * cursor untouched and is retried. Duplicates are possible if a batch is
 * delivered and the cursor write then fails, which is the correct trade for an
 * audit trail - a SIEM can deduplicate on event id, but it cannot invent an
 * event it never received.
 */
export class SiemForwarder {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<unknown> | undefined;
  private started = false;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly connections: ConnectionDiagnosticStore,
    private readonly logger: SiemForwarderLogger,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tickIntervalMs = TICK_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.triggerCycle(), this.tickIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) await this.active;
  }

  private async triggerCycle(): Promise<void> {
    if (this.active) return;
    this.active = this.forward()
      .catch((error: unknown) => this.logger.error("SIEM audit forwarding failed.", error))
      .finally(() => { this.active = undefined; });
    await this.active;
  }

  /** Resolves the single enabled SIEM route, or reports why there is none. */
  private async destination(): Promise<ResolvedConnection | string> {
    const candidates = await this.database
      .select({ id: serviceConnection.id })
      .from(serviceConnection)
      .where(and(eq(serviceConnection.kind, "SIEM"), eq(serviceConnection.enabled, true)))
      .limit(2);
    if (candidates.length === 0) return "No enabled SIEM connection is configured.";
    if (candidates.length > 1) return "More than one SIEM connection is enabled.";
    try {
      return await this.connections.resolveForDiagnostic(candidates[0]!.id);
    } catch {
      return "The SIEM connection could not be resolved.";
    }
  }

  async forward(): Promise<SiemForwardResult> {
    const destination = await this.destination();
    if (typeof destination === "string") return { forwarded: 0, reason: destination };
    if (!destination.baseUrl) return { forwarded: 0, reason: "The SIEM connection has no endpoint." };

    const [state] = await this.database
      .select()
      .from(auditForwardingState)
      .where(eq(auditForwardingState.id, "global"))
      .limit(1);

    const batchSize = typeof destination.configuration.forwardBatchSize === "number"
      ? destination.configuration.forwardBatchSize
      : DEFAULT_BATCH_SIZE;
    // A sequence hands out its first value at 1, so an unset position means
    // everything is outstanding rather than that the run starts anywhere.
    const after = state?.lastForwardedCursor ?? 0n;
    const candidates = await this.database
      .select({ ...getTableColumns(auditEvent), settled: SETTLED })
      .from(auditEvent)
      .where(gt(auditEvent.cursor, after))
      .orderBy(asc(auditEvent.cursor))
      .limit(batchSize);

    const batch = deliverablePrefix(candidates, after);
    // Anything left behind is an event a still-open transaction could precede.
    // It is counted as pending, not delivered, and follows on a later cycle.
    if (batch.length === 0) return { forwarded: 0 };

    // Resolved through the shared helper so a stored path cannot move the
    // destination to another origin.
    let endpoint: URL;
    try {
      endpoint = endpointUrl(
        destination.baseUrl,
        typeof destination.configuration.eventsPath === "string" ? destination.configuration.eventsPath : "/events",
      );
    } catch {
      return { forwarded: 0, reason: "The SIEM connection endpoint is invalid." };
    }
    const timeoutMs = typeof destination.configuration.timeoutMs === "number"
      ? destination.configuration.timeoutMs
      : DEFAULT_TIMEOUT_MS;

    const attemptedAt = new Date();
    try {
      const response = await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(destination.secrets.apiKey ? { authorization: `Bearer ${destination.secrets.apiKey}` } : {}),
        },
        body: JSON.stringify({
          source: "orcasynapse",
          events: batch.map((event) => ({
            id: event.id,
            occurredAt: event.occurredAt.toISOString(),
            actorType: event.actorType,
            actorId: event.actorId,
            action: event.action,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            outcome: event.outcome,
            correlationId: event.correlationId,
            sourceIp: event.sourceIp,
            metadata: event.metadata,
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await this.recordFailure(attemptedAt, `The SIEM endpoint returned ${response.status}.`);
        return { forwarded: 0, reason: `The SIEM endpoint returned ${response.status}.` };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : "The SIEM endpoint was unreachable.";
      await this.recordFailure(attemptedAt, reason);
      return { forwarded: 0, reason };
    }

    // lastForwardedAt and lastForwardedId describe the last event sent, for the
    // operator; the cursor alone is the position, and it carries no precision
    // to lose. Writing the timestamp back as the position truncated PostgreSQL
    // microseconds to JavaScript milliseconds, so a boundary event matched
    // itself again on the next pass and was delivered on every pass after that.
    const last = batch.at(-1)!;
    await this.database
      .insert(auditForwardingState)
      .values({
        id: "global",
        lastForwardedCursor: last.cursor,
        lastForwardedAt: last.occurredAt,
        lastForwardedId: last.id,
        lastAttemptAt: attemptedAt,
        lastError: null,
        deliveredCount: batch.length,
      })
      .onConflictDoUpdate({
        target: auditForwardingState.id,
        set: {
          lastForwardedCursor: last.cursor,
          lastForwardedAt: last.occurredAt,
          lastForwardedId: last.id,
          lastAttemptAt: attemptedAt,
          lastError: null,
          deliveredCount: sql`${auditForwardingState.deliveredCount} + ${batch.length}`,
          updatedAt: new Date(),
        },
      });
    return { forwarded: batch.length };
  }

  /** Records the failure without advancing the cursor, so the batch is retried. */
  private async recordFailure(attemptedAt: Date, reason: string): Promise<void> {
    await this.database
      .insert(auditForwardingState)
      .values({ id: "global", lastAttemptAt: attemptedAt, lastError: reason })
      .onConflictDoUpdate({
        target: auditForwardingState.id,
        set: { lastAttemptAt: attemptedAt, lastError: reason, updatedAt: new Date() },
      });
  }
}
