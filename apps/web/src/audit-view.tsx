import type { AdministratorSession, AuditEvent, AuditEventQuery, AuditForwardingState } from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { OrcaSynapseApiError, getAuditEvents, getAuditForwarding } from "./api.js";
import { adminAccess } from "./admin-access.js";

interface AuditViewProps {
  session: AdministratorSession | null;
  onSessionExpired: () => void;
}

type Filters = Pick<AuditEventQuery, "action" | "actorType" | "resourceType" | "resourceId" | "outcome">;

const EMPTY: Filters = {};
const PAGE_SIZE = 50;

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function outcomeTone(outcome: string): string {
  if (outcome === "SUCCESS") return "ready";
  if (outcome === "FAILED" || outcome === "FAILURE") return "failed";
  return "quarantined";
}

export function AuditView({ session, onSessionExpired }: AuditViewProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<{ beforeOccurredAt: string; beforeId: string } | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<AuditForwardingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The trail is the AUDITOR role's entire reason to exist; without this scope
  // the API refuses, so say so rather than rendering an empty table.
  const { can } = adminAccess(session);
  const canRead = can("audit:read");

  const load = async (next: Filters, append: false | { beforeOccurredAt: string; beforeId: string }) => {
    if (!session || !canRead) return;
    setBusy(true);
    try {
      const page = await getAuditEvents({
        ...next,
        ...(append ? append : {}),
        limit: PAGE_SIZE,
      } as AuditEventQuery);
      setEvents((current) => (append ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to read the audit trail.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(EMPTY, false); }, [session]);

  useEffect(() => {
    if (!session || !canRead) return;
    void getAuditForwarding().then(setForwarding).catch(() => setForwarding(null));
  }, [session]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setApplied(filters);
    setExpanded(null);
    void load(filters, false);
  };

  const clear = () => {
    setFilters(EMPTY);
    setApplied(EMPTY);
    setExpanded(null);
    void load(EMPTY, false);
  };

  const activeFilterCount = Object.values(applied).filter(Boolean).length;

  if (!canRead) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Operations</p>
            <h2>Audit trail</h2>
            <p>Your administrator role does not carry the audit:read scope.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Operations</p>
          <h2>Audit trail</h2>
          <p>
            Every governed action OrcaSynapse records, newest first. The trail is append-only:
            nothing in the product can edit or delete an entry.
          </p>
        </div>
        <button className="text-button" type="button" onClick={() => void load(applied, false)} disabled={busy}>
          Refresh
        </button>
      </div>

      {forwarding && (
        <div className={`audit-forwarding ${forwarding.status.toLowerCase()}`}>
          <div>
            <strong>
              {forwarding.status === "NOT_CONFIGURED" ? "Retained locally"
                : forwarding.status === "FAILING" ? "Forwarding is failing"
                  : forwarding.status === "BEHIND" ? "Forwarding is behind"
                    : "Forwarding to SIEM"}
            </strong>
            <span>{forwarding.summary}</span>
            {forwarding.lastError && <code>{forwarding.lastError}</code>}
          </div>
          <dl>
            <div><dt>Undelivered</dt><dd>{forwarding.pendingCount.toLocaleString()}</dd></div>
            <div><dt>Delivered</dt><dd>{forwarding.deliveredCount.toLocaleString()}</dd></div>
            <div><dt>Last accepted</dt><dd>{forwarding.lastForwardedAt ? relativeTime(forwarding.lastForwardedAt) : "never"}</dd></div>
          </dl>
        </div>
      )}

      <form className="audit-filters" onSubmit={search}>
        <label>
          <span>Action</span>
          <input
            value={filters.action ?? ""}
            placeholder="administrator.session_created"
            onChange={(event) => setFilters({ ...filters, action: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Actor type</span>
          <select
            value={filters.actorType ?? ""}
            onChange={(event) => setFilters({ ...filters, actorType: (event.target.value || undefined) as Filters["actorType"] })}
          >
            <option value="">Any</option>
            <option value="USER">User</option>
            <option value="SERVICE">Service</option>
            <option value="SYSTEM">System</option>
          </select>
        </label>
        <label>
          <span>Resource type</span>
          <input
            value={filters.resourceType ?? ""}
            placeholder="ServiceConnection"
            onChange={(event) => setFilters({ ...filters, resourceType: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Resource ID</span>
          <input
            value={filters.resourceId ?? ""}
            onChange={(event) => setFilters({ ...filters, resourceId: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Outcome</span>
          <select
            value={filters.outcome ?? ""}
            onChange={(event) => setFilters({ ...filters, outcome: event.target.value || undefined })}
          >
            <option value="">Any</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
            <option value="FAILED">Failed</option>
          </select>
        </label>
        <div className="audit-filter-actions">
          <button type="submit" disabled={busy}>Search</button>
          <button className="text-button" type="button" onClick={clear} disabled={busy || activeFilterCount === 0}>
            Clear
          </button>
        </div>
      </form>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="audit-table">
        <div className="audit-head">
          <span>When</span><span>Action</span><span>Actor</span><span>Resource</span><span>Outcome</span>
        </div>
        {events.length === 0 && !busy ? (
          <div className="document-empty">
            <strong>{activeFilterCount > 0 ? "No matching events" : "No audit events recorded"}</strong>
            <span>
              {activeFilterCount > 0
                ? "Filters are exact matches, not prefixes. Clear them to see the whole trail."
                : "Governed actions are recorded here as soon as they happen."}
            </span>
          </div>
        ) : (
          events.map((event) => (
            <article
              key={event.id}
              className={expanded === event.id ? "expanded" : undefined}
              onClick={() => setExpanded(expanded === event.id ? null : event.id)}
            >
              <span title={event.occurredAt}>{relativeTime(event.occurredAt)}</span>
              <strong>{event.action}</strong>
              <span>{event.actorType.toLowerCase()}{event.actorId ? ` · ${event.actorId.slice(0, 8)}` : ""}</span>
              <span>{event.resourceType}{event.resourceId ? ` · ${event.resourceId.slice(0, 8)}` : ""}</span>
              <span className={`document-status ${outcomeTone(event.outcome)}`}>{event.outcome.toLowerCase()}</span>
              {expanded === event.id && (
                <div className="audit-detail">
                  <dl>
                    <div><dt>Recorded</dt><dd>{event.occurredAt}</dd></div>
                    <div><dt>Event</dt><dd>{event.id}</dd></div>
                    {event.actorId && <div><dt>Actor</dt><dd>{event.actorId}</dd></div>}
                    {event.resourceId && <div><dt>Resource</dt><dd>{event.resourceId}</dd></div>}
                    {event.correlationId && <div><dt>Correlation</dt><dd>{event.correlationId}</dd></div>}
                    {event.sourceIp && <div><dt>Source IP</dt><dd>{event.sourceIp}</dd></div>}
                  </dl>
                  <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                </div>
              )}
            </article>
          ))
        )}
      </div>

      {cursor && (
        <button
          className="text-button"
          type="button"
          onClick={() => void load(applied, cursor)}
          disabled={busy}
        >
          {busy ? "Loading…" : "Load older events"}
        </button>
      )}
    </section>
  );
}
