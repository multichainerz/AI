# Audit Trail Runbook

The audit trail is append-only by construction: every governed path writes an
`AuditEvent`, and no update or delete path exists anywhere in the product. This
runbook covers reading the trail and what it retains.

Forwarding the trail to an external SIEM was removed at v9.0.0: the exporter is
gone, the trail is not. Every event the product recorded before that release is
still there, and every governed path still writes one.

## Reading the trail

- Dashboard: **Operations > Audit trail** (`#operations/audit`).
- API: `GET /api/v1/admin/audit/events`.
- Both require the `audit:read` scope — the scope the **AUDITOR** role exists
  for; PLATFORM_ADMIN and SECURITY_ADMIN also hold it.

Filters are exact-match: `action`, `actorType`, `actorId`, `resourceType`,
`resourceId`, `outcome`, `correlationId`, plus an `occurredFrom`/`occurredTo`
window. Pagination is keyset on `(occurredAt, id)` — pass the returned
`nextCursor` fields back verbatim; offsets are deliberately unsupported because
the trail only grows.

Event metadata is carried through unchanged from the writer, so incident
review sees exactly what the governed path recorded (for example
`guardrail.request_blocked` carries the block reason and observed counts).
