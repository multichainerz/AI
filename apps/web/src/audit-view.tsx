import type { AdministratorSession, AuditEvent, AuditEventQuery } from "@orcasynapse/contracts";
import { RefreshCw as SyncIcon, ScrollText } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { OrcaSynapseApiError, getAuditEvents } from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, EmptyState, Field, Input, MicroLabel, Panel, PanelHeading, Select, StatusText, WorkspaceDock, WorkspaceIntro, cn, toneFor,
} from "./ui/index.js";

interface AuditViewProps {
  session: AdministratorSession | null;
  onSessionExpired: () => void;
}

type Filters = Pick<AuditEventQuery, "action" | "actorType" | "resourceType" | "resourceId" | "outcome">;

const EMPTY: Filters = {};
const PAGE_SIZE = 50;
const ROW = "grid min-w-[920px] grid-cols-[minmax(108px,0.75fr)_minmax(0,1.8fr)_minmax(0,1.15fr)_minmax(0,1.35fr)_minmax(110px,0.85fr)_104px] gap-3";

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clock(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function actionTitle(action: string): string {
  const leaf = action.split(".").at(-1) ?? action;
  return leaf.replaceAll("_", " ");
}

function shortId(value: string | null, length = 12): string | null {
  if (!value) return null;
  return value.length > length ? value.slice(0, length) : value;
}

function outcomeTone(outcome: string): string {
  if (outcome === "SUCCESS") return "ready";
  if (outcome === "FAILED" || outcome === "FAILURE") return "failed";
  return "quarantined";
}

function metadataPreview(metadata: AuditEvent["metadata"]): string | null {
  const keys = Object.keys(metadata);
  if (keys.length === 0) return null;
  const first = keys[0]!;
  const value = metadata[first];
  if (typeof value === "string" && value.length > 0) {
    return `${first}: ${value.length > 48 ? `${value.slice(0, 48)}…` : value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return `${first}: ${String(value)}`;
  return `${keys.length} ${keys.length === 1 ? "field" : "fields"}`;
}

export function AuditView({ session, onSessionExpired }: AuditViewProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<{ beforeOccurredAt: string; beforeId: string } | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [expanded, setExpanded] = useState<string | null>(null);
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
    <div className="workspace-stack audit-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
      <WorkspaceIntro
        icon={<ScrollText className="size-4" aria-hidden="true" />}
        title="Audit trail"
        actions={<Button className="shrink-0" size="sm" onClick={() => void load(applied, false)} disabled={busy}><SyncIcon size={14} />Refresh</Button>}
      >
      </WorkspaceIntro>

      <WorkspaceDock>
      <form
        className="grid items-end gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(132px,0.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(132px,0.7fr)_auto]"
        onSubmit={search}
      >
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
      </WorkspaceDock>

      {error && <Alert className="shrink-0">{error}</Alert>}

      {/* A table that scrolls inside itself rather than widening the page: an
          audit row carries six columns and three of them are identifiers. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-border">
        <div className={cn(ROW, "shrink-0 border-b border-border bg-raised px-3 py-2")}>
          {["When", "Action", "Actor", "Resource", "Source", "Outcome"].map((head) => (
            <span className="text-micro font-semibold uppercase tabular-nums text-faint" key={head}>{head}</span>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
        {events.length === 0 && !busy ? (
          <EmptyState className="m-3 border-0" title={activeFilterCount > 0 ? "No matching events" : "No audit events recorded"}>
            {activeFilterCount > 0
              ? "Filters are exact matches, not prefixes. Clear them to see the whole trail."
              : "Governed actions are recorded here as soon as they happen. The trail is append-only: nothing in the product can edit or delete an entry."}
          </EmptyState>
        ) : (
          events.map((event) => {
            const preview = metadataPreview(event.metadata);
            return (
            <article
              key={event.id}
              className={cn(
                ROW,
                "cursor-pointer items-start border-b border-border px-3 py-2.5 text-body last:border-b-0",
                expanded === event.id ? "bg-raised" : "hover:bg-raised",
              )}
              onClick={() => setExpanded(expanded === event.id ? null : event.id)}
            >
              <span className="grid gap-0.5" title={event.occurredAt}>
                <span className="font-mono text-caption tabular-nums text-text">{relativeTime(event.occurredAt)}</span>
                <span className="font-mono text-micro tabular-nums text-faint">{clock(event.occurredAt)}</span>
              </span>
              <span className="grid min-w-0 gap-0.5">
                <strong className="truncate text-caption font-semibold capitalize text-text">{actionTitle(event.action)}</strong>
                <span className="truncate font-mono text-micro text-faint">{event.action}</span>
                {preview ? <span className="truncate text-micro text-muted">{preview}</span> : null}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <MicroLabel>{event.actorType.toLowerCase()}</MicroLabel>
                <span className="truncate font-mono text-caption text-muted" title={event.actorId ?? undefined}>
                  {shortId(event.actorId) ?? "—"}
                </span>
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-caption text-text">{event.resourceType}</span>
                <span className="truncate font-mono text-micro text-faint" title={event.resourceId ?? undefined}>
                  {shortId(event.resourceId) ?? "—"}
                </span>
              </span>
              <span className="truncate font-mono text-caption text-muted" title={event.sourceIp ?? undefined}>
                {event.sourceIp ?? "—"}
              </span>
              <StatusText className="mt-0.5" dot tone={toneFor(outcomeTone(event.outcome))}>{event.outcome.toLowerCase()}</StatusText>
              {expanded === event.id && (
                <div className="col-span-6 grid gap-3 border-t border-border pt-3">
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
                        <dt className="text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
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
            );
          })
        )}
        </div>
      </div>

      {cursor && (
        <Button className="shrink-0 self-start" onClick={() => void load(applied, cursor)} disabled={busy}>
          {busy ? "Loading…" : "Load older events"}
        </Button>
      )}
    </div>
  );
}
