import type { AuditEventList, AuditEventQuery, AuditForwardingState } from "@orcasynapse/contracts";
import {
  auditEvent,
  auditForwardingState,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, count, desc, eq, gt, gte, lte, lt, or, type SQL } from "drizzle-orm";

/** A backlog past this is worth an operator's attention rather than a shrug. */
const BEHIND_THRESHOLD = 500;

export interface AuditManager {
  list(query: AuditEventQuery): Promise<AuditEventList>;
  forwarding(): Promise<AuditForwardingState>;
}

/**
 * Read access to the append-only audit trail.
 *
 * The trail is written from every governed path and was previously unreadable
 * from anywhere in the product, which left the audit:read scope and the AUDITOR
 * role without a surface. This is that surface. It is read-only by construction:
 * there is no update or delete path, here or anywhere else.
 */
export class DrizzleAuditManager implements AuditManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async list(query: AuditEventQuery): Promise<AuditEventList> {
    const filters: Array<SQL | undefined> = [
      query.action ? eq(auditEvent.action, query.action) : undefined,
      query.actorType ? eq(auditEvent.actorType, query.actorType) : undefined,
      query.actorId ? eq(auditEvent.actorId, query.actorId) : undefined,
      query.resourceType ? eq(auditEvent.resourceType, query.resourceType) : undefined,
      query.resourceId ? eq(auditEvent.resourceId, query.resourceId) : undefined,
      query.outcome ? eq(auditEvent.outcome, query.outcome) : undefined,
      query.correlationId ? eq(auditEvent.correlationId, query.correlationId) : undefined,
      query.occurredFrom ? gte(auditEvent.occurredAt, new Date(query.occurredFrom)) : undefined,
      query.occurredTo ? lte(auditEvent.occurredAt, new Date(query.occurredTo)) : undefined,
    ];

    // Keyset cursor: strictly older than the last row the caller saw, breaking
    // ties on id so events sharing a timestamp are never skipped or repeated.
    if (query.beforeOccurredAt && query.beforeId) {
      const boundary = new Date(query.beforeOccurredAt);
      filters.push(or(
        lt(auditEvent.occurredAt, boundary),
        and(eq(auditEvent.occurredAt, boundary), lt(auditEvent.id, query.beforeId)),
      ));
    }

    const rows = await this.database
      .select()
      .from(auditEvent)
      .where(and(...filters))
      .orderBy(desc(auditEvent.occurredAt), desc(auditEvent.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((event) => ({
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
        metadata: event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
          ? event.metadata as Record<string, unknown>
          : {},
      })),
      nextCursor: rows.length > query.limit && last
        ? { beforeOccurredAt: last.occurredAt.toISOString(), beforeId: last.id }
        : null,
    };
  }

  /**
   * Whether the trail is reaching its destination.
   *
   * The forwarder records its own position and last failure; what it cannot know
   * is how far behind that leaves it, because the backlog is a property of the
   * trail rather than of the last attempt.
   */
  async forwarding(): Promise<AuditForwardingState> {
    const [configured] = await this.database
      .select({ total: count() })
      .from(serviceConnection)
      .where(and(eq(serviceConnection.kind, "SIEM"), eq(serviceConnection.enabled, true)));
    const [state] = await this.database
      .select()
      .from(auditForwardingState)
      .where(eq(auditForwardingState.id, "global"))
      .limit(1);

    const after = state?.lastForwardedAt && state.lastForwardedId
      ? or(
        gt(auditEvent.occurredAt, state.lastForwardedAt),
        and(eq(auditEvent.occurredAt, state.lastForwardedAt), gt(auditEvent.id, state.lastForwardedId)),
      )
      : undefined;
    const [pending] = await this.database.select({ total: count() }).from(auditEvent).where(after);
    const pendingCount = pending?.total ?? 0;

    if ((configured?.total ?? 0) === 0) {
      return {
        status: "NOT_CONFIGURED",
        pendingCount,
        deliveredCount: state?.deliveredCount ?? 0,
        lastForwardedAt: state?.lastForwardedAt?.toISOString() ?? null,
        lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
        lastError: state?.lastError ?? null,
        summary: "No SIEM connection is enabled, so the trail is retained locally only.",
      };
    }

    const status = state?.lastError
      ? "FAILING" as const
      : pendingCount > BEHIND_THRESHOLD
        ? "BEHIND" as const
        : "HEALTHY" as const;
    return {
      status,
      pendingCount,
      deliveredCount: state?.deliveredCount ?? 0,
      lastForwardedAt: state?.lastForwardedAt?.toISOString() ?? null,
      lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
      lastError: state?.lastError ?? null,
      summary: status === "FAILING"
        ? `The SIEM endpoint is rejecting batches; ${pendingCount} event${pendingCount === 1 ? "" : "s"} are undelivered.`
        : status === "BEHIND"
          ? `Forwarding is accepting batches but ${pendingCount} events are still queued.`
          : pendingCount === 0
            ? "Every recorded event has been accepted by the SIEM."
            : `${pendingCount} event${pendingCount === 1 ? "" : "s"} await the next forwarding pass.`,
    };
  }
}
