import type { AuditEventList, AuditEventQuery } from "@orcasynapse/contracts";
import { auditEvent, type OrcaSynapseDatabase } from "@orcasynapse/database";
import { and, desc, eq, gte, lte, lt, or, type SQL } from "drizzle-orm";

export interface AuditManager {
  list(query: AuditEventQuery): Promise<AuditEventList>;
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
}
