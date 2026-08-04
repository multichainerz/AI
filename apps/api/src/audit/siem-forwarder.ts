import {
  auditEvent,
  auditForwardingState,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";

const TICK_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

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
 * syslog. Delivery position is a keyset cursor over the append-only trail: a
 * failed batch leaves the cursor untouched and is retried, so events are never
 * skipped. Duplicates are possible if a batch is delivered and the cursor write
 * then fails, which is the correct trade for an audit trail - a SIEM can
 * deduplicate on event id, but it cannot invent an event it never received.
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
    // Strictly after the cursor, breaking ties on id so events sharing a
    // timestamp are neither re-sent nor skipped.
    const after = state?.lastForwardedAt && state.lastForwardedId
      ? or(
        gt(auditEvent.occurredAt, state.lastForwardedAt),
        and(eq(auditEvent.occurredAt, state.lastForwardedAt), gt(auditEvent.id, state.lastForwardedId)),
      )
      : undefined;

    const batch = await this.database
      .select()
      .from(auditEvent)
      .where(after)
      .orderBy(asc(auditEvent.occurredAt), asc(auditEvent.id))
      .limit(batchSize);
    if (batch.length === 0) return { forwarded: 0 };

    const endpoint = new URL(
      typeof destination.configuration.eventsPath === "string" ? destination.configuration.eventsPath : "/events",
      `${destination.baseUrl.replace(/\/+$/, "")}/`,
    );
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

    const last = batch.at(-1)!;
    await this.database
      .insert(auditForwardingState)
      .values({
        id: "global",
        lastForwardedAt: last.occurredAt,
        lastForwardedId: last.id,
        lastAttemptAt: attemptedAt,
        lastError: null,
        deliveredCount: batch.length,
      })
      .onConflictDoUpdate({
        target: auditForwardingState.id,
        set: {
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
