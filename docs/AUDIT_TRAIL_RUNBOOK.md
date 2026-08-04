# Audit Trail and SIEM Forwarding Runbook

The audit trail is append-only by construction: every governed path writes an
`AuditEvent`, and no update or delete path exists anywhere in the product. This
runbook covers reading the trail, forwarding it to a SIEM, and interpreting
forwarding health.

## Reading the trail

- Dashboard: **Operations > Audit trail** (`#operations/audit`).
- API: `GET /api/v1/admin/audit/events` and `GET /api/v1/admin/audit/forwarding`.
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

## Forwarding to a SIEM

Model the SIEM as a service connection of kind **SIEM** (enabled, with a base
URL and an `apiKey` secret). Exactly one enabled SIEM connection may exist —
the forwarder refuses to guess between two.

Configuration keys on the connection:

| Key | Default | Meaning |
| --- | --- | --- |
| `eventsPath` | `/events` | Relative path POSTed to on the SIEM origin. Origin-changing values (`//host/...`) are rejected at write time and again at use. |
| `forwardBatchSize` | 100 | Events per POST (1–500). |
| `timeoutMs` | 10000 | Per-request timeout. |

The forwarder runs on a 15-second timer inside the API process. Each batch is
a JSON body `{ source: "orcasynapse", events: [...] }` with a
`Bearer` authorization header from the connection's `apiKey` secret.

**Delivery semantics: at-least-once.** Position is a keyset cursor over the
trail (`AuditForwardingState`); a failed batch never advances the cursor, so
events are never skipped. Duplicates are possible if a batch lands but the
cursor write then fails — deduplicate on the event `id` in the SIEM; an event
can be re-sent, but never invented.

## Forwarding health

`GET /api/v1/admin/audit/forwarding` (also shown as the status strip in the
audit view) reports:

| Status | Meaning | Operator action |
| --- | --- | --- |
| `NOT_CONFIGURED` | No enabled SIEM connection; the trail is retained locally only. | None, unless forwarding is required by policy. |
| `HEALTHY` | The last batch was accepted and the backlog is small. | None. |
| `BEHIND` | Batches are being accepted but more than 500 events are still queued. | Check SIEM throughput or raise `forwardBatchSize`. |
| `FAILING` | The destination is rejecting batches or unreachable; `lastError` says why. | Fix the SIEM endpoint or credentials; delivery resumes from the cursor. |

AI Ops observes forwarding as its own component in the operations overview:
`BEHIND` and `FAILING` surface as **DEGRADED** with an automatically opened
WARNING incident (the trail is not lost — it is retained locally and resumes
when the destination recovers). The incident resolves itself once forwarding
is healthy again.

## Acceptance checks

1. With no SIEM connection, the audit view shows the trail and reports
   forwarding `NOT_CONFIGURED`.
2. Enable a SIEM connection; events flow in order and `deliveredCount` grows.
3. Make the SIEM reject requests (or stop it): status becomes `FAILING`, the
   operations overview shows the audit-forwarding component DEGRADED with an
   incident, and the cursor stops advancing.
4. Restore the SIEM: the failed batch is retried first, no events are missing,
   the incident resolves.
5. Verify the SIEM deduplicates on event `id` if step 3/4 produced a re-send.
6. Confirm a second enabled SIEM connection stops forwarding with an explicit
   "more than one" error rather than splitting the stream.
