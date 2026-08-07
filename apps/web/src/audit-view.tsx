import type { AdministratorSession, AuditEvent, AuditEventQuery, AuditForwardingState } from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { OrcaSynapseApiError, getAuditEvents, getAuditForwarding } from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, EmptyState, Field, Input, Panel, PanelHeading, Select, StatusText, cn, toneFor,
} from "./ui/index.js";

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
      <Panel>
        <PanelHeading
          kicker="Operations"
          title="Audit trail"
          description="Your administrator role does not carry the audit:read scope."
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeading
        kicker="Operations"
        title="Audit trail"
        description="Every governed action OrcaSynapse records, newest first. The trail is append-only: nothing in the product can edit or delete an entry."
        actions={<Button size="sm" onClick={() => void load(applied, false)} disabled={busy}>Refresh</Button>}
      />

      {forwarding && (
        /* The left rule is the state. An audit trail that is silently behind
           or failing to reach the SIEM is the one thing this panel exists to
           surface, and it must not read the same as a healthy one. */
        <div className={cn(
          "mb-4 flex flex-wrap items-start justify-between gap-4 rounded border border-l-2 border-border p-3.5",
          forwarding.status === "FAILING" ? "border-l-bad"
            : forwarding.status === "BEHIND" ? "border-l-warn"
              : forwarding.status === "NOT_CONFIGURED" ? "border-l-border-strong" : "border-l-good",
        )}>
          <div className="min-w-0">
            <strong className="block text-[12px] font-semibold text-text">
              {forwarding.status === "NOT_CONFIGURED" ? "Retained locally"
                : forwarding.status === "FAILING" ? "Forwarding is failing"
                  : forwarding.status === "BEHIND" ? "Forwarding is behind"
                    : "Forwarding to SIEM"}
            </strong>
            <span className="mt-1 block text-body text-muted">{forwarding.summary}</span>
            {forwarding.lastError && (
              <code className="mt-1.5 block rounded border border-bad/40 bg-bad/10 px-2 py-1 font-mono text-micro text-bad">
                {forwarding.lastError}
              </code>
            )}
          </div>
          <dl className="m-0 flex shrink-0 gap-5">
            {[
              { label: "Undelivered", value: forwarding.pendingCount.toLocaleString() },
              { label: "Delivered", value: forwarding.deliveredCount.toLocaleString() },
              { label: "Last accepted", value: forwarding.lastForwardedAt ? relativeTime(forwarding.lastForwardedAt) : "never" },
            ].map((fact) => (
              <div key={fact.label}>
                <dt className="font-mono text-micro uppercase text-faint">{fact.label}</dt>
                <dd className="m-0 mt-1 font-mono text-caption tabular-nums text-muted">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <form className="mb-4 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={search}>
        <Field label="Action">
          <Input
            value={filters.action ?? ""}
            placeholder="administrator.session_created"
            onChange={(event) => setFilters({ ...filters, action: event.target.value || undefined })}
          />
        </Field>
        <Field label="Actor type">
          <Select
            value={filters.actorType ?? ""}
            onChange={(event) => setFilters({ ...filters, actorType: (event.target.value || undefined) as Filters["actorType"] })}
          >
            <option value="">Any</option>
            <option value="USER">User</option>
            <option value="SERVICE">Service</option>
            <option value="SYSTEM">System</option>
          </Select>
        </Field>
        <Field label="Resource type">
          <Input
            value={filters.resourceType ?? ""}
            placeholder="ServiceConnection"
            onChange={(event) => setFilters({ ...filters, resourceType: event.target.value || undefined })}
          />
        </Field>
        <Field label="Resource ID">
          <Input
            value={filters.resourceId ?? ""}
            onChange={(event) => setFilters({ ...filters, resourceId: event.target.value || undefined })}
          />
        </Field>
        <Field label="Outcome">
          <Select
            value={filters.outcome ?? ""}
            onChange={(event) => setFilters({ ...filters, outcome: event.target.value || undefined })}
          >
            <option value="">Any</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
            <option value="FAILED">Failed</option>
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button variant="primary" type="submit" disabled={busy}>Search</Button>
          <Button variant="ghost" onClick={clear} disabled={busy || activeFilterCount === 0}>Clear</Button>
        </div>
      </form>

      {error && <Alert className="mb-4">{error}</Alert>}

      {/* A table that scrolls inside itself rather than widening the page: an
          audit row carries five columns and two of them are identifiers. */}
      <div className="overflow-x-auto rounded border border-border">
        <div className="grid min-w-[720px] grid-cols-[110px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_90px] gap-3 border-b border-border bg-raised px-3 py-2">
          {["When", "Action", "Actor", "Resource", "Outcome"].map((head) => (
            <span className="font-mono text-micro uppercase text-faint" key={head}>{head}</span>
          ))}
        </div>
        {events.length === 0 && !busy ? (
          <EmptyState className="m-3 border-0" title={activeFilterCount > 0 ? "No matching events" : "No audit events recorded"}>
            {activeFilterCount > 0
              ? "Filters are exact matches, not prefixes. Clear them to see the whole trail."
              : "Governed actions are recorded here as soon as they happen."}
          </EmptyState>
        ) : (
          events.map((event) => (
            <article
              key={event.id}
              className={cn(
                "grid min-w-[720px] cursor-pointer grid-cols-[110px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_90px] items-center gap-3 border-b border-border px-3 py-2 text-body last:border-b-0",
                expanded === event.id ? "bg-raised" : "hover:bg-raised",
              )}
              onClick={() => setExpanded(expanded === event.id ? null : event.id)}
            >
              <span className="truncate font-mono text-micro text-faint" title={event.occurredAt}>
                {relativeTime(event.occurredAt)}
              </span>
              <strong className="truncate font-mono text-caption font-medium text-text">{event.action}</strong>
              <span className="truncate font-mono text-caption text-muted">
                {event.actorType.toLowerCase()}{event.actorId ? ` · ${event.actorId.slice(0, 8)}` : ""}
              </span>
              <span className="truncate font-mono text-caption text-muted">
                {event.resourceType}{event.resourceId ? ` · ${event.resourceId.slice(0, 8)}` : ""}
              </span>
              <StatusText dot tone={toneFor(outcomeTone(event.outcome))}>{event.outcome.toLowerCase()}</StatusText>
              {expanded === event.id && (
                <div className="col-span-5 grid gap-3 border-t border-border pt-3">
                  <dl className="m-0 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      { label: "Recorded", value: event.occurredAt },
                      { label: "Event", value: event.id },
                      ...(event.actorId ? [{ label: "Actor", value: event.actorId }] : []),
                      ...(event.resourceId ? [{ label: "Resource", value: event.resourceId }] : []),
                      ...(event.correlationId ? [{ label: "Correlation", value: event.correlationId }] : []),
                      ...(event.sourceIp ? [{ label: "Source IP", value: event.sourceIp }] : []),
                    ].map((fact) => (
                      <div className="min-w-0" key={fact.label}>
                        <dt className="font-mono text-micro uppercase text-faint">{fact.label}</dt>
                        <dd className="m-0 mt-1 break-all font-mono text-caption text-muted">{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <pre className="m-0 max-h-[240px] overflow-auto rounded border border-border bg-bg p-3 font-mono text-micro leading-relaxed text-muted">
                    {JSON.stringify(event.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </article>
          ))
        )}
      </div>

      {cursor && (
        <Button className="mt-3" onClick={() => void load(applied, cursor)} disabled={busy}>
          {busy ? "Loading…" : "Load older events"}
        </Button>
      )}
    </Panel>
  );
}
