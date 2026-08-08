--
-- A commit-ordered position for the audit trail.
--
-- `occurredAt` defaults to CURRENT_TIMESTAMP, which PostgreSQL freezes at the
-- start of the transaction, so timestamp order is not commit order. Audit
-- events are written inside the transaction doing the governed work, so an
-- event stamped .248 by a slow transaction becomes visible after an event
-- stamped .669 by a fast one. A forwarding cursor over ("occurredAt", "id")
-- walks past the slower event while it is still invisible and never returns to
-- it, and the backlog query - which shares that predicate - then counts the
-- hole as delivered, so the trail reports itself complete while missing an
-- event. `clock_timestamp()` would not help: commit order still differs from
-- insert order.
--
-- A sequence gives the forwarder a single order it can reason about, and one
-- that no longer loses precision on the way back out: a timestamp cursor
-- round-tripped through a JavaScript Date truncated microseconds, so boundary
-- events re-matched and were delivered on every pass forever. This is the same
-- shape "AgentRunEvent"."cursor" already uses to stream run events in order.
--
-- A sequence value is claimed inside the inserting transaction rather than at
-- commit, so it is the forwarder that must not advance past a position that is
-- still in flight; see deliverablePrefix in siem-forwarder.ts.
--
ALTER TABLE "AuditEvent" ADD COLUMN "cursor" bigserial NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "AuditEvent_cursor_key" ON "AuditEvent" USING btree ("cursor");--> statement-breakpoint
ALTER TABLE "AuditForwardingState" ADD COLUMN "lastForwardedCursor" bigint;--> statement-breakpoint
--
-- Carry an existing deployment's position across rather than re-sending the
-- whole trail. The new position sits just below the oldest event the old
-- cursor still considered undelivered, so nothing that was pending becomes
-- delivered by the migration itself; where the old cursor delivered out of
-- sequence order, the overlap is re-sent, which is the direction an audit
-- trail should err in.
--
UPDATE "AuditForwardingState" AS s
SET "lastForwardedCursor" = COALESCE(
  (
    SELECT min(e."cursor") - 1
    FROM "AuditEvent" e
    WHERE (e."occurredAt", e."id") > (s."lastForwardedAt", s."lastForwardedId")
  ),
  (SELECT e."cursor" FROM "AuditEvent" e WHERE e."id" = s."lastForwardedId")
)
WHERE s."lastForwardedAt" IS NOT NULL AND s."lastForwardedId" IS NOT NULL;
