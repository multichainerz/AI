import {
  type AdministratorSession,
  type AiOpsComponent,
  type AiOpsOverview,
  type GuardrailControl,
  type OperationalIncident,
  type RuntimeExecutorSnapshot,
} from "@orcasynapse/contracts";
import { Activity, Flag, HeartPulse, RefreshCw as SyncIcon, Timer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  OrcaSynapseApiError,
  createOperationalIncident,
  decideOperationalIncident,
  getAiOpsOverview,
  getOperationalIncidents,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, EmptyState, HeroBanner, Input, LockedScreen, Metric, MetricRow, MicroLabel,
  Panel, PanelHeading, Select, StatusText, Textarea, Tile, WorkspaceDock, WorkspaceIntro, cn, toneFor,
} from "./ui/index.js";

/**
 * Health: is the deployment working right now?
 *
 * This screen used to be four sub-tabs behind one called "Health & evidence",
 * the only three-level navigation left in the product besides Setup. Two of
 * those tabs have gone their own ways:
 *
 * - **Release gates** was removed with the whole evaluation subsystem. It was
 *   the only client of `POST /evaluations`, and the evidence it produced was
 *   the only way to satisfy an activation gate that applied even in
 *   development — so the gate went with it, and models, guardrails
 *   and agent profiles now activate on their own merits.
 * - **Pilot readiness** was deleted outright, not moved. Nothing in the
 *   repository can create a `ProductionReadinessControl`: the API exposes
 *   `GET /readiness`, `PATCH /readiness/controls/:key` and
 *   `POST /readiness/approvals` and no create route, production code only ever
 *   SELECTs and UPDATEs the table, and neither migration seeds it — the only
 *   INSERT in either is the schema epoch row. Its own empty state admitted as
 *   much ("the production-readiness checklist has not been migrated"). The
 *   tables are untouched; the screen was a promise the backend cannot keep.
 *
 * What is left is one screen with no tab strip: what is degraded, and what has
 * been raised about it. The incident queue used to be a panel here linking to
 * a sibling tab; the incidents are simply below it now.
 */

interface OperationsViewProps {
  session: AdministratorSession | null;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

type IncidentAction = { id: string; action: "acknowledge" | "resolve" } | null;

const numberFormatter = new Intl.NumberFormat();

function relativeTime(value: string | null): string {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * How old a snapshot may be before this screen stops speaking in the present
 * tense about it.
 *
 * Five minutes. The overview is regenerated on load and on Refresh, so a
 * healthy screen is seconds old; anything past this is a page left open, or a
 * control plane that stopped answering while the reader was looking at it.
 */
const SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1_000;

/**
 * How many incidents `GET /ai-ops/incidents` will ever return.
 *
 * `DrizzleAiOpsManager.listIncidents` is a bare `limit: 200` ordered by
 * `detectedAt` descending and `OperationalIncidentList` carries no total, so a
 * full array means "at least 200 exist". The hero above the ledger prints
 * `overview.incidents.open`, which is an unbounded `count()` over the same
 * table -- two figures from different sources, on one screen, that disagree
 * once the ledger fills. The ledger is the one that has to admit its edge.
 */
const INCIDENT_WINDOW = 200;

export function snapshotIsStale(generatedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!generatedAt) return false;
  const timestamp = new Date(generatedAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp > SNAPSHOT_STALE_AFTER_MS;
}

function percentage(value: number | null): string {
  return value === null ? "--" : `${Math.round(value * 1000) / 10}%`;
}

function humanLabel(value: string): string {
  const special: Partial<Record<string, string>> = { MCP: "MCP", OIDC: "OIDC", SIEM: "SIEM", TOOL_USE: "Tool use", MODEL_ACCESS: "Model access", DATA_EGRESS: "Data egress" };
  return special[value] ?? value.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * The four vocabularies this screen speaks, translated into the shared one
 * before anything is coloured.
 *
 * `toneFor` recognises `ready|healthy|active`, `degraded|validation|not_tested|
 * draft` and `blocked|unreachable|failed`, and answers neutral grey to
 * everything else. None of the enums below is in that list, and lower-casing
 * them — which is what this file did — is not a translation: `unavailable`,
 * `not_verified`, `not_configured`, every executor status and every guardrail
 * status all fell through to grey.
 *
 * That produced an inverted signal rather than a dull one. `sortedComponents`
 * puts UNAVAILABLE first as the most severe thing on the page, and it was drawn
 * quieter than the DEGRADED row beneath it; a stopped worker was
 * indistinguishable from a running one. The rule these four keep is that
 * severity survives the mapping, which is the whole reason the mapping exists.
 *
 * Private and per-vocabulary, in the shape `models-view`, `guardrails-view`
 * and `audit-view` already use: widening the shared `toneFor`
 * would mean one function owning six enums that happen not to collide today.
 */
function componentStatusTone(status: AiOpsComponent["status"]): string {
  if (status === "HEALTHY") return "healthy";
  if (status === "UNAVAILABLE") return "unreachable";
  /*
   * Degraded and never-verified share the amber deliberately. One is failing
   * now and the other has no evidence it ever worked, and neither is a state an
   * operator may leave alone -- the label beside the dot says which is which.
   * NOT_CONFIGURED is the one that is genuinely not a fault: nothing was asked
   * of it, which is also where the sort puts it, below both.
   */
  if (status === "DEGRADED" || status === "NOT_VERIFIED") return "degraded";
  return "not_configured";
}

function executorStatusTone(status: RuntimeExecutorSnapshot["status"]): string {
  if (status === "ONLINE") return "healthy";
  if (status === "STALE") return "degraded";
  // STOPPED: nothing is draining the queue this screen prints two panels above,
  // which is the same class of fact as a service that cannot be reached.
  return "failed";
}

function guardrailStatusTone(status: GuardrailControl["status"]): string {
  if (status === "ENFORCED") return "healthy";
  // PARTIAL and NOT_VERIFIED both: a protection that covers some of the path
  // and one with no evidence behind it are equally not a protection an operator
  // can rely on, and neither is a failure to be alarmed by.
  return "degraded";
}

function overviewStatusTone(status: AiOpsOverview["status"]): string {
  if (status === "HEALTHY") return "healthy";
  if (status === "DEGRADED") return "degraded";
  return "blocked";
}

function incidentSort(items: OperationalIncident[]): OperationalIncident[] {
  return [...items].sort((left, right) => {
    const statusWeight = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 } as const;
    if (left.status !== right.status) return statusWeight[left.status] - statusWeight[right.status];
    if (left.severity !== right.severity) return left.severity === "CRITICAL" ? -1 : 1;
    return right.detectedAt.localeCompare(left.detectedAt);
  });
}

export function OperationsView({ session, onConfigure, onSessionExpired }: OperationsViewProps) {
  const [overview, setOverview] = useState<AiOpsOverview | null>(null);
  const [incidents, setIncidents] = useState<OperationalIncident[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [incidentAction, setIncidentAction] = useState<IncidentAction>(null);
  const [decisionNote, setDecisionNote] = useState("");
  /**
   * Who owns the incident once this decision is recorded.
   *
   * Seeded from the incident's current owner rather than left empty, because
   * `DrizzleAiOpsManager` writes `owner: input.owner ?? principal.subject` for
   * both decisions: a form that sends only a note hands the incident to
   * whoever pressed the button. An incident owned by "Platform team" silently
   * becoming one administrator's is a change to the single field that says who
   * is dealing with it, made by an action that does not read as a change of
   * ownership at all -- and there is nothing on this screen that would show it
   * happened, let alone undo it.
   */
  const [decisionOwner, setDecisionOwner] = useState("");
  const [showIncidentForm, setShowIncidentForm] = useState(false);

  const { unlocked, scopes } = adminAccess(session);
  const canOperate = scopes.includes("operations:execute");

  // Held in a ref so `handleError` keeps one identity for the life of the view.
  //
  // App re-renders on its own poll and passes a fresh `onSessionExpired` arrow
  // every few seconds. Depending on that identity propagated through
  // handleError -> refresh -> the load effect, so Operations refetched both
  // endpoints on a loop: each cycle set `busy`, which disables every submit
  // button, and cleared the error an operator was still reading. It was four
  // endpoints when release gates and pilot readiness were sub-tabs here.
  const latestOnSessionExpired = useRef(onSessionExpired);
  useEffect(() => {
    latestOnSessionExpired.current = onSessionExpired;
  }, [onSessionExpired]);

  const handleError = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
    setError(cause instanceof Error ? cause.message : fallback);
  }, []);

  const refresh = useCallback(async () => {
    if (!unlocked) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Two reads, not one, and they are not interchangeable. The overview's
       * `incidents` carries the open/critical counts drawn in the hero plus its
       * own `items` -- the twenty most recent *open* rows -- while the ledger
       * below needs the full history, resolved rows included, which is what
       * `getOperationalIncidents` returns (200 most recent, any status). Only
       * the counts are taken from the overview; its `items` are unused here on
       * purpose, because rendering them would print the open incidents twice.
       */
      const [nextOverview, nextIncidents] = await Promise.all([
        getAiOpsOverview(),
        getOperationalIncidents(),
      ]);
      setOverview(nextOverview);
      setIncidents(incidentSort(nextIncidents.items));
    } catch (cause) {
      handleError(cause, "AI operations state could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [handleError, unlocked]);

  useEffect(() => { void refresh(); }, [refresh]);

  const workloads = overview?.runtime?.workloads ?? [];
  const executors = overview?.runtime?.executors ?? [];
  const pendingWork = workloads.reduce((total, workload) => total + workload.pendingCount, 0);
  const runningWork = workloads.reduce((total, workload) => total + workload.activeCount, 0);
  /*
   * The same rule the control plane applies to the overall badge: a fault is
   * anything not healthy, except an optional capability nobody configured.
   */
  const faultedComponents = (overview?.components ?? []).filter((component) =>
    component.status !== "HEALTHY" && (component.required || component.status !== "NOT_CONFIGURED"));
  const unconfiguredOptional = (overview?.components ?? []).filter((component) =>
    !component.required && component.status === "NOT_CONFIGURED").length;
  const sortedComponents = useMemo(() => [...(overview?.components ?? [])].sort((left, right) => {
    const weight = { UNAVAILABLE: 0, DEGRADED: 1, NOT_VERIFIED: 2, NOT_CONFIGURED: 3, HEALTHY: 4 } as const;
    return weight[left.status] - weight[right.status] || left.label.localeCompare(right.label);
  }), [overview]);

  const decideIncident = async (event: FormEvent) => {
    event.preventDefault();
    if (!incidentAction) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      /*
       * Omitted rather than sent empty when the field is blank. `owner` is
       * `min(1)` on a strict schema, so "" is a 400; and an incident nobody
       * owns is exactly the case where the server's default -- the operator
       * acting on it -- is the right answer.
       */
      const owner = decisionOwner.trim();
      await decideOperationalIncident(incidentAction.id, incidentAction.action, {
        note: decisionNote,
        ...(owner ? { owner } : {}),
      });
      setMessage(`Incident ${incidentAction.action === "resolve" ? "resolved" : "acknowledged"}.`);
      setIncidentAction(null); setDecisionNote(""); setDecisionOwner("");
      await refresh();
    } catch (cause) { handleError(cause, "The incident decision could not be recorded."); }
    finally { setBusy(false); }
  };

  const createIncident = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null); setMessage(null);
    try {
      await createOperationalIncident({
        title: String(data.get("title") ?? ""),
        severity: data.get("severity") === "CRITICAL" ? "CRITICAL" : "WARNING",
        component: String(data.get("component") ?? ""),
        summary: String(data.get("summary") ?? ""),
        owner: String(data.get("owner") ?? "").trim() || null,
      });
      setShowIncidentForm(false); setMessage("Operational incident created.");
      await refresh();
    } catch (cause) { handleError(cause, "The incident could not be created."); }
    finally { setBusy(false); }
  };


  if (!unlocked) {
    return (
      <LockedScreen
        kicker="AI operations"
        title="Operations"
        mark="OP"
        reason="Unlock the control plane to inspect protected operational telemetry and recovery controls."
        actionLabel="Open platform settings"
        onAction={onConfigure}
      />
    );
  }

  const metrics = overview?.metrics;
  const stale = snapshotIsStale(overview?.generatedAt);
  return (
    <div className="workspace-stack operations-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
      <WorkspaceIntro
        icon={<HeartPulse className="size-4" aria-hidden="true" />}
        title="Service health"
        actions={<>
          <StatusText
            dot
            tone={overview ? toneFor(overviewStatusTone(overview.status)) : "neutral"}
            className="h-9 items-center border border-border bg-surface px-3"
          >
            {overview ? humanLabel(overview.status) : "Loading"}
          </StatusText>
          <Button onClick={() => void refresh()} disabled={busy}><SyncIcon size={16} />{busy ? "Refreshing..." : "Refresh"}</Button>
        </>}
      />

      {/*
        * `empty:hidden`, because this is a flex child of a `gap-3` column and
        * it is empty whenever there is nothing to announce -- which is almost
        * always. A zero-height child still takes its gap, so this page sat 24px
        * under its header while every other workspace sits at 12. The element
        * itself has to stay mounted: a live region that appears only when it
        * already has content is not announced.
        */}
      <div className="shrink-0 empty:hidden" aria-live="polite">
        {error && <Alert>{error}</Alert>}
        {message && <Alert tone="good">{message}</Alert>}
      </div>

      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto">
        <HeroBanner
          tone="plain"
          aria-label="AI operations summary"
          /*
             A capability nobody configured is not a service needing attention.
             Counting every non-HEALTHY row put "4 of 5" over a fresh install
             whose only faults were two, and left the other two -- features the
             deployment had simply declined -- looking like outstanding work.
             They are still listed below, and still not called healthy.
           */
          highlight={{
            label: "Services needing attention",
            value: overview ? faultedComponents.length : "--",
            caption: unconfiguredOptional > 0
              ? `of ${overview?.components.length ?? 0} checked · ${unconfiguredOptional} not in use`
              : `of ${overview?.components.length ?? 0} checked`,
            icon: <Activity className="size-4" aria-hidden="true" />,
          }}
          metrics={[
            {
              label: "Open incidents",
              tone: overview?.incidents.critical ? "bad" : "neutral",
              value: overview?.incidents.open ?? "--",
              // An incident is often raised *about* a service above, so these
              // two figures can describe one event. Saying so beats leaving a
              // reader to count two problems where there is one.
              caption: `${overview?.incidents.critical ?? 0} critical · may describe a service above`,
              icon: <Flag className="size-4" aria-hidden="true" />,
            },
            {
              label: "Runs waiting to start",
              value: numberFormatter.format(pendingWork),
              /*
               * Both figures are "now". `failedWork` is a lifetime total, and
               * printing it here put an all-time number inside a caption whose
               * page is stamped with one snapshot time -- so a deployment that
               * failed twice a year ago read as failing during this window.
               * The lifetime figure belongs to the ledger, which scopes itself.
               */
              caption: `${runningWork} running now · ${overview?.components.length ?? 0} services checked`,
              icon: <Timer className="size-4" aria-hidden="true" />,
            },
            /*
              "Release evidence" used to be the fourth figure here. It is a
              release question, not a health one, and it now has a screen of
              its own — leaving it would have put the same count on two tabs
              and kept the word this restructure exists to remove.
            */
          ]}
        />

        {/*
          One column, not two. The right-hand column held an "Incident queue"
          panel listing the five most recent incidents — which, once the full
          ledger moved onto this same screen, printed the same incidents twice.
        */}
        <div className="grid items-start gap-4">
          <Panel>
            <PanelHeading
              kicker="Infrastructure"
              title="Services"
              /*
               * All three provenance words, because all three appear. The
               * sentence named "Live" and "Verified" while `source` is a
               * three-valued enum -- LIVE, LAST_VERIFIED, CONFIGURATION -- so
               * a row reading "Configuration" was a word the legend under it
               * did not admit existed, on the screen an operator reaches for
               * when they already distrust what they are seeing.
               */
              description="Everything OrcaSynapse depends on, worst first. “Live” was checked just now; “Verified” is the last connection test and may be old; “Configuration” means nothing was contacted — the row describes what is set up, not what answered."
              /*
               * Toned, not merely timestamped. Every figure on this screen
               * comes from this one snapshot, so when it is old the whole page
               * is describing the past — and it said so in the same muted grey
               * as a reading taken two seconds ago.
               */
              actions={<StatusText dot={stale} tone={stale ? "warn" : "neutral"}>
                {`Snapshot ${relativeTime(overview?.generatedAt ?? null)}${stale ? " — refresh" : ""}`}
              </StatusText>}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              {sortedComponents.map((component) => (
                <Tile as="article" className="grid gap-2" key={component.id}>
                  <div className="flex items-center gap-2.5">
                    <StatusText dot tone={toneFor(componentStatusTone(component.status))} />
                    <strong className="min-w-0 truncate text-label font-semibold text-text">{component.label}</strong>
                    <StatusText className="ml-auto shrink-0">{humanLabel(component.status)}</StatusText>
                  </div>
                  <p className="mb-0 text-caption leading-relaxed text-muted">{component.summary}</p>
                  <footer className="flex flex-wrap justify-between gap-2 font-mono text-micro text-faint">
                    <span>{component.source === "LAST_VERIFIED" ? `Verified ${relativeTime(component.observedAt)}` : humanLabel(component.source)}</span>
                    <span>{component.affectedWorkflows.length ? component.affectedWorkflows.map(humanLabel).join(" / ") : "Platform support"}</span>
                  </footer>
                </Tile>
              ))}
              {!overview && <p className="m-0 text-body text-faint">Loading component state...</p>}
            </div>
          </Panel>

        </div>

      <section className="grid gap-4">
        {/*
          The ledger's own heading sat on the canvas — ink, no edge — the same
          leftover-chrome problem WorkspaceDock exists to solve. The cards
          below are the work; this is the tool strip that names them.
        */}
        <WorkspaceDock>
          <PanelHeading
            className="mb-0"
            kicker="Needs a decision"
            title="Incidents"
            description="Raised automatically by OrcaSynapse or by an operator. These are the items on this screen that someone has to act on."
            actions={canOperate ? <Button onClick={() => setShowIncidentForm((shown) => !shown)}>{showIncidentForm ? "Cancel" : "Create incident"}</Button> : undefined}
          />
        </WorkspaceDock>
        {showIncidentForm && <form className="ops-form grid gap-3 rounded-card border border-border bg-surface p-5 shadow-card sm:grid-cols-2" onSubmit={(event) => void createIncident(event)}>
          <label><span>Title</span><Input name="title" minLength={3} maxLength={160} required /></label>
          <label><span>Severity</span><Select name="severity"><option value="WARNING">Warning</option><option value="CRITICAL">Critical</option></Select></label>
          <label><span>Component</span><Input name="component" minLength={1} maxLength={80} placeholder="e.g. hermes-vm2" required /></label>
          <label><span>Owner</span><Input name="owner" maxLength={160} placeholder="Optional team or operator" /></label>
          <label className="sm:col-span-2"><span>Summary</span><Textarea name="summary" minLength={3} maxLength={1000} rows={3} required /></label>
          <div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" disabled={busy}>Create incident</Button></div>
        </form>}
        {/*
          A record card in a ledger, not a paragraph with a coloured edge. The
          markup was already the right elements — article, header, time, dl —
          and carried no classes on any of them, so the badge, the provenance
          and the timestamp ran together on one line and the four facts stacked
          as an unstyled definition list. The reading order it now draws is the
          order an operator needs it in: how bad and who saw it, what happened,
          the facts, then what can be done about it.
        */}
        <div className="grid gap-3">{incidents.map((item) => <article className="grid gap-3.5 rounded-card border border-border bg-surface p-5 shadow-card" key={item.id}>
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Badge variant={item.severity === "CRITICAL" ? "destructive" : "warning"}>{humanLabel(item.severity)}</Badge>
            <StatusText>{item.automated ? "Automatic observation" : "Operator raised"}</StatusText>
            {/* Machine-readable as well as human-readable: "2h ago" is not a
                date, and the exact instant is what an operator correlates a log
                against. */}
            <time className="ml-auto shrink-0 font-mono text-micro text-faint" dateTime={item.detectedAt} title={item.detectedAt}>{relativeTime(item.detectedAt)}</time>
          </header>
          <div className="min-w-0">
            <h3 className="m-0 font-display text-[14px] font-semibold tracking-[-0.01em] text-text">{item.title}</h3>
            <p className="mb-0 mt-1 max-w-[76ch] text-body leading-relaxed text-muted">{item.summary}</p>
          </div>
          {/* Hairlines out of the 1px gap over a border-coloured backing — the
              same metadata run models and guardrails already draw, so
              no cell needs a border and none doubles against the card edge. */}
          <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-4">
            {[
              { label: "Status", value: humanLabel(item.status) },
              { label: "Component", value: item.component },
              { label: "Owner", value: item.owner ?? "Unassigned" },
              { label: "Last observed", value: relativeTime(item.lastObservedAt) },
            ].map((fact) => (
              <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
                <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
                <dd className="m-0 mt-1 truncate font-mono text-caption tabular-nums text-muted">{fact.value}</dd>
              </div>
            ))}
          </dl>
          {/* `resolutionNote` is written by acknowledge as well as resolve, so
              it is the operator's note rather than the resolution's. */}
          {item.resolutionNote && <blockquote className="m-0 rounded border border-border bg-raised p-3">
            <MicroLabel className="block">Operator note</MicroLabel>
            <span className="mt-1 block text-body leading-relaxed text-muted">{item.resolutionNote}</span>
          </blockquote>}
          {canOperate && item.status !== "RESOLVED" && <footer className="flex flex-wrap justify-end gap-2"><Button size="sm" onClick={() => { setIncidentAction({ id: item.id, action: "acknowledge" }); setDecisionNote(""); setDecisionOwner(item.owner ?? ""); }} disabled={item.status !== "OPEN"}>Acknowledge</Button><Button size="sm" onClick={() => { setIncidentAction({ id: item.id, action: "resolve" }); setDecisionNote(""); setDecisionOwner(item.owner ?? ""); }}>Resolve</Button></footer>}
          {/* Owner beside the note, carrying what the incident already says, so
              a handover is something an operator does on purpose and can see
              themselves doing. Blank means "assign it to me", which is what the
              server does with a decision that names nobody. */}
          {incidentAction?.id === item.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3 sm:grid-cols-2" onSubmit={(event) => void decideIncident(event)}><label className="sm:col-span-2"><span>Operator note</span><Textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} minLength={3} maxLength={1000} rows={2} required /></label><label className="sm:col-span-2"><span>Owner</span><Input value={decisionOwner} maxLength={160} placeholder="Leave blank to take this incident yourself" onChange={(event) => setDecisionOwner(event.target.value)} /></label><div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={() => setIncidentAction(null)}>Cancel</Button><Button type="submit" disabled={busy}>Record {incidentAction.action}</Button></div></form>}
        </article>)}{incidents.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">No operational incidents have been recorded.</p>}
          {incidents.length >= INCIDENT_WINDOW && (
            <MicroLabel className="block">
              The newest {INCIDENT_WINDOW} incidents are listed. The open count above is counted over every
              incident and can be larger than what is shown here.
            </MicroLabel>
          )}</div>
      </section>

        <Panel>
          <PanelHeading
            kicker="Throughput"
            title="Activity"
            description="What this deployment has done. The headline figures cover the last 24 hours; anything labelled “all time” counts every record still kept."
          />
          <MetricRow className="border-b-0 pb-0 lg:grid-cols-3">
            <Metric label="Chat responses / 24h" value={metrics?.chat?.responses ?? "--"} caption={`${percentage(metrics?.chat?.failureRate ?? null)} failed · ${metrics?.chat?.averageLatencyMs ?? "--"} ms average`} />
            <Metric label="Hermes runs in progress" value={metrics?.agents?.runningRuns ?? "--"} caption={`${metrics?.agents?.queuedRuns ?? 0} waiting · ${metrics?.agents?.failedRuns ?? 0} failed, all time`} />
            {/* "Agent tools" was the tab's name before it became Agents ->
                Tools, and it named the surface rather than the figure: the
                value is executing calls, like its two neighbours count
                responses and runs. */}
            <Metric label="Tool calls" value={metrics?.tools?.executingCalls ?? "--"} caption={`${metrics?.tools?.pendingApprovals ?? 0} awaiting review · ${metrics?.tools?.deniedCalls ?? 0} denied`} />
          </MetricRow>
        </Panel>

        <Panel>
          <PanelHeading
            kicker="Queues and workers"
            title="Background work"
            description={overview?.runtime
              ? `Queued and running agent work, and the workers processing it. Read ${relativeTime(overview.runtime.capturedAt)}.`
              : "No worker has reported, so there is nothing to say about queued work."}
            actions={<Button size="sm" onClick={() => void refresh()} disabled={busy}><SyncIcon size={14} />Refresh state</Button>}
          />
          <div className="overflow-hidden rounded border border-border">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow className="bg-raised hover:bg-raised">
                  {["Workload", "Waiting", "Running", "Failed", "All time"].map((head) => (
                    <TableHead className="tabular-nums" scope="col" key={head}>{head}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>{workloads.map((workload) => <TableRow key={workload.name}>
                <TableCell className="font-normal">
                  <strong className="block text-caption font-semibold text-text">{workload.displayName}</strong>
                  <span className="block font-mono text-micro text-faint">{workload.name}</span>
                </TableCell>
                <TableCell className="font-mono text-caption tabular-nums text-muted">{workload.pendingCount}</TableCell>
                <TableCell className="font-mono text-caption tabular-nums text-muted">{workload.activeCount}</TableCell>
                <TableCell className={cn("font-mono text-caption tabular-nums", workload.failedCount ? "text-bad" : "text-muted")}>{workload.failedCount}</TableCell>
                <TableCell className="font-mono text-caption tabular-nums text-muted">{workload.totalCount}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>
          <div className="mt-3 grid gap-1.5">
            {executors.map((executor) => <Tile as="article" pad="sm" className="flex flex-wrap items-center justify-between gap-3" key={executor.id}>
              <div className="flex min-w-0 items-center gap-2.5">
                <StatusText dot tone={toneFor(executorStatusTone(executor.status))} />
                <div className="min-w-0">
                  <strong className="block truncate text-caption font-semibold text-text">{executor.name}</strong>
                  <small className="block font-mono text-micro text-faint">
                    {executor.workloads.length === 1 ? "1 workload" : `${executor.workloads.length} workloads`} · version {executor.version}
                  </small>
                </div>
              </div>
              <div className="text-right">
                <StatusText tone={toneFor(executorStatusTone(executor.status))}>{humanLabel(executor.status)}</StatusText>
                <span className="mt-0.5 block font-mono text-micro text-faint">{relativeTime(executor.lastSeenAt)}</span>
              </div>
            </Tile>)}
            {executors.length === 0 && (
              <EmptyState title="No executor heartbeat">No runtime executor heartbeat has been recorded.</EmptyState>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeading
            kicker="Policy"
            title="Guardrails"
            description="Which protections are switched on, and the policy version each one is running."
          />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{overview?.guardrails.map((control) => <Tile as="article" className="grid gap-1.5" key={control.layer}>
            <header className="flex items-center justify-between gap-3">
              <MicroLabel>{humanLabel(control.layer)}</MicroLabel>
              <StatusText dot tone={toneFor(guardrailStatusTone(control.status))}>{humanLabel(control.status)}</StatusText>
            </header>
            <h3 className="m-0 font-display text-label font-semibold text-text">{control.label}</h3>
            <p className="mb-0 text-caption leading-relaxed text-muted">{control.summary}</p>
            <small className="font-mono text-micro text-faint">{control.evidence}</small>
          </Tile>)}</div>
        </Panel>
      </div>
    </div>
  );
}
