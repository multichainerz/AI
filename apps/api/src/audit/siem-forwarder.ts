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
 * How long a hole must have been a hole before it can be declared permanent.
 *
 * This covers one window and nothing else: a transaction evaluates the cursor
 * default a moment before its first heap insert assigns it a transaction id, so
 * for that instant it holds a position while being invisible to any test made
 * of transaction ids. The window is microseconds of executor work; a minute is
 * six orders of magnitude of margin, and it is only ever paid on a position
 * that has already been observed missing.
 */
const HOLE_GRACE_MS = 60_000;

/** The transaction-id horizon of one read, in wraparound-free xid8 form. */
interface Horizon {
  /** Every transaction below this has finished. */
  xmin: bigint;
  /** No transaction at or above this had been assigned an id yet. */
  xmax: bigint;
}

/**
 * A run of positions seen missing, and the horizon at the moment they were.
 *
 * Held in memory rather than in auditForwardingState, which has no column for
 * it. Losing it on restart only costs another observation cycle: the forwarder
 * waits again rather than skipping something it has not yet proved dead, which
 * is the direction an audit trail should fail in.
 */
interface HoleObservation extends Horizon {
  from: bigint;
  to: bigint;
  observedAt: number;
}

/**
 * The leading run of a batch that is provably complete.
 *
 * An unbroken run of positions is safe on its own: a position that is already
 * occupied cannot also be held by an uncommitted write, so nothing can still
 * arrive between these events. Past a hole nothing is safe, because a hole is
 * either a write still in flight or one that was rolled back, and the trail
 * cannot tell those apart by looking at itself.
 *
 * The previous rule tried to, and it was wrong in a way that lost events. It
 * compared the xid that wrote a row against the oldest xid still running and
 * read the answer as "nothing earlier is outstanding" -- but a transaction
 * takes its xid at its first write and its cursor at the audit insert, and
 * every writer here inserts its domain row first. An older transaction can
 * therefore hold a *later* position, which made a row past a hole look settled,
 * advanced the cursor over the hole, and left `gt(cursor, after)` excluding the
 * missing event from every later pass -- permanently, and silently, because the
 * backlog query shares that predicate.
 *
 * So a hole stops the batch. `holeIsSettled` is the only way past one, and what
 * it decides is not "did this row's writer come first" but "can anything still
 * arrive here at all" -- see SiemForwarder.holeIsSettled.
 */
function deliverablePrefix<T extends { cursor: bigint }>(
  batch: readonly T[],
  after: bigint,
  holeIsSettled: (from: bigint, to: bigint) => boolean,
): { deliverable: T[]; hole?: { from: bigint; to: bigint } } {
  let expected = after + 1n;
  let count = 0;
  for (const candidate of batch) {
    if (candidate.cursor !== expected) {
      const hole = { from: expected, to: candidate.cursor - 1n };
      if (!holeIsSettled(hole.from, hole.to)) return { deliverable: batch.slice(0, count), hole };
    }
    expected = candidate.cursor + 1n;
    count += 1;
  }
  return { deliverable: batch.slice(0, count) };
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
  /** The run of positions this forwarder is currently waiting out. */
  private hole: HoleObservation | undefined;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly connections: ConnectionDiagnosticStore,
    private readonly logger: SiemForwarderLogger,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tickIntervalMs = TICK_INTERVAL_MS,
    private readonly holeGraceMs = HOLE_GRACE_MS,
  ) {}

  /**
   * Whether this run of positions can never be filled.
   *
   * Two conditions, and both are about what could still write there rather than
   * about what already did.
   *
   * The first is that every transaction holding an id when the hole was
   * observed has since ended: `xmin` now at or past the `xmax` recorded then
   * means exactly that, in xid8, which is 64-bit and so has no wraparound to
   * reason about. Anything that started afterwards took a position above
   * everything already handed out, so it cannot land here.
   *
   * The second is the grace period, which covers the one gap the first leaves:
   * the instant between a transaction evaluating the cursor default and its
   * first heap insert giving it an id. That is the whole of the reasoning --
   * nothing here assumes the order positions were claimed in matches the order
   * transaction ids were issued in, which is the assumption that lost events.
   *
   * The observation has to match this hole exactly. A hole that partly filled
   * is a different hole and starts its own wait.
   */
  private holeIsSettled(from: bigint, to: bigint, horizon: Horizon): boolean {
    const observed = this.hole;
    if (!observed || observed.from !== from || observed.to !== to) return false;
    if (Date.now() - observed.observedAt < this.holeGraceMs) return false;
    return horizon.xmin >= observed.xmax;
  }

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
    // The horizon is read in the same statement as the rows, so it describes
    // the same snapshot the holes were observed in rather than a later one.
    const candidates = await this.database
      .select({
        ...getTableColumns(auditEvent),
        xmin: sql<string>`pg_snapshot_xmin(pg_current_snapshot())::text`,
        xmax: sql<string>`pg_snapshot_xmax(pg_current_snapshot())::text`,
      })
      .from(auditEvent)
      .where(gt(auditEvent.cursor, after))
      .orderBy(asc(auditEvent.cursor))
      .limit(batchSize);

    const first = candidates[0];
    const horizon: Horizon | undefined = first
      ? { xmin: BigInt(first.xmin), xmax: BigInt(first.xmax) }
      : undefined;
    const { deliverable: batch, hole } = deliverablePrefix(
      candidates,
      after,
      (from, to) => horizon !== undefined && this.holeIsSettled(from, to, horizon),
    );
    /*
     * A hole is remembered so the next cycle can measure how long it has been
     * one; re-recording the same hole every cycle would restart the clock and
     * leave forwarding stalled behind a position nothing will ever fill.
     */
    if (!hole || !horizon) this.hole = undefined;
    else if (this.hole?.from !== hole.from || this.hole.to !== hole.to) {
      this.hole = { ...hole, ...horizon, observedAt: Date.now() };
    }
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
