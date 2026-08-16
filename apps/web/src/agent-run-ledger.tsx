import type { AgentMetrics, AgentRun, AgentRunEvent, AgentRuntimeControl } from "@orcasynapse/contracts";
import { useState } from "react";
import { failedStatuses, runningStatuses, statusTone } from "./agent-status.js";
import { groupRuntimeEvents } from "./chat/timeline.js";
import {
  Button, EmptyState, Field, Input, Metric, MetricRow, MicroLabel,
  Panel, PanelHeading, StatusText, Tile, cn, toneFor,
} from "./ui/index.js";

/**
 * The execution half of Profiles: whether Hermes may run, and what it has run.
 *
 * These three blocks were briefly a tab of their own called Runtime, which put
 * the answer to "is this agent working" on a different screen from the thing
 * that defines it. They are components rather than a route now, and deliberately
 * presentational: `agents-view.tsx` owns every piece of state they draw, because
 * the profile selected in its list is what scopes the ledger, and a second
 * component fetching runs on its own is how those two would drift apart.
 */

function friendlyTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function eventTitle(event: AgentRunEvent): string {
  return event.type.replaceAll("_", " ").toLowerCase().replace(/^./, (first) => first.toUpperCase());
}

function eventDetail(event: AgentRunEvent): string {
  if (event.summary) return event.summary;
  if (event.toolName) return `Governed tool: ${event.toolName}`;
  if (event.childSessionId) return `Temporary child session ${event.childSessionId}`;
  if (event.status) return `Hermes status: ${event.status}`;
  return "Hermes emitted a bounded lifecycle event.";
}

function runLabel(status: AgentRun["status"]): string {
  return status.replaceAll("_", " ").toLowerCase();
}

interface ExecutionBoundaryProps {
  runtime: AgentRuntimeControl | null;
  /** Deployment-wide totals. The run list is a bounded window; these are not. */
  metrics: AgentMetrics | null;
  runs: readonly AgentRun[];
  busy: string | null;
  onToggle: (enabled: boolean, reason: string, memoryExtractionEnabled?: boolean) => void;
  /** Decides which of the two fixes the disabled state names. */
  hasProfiles: boolean;
  /** `agents:control`: whether this session may throw the switch at all. */
  canControl: boolean;
  /** `agents:manage`: whether Verify & activate and Create exist on their screen. */
  canManage: boolean;
}

/**
 * The kill switch, and the four figures describing what it is permitting.
 *
 * It sits at the top of Profiles rather than at the end of the operator's
 * sequence, even though "may this run at all" is logically the last question.
 * The boundary is a precondition, not a conclusion: nothing in the list below
 * can run while it is off, and an operator reaching for it is already dealing
 * with a problem and should not have to scroll an immutable configuration list
 * to find it.
 *
 * The counters live here, and only here, for the same reason. They are
 * deployment-wide -- `AgentMetrics` reports no per-profile breakdown and the
 * run list is capped at the 200 most recent, so a per-profile total would be a
 * window count wearing a lifetime label. A screen-wide figure belongs to the
 * screen-wide control, where it reads as the boundary's own record rather than
 * as a statistic about whichever profile happens to be selected.
 */
export function ExecutionBoundary({ runtime, metrics, runs, busy, onToggle, hasProfiles, canControl, canManage }: ExecutionBoundaryProps) {
  const [reason, setReason] = useState("Runtime and Profile Distribution boundaries verified by the platform administrator.");
  const enabled = runtime?.enabled === true;
  const extracting = runtime?.memoryExtractionEnabled !== false;

  /*
   * The sentence names a fix the reader can actually reach. Without
   * `agents:manage` there is no Verify & activate and no Create anywhere on
   * their screen, so either wording would be an instruction to press something
   * that is not there -- which is the whole failure mode the cross-tab "Open
   * Profiles" button had, moved inside one screen.
   */
  const disabledFix = canManage
    ? hasProfiles
      ? "Use Verify & activate on a Profile below; OrcaSynapse will test Hermes and enable this boundary automatically."
      : "Create a Profile below; OrcaSynapse will test Hermes and enable this boundary automatically."
    : canControl
      ? "Enable it under Manual control below, or ask an administrator who can manage Profiles to verify one."
      : "An administrator who can manage Profiles must verify and activate one before anything here can run.";

  const totals = [
    {
      label: "Completed",
      value: metrics?.completedRuns ?? runs.filter(({ status }) => status === "COMPLETED").length,
      caption: "retained with their lifecycle",
    },
    {
      label: "Queued",
      value: metrics?.queuedRuns ?? runs.filter(({ status }) => status === "QUEUED").length,
      caption: "awaiting worker",
    },
    {
      label: "Running",
      tone: "accent" as const,
      value: metrics?.runningRuns ?? runs.filter(({ status }) => runningStatuses.has(status)).length,
      caption: "live or stopping",
    },
    {
      label: "Failed",
      value: metrics?.failedRuns ?? runs.filter(({ status }) => failedStatuses.has(status)).length,
      caption: "failed, timed out or denied",
    },
  ];

  return (
    <Panel
      aria-label="Hermes execution boundary"
      className={cn("grid gap-4 border-l-2", enabled ? "border-l-good" : "border-l-border-strong")}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-4">
        {/* ON/OFF is stated as a word rather than a colour alone, because this
            is the control an operator reaches for when something is already
            going wrong. */}
        <div className={cn(
          "grid h-11 w-11 place-items-center rounded border font-mono text-caption font-bold",
          enabled ? "border-good/50 bg-good/10 text-good" : "border-border-strong bg-raised text-muted",
        )}>
          {enabled ? "ON" : "OFF"}
        </div>
        <div className="min-w-0">
          <MicroLabel className="block">Hermes execution</MicroLabel>
          <strong className="mt-1.5 block text-label font-semibold text-text">
            {enabled ? "Ready for Chat" : "Activates with the first verified Profile"}
          </strong>
          {/*
            * The sentence names the fix, and while this was its own tab the fix
            * was a screen away -- which is how a split strands someone, and why
            * Runtime carried an "Open Profiles" button. Both fixes are now a few
            * centimetres below, so the sentence points at them and carries no
            * control of its own: the header, the empty state and the profile row
            * already offer all three, and a fourth identical button would be
            * four calls to action for one job.
            */}
          <p className="mb-0 mt-1 text-body text-muted">
            {enabled ? runtime?.reason : disabledFix}
          </p>
          {/*
            * `PATCH /admin/agents/runtime` wants `agents:control`, which
            * AUDITOR does not hold. The state above is an `agents:read` fact
            * and stays; the control is withheld rather than left to 403.
            */}
          {canControl && <details className="mt-3">
            <summary className="cursor-pointer text-micro font-semibold uppercase tabular-nums text-faint">Manual control</summary>
            <form
              className="mt-2.5 flex flex-wrap items-end gap-2.5"
              onSubmit={(event) => { event.preventDefault(); if (reason.trim().length >= 3) onToggle(!enabled, reason.trim()); }}
            >
              <Field label="Audit reason" htmlFor="runtime-reason" className="min-w-[220px] flex-1">
                <Input id="runtime-reason" value={reason} minLength={3} maxLength={500} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <Button
                variant={enabled ? "danger" : "secondary"}
                disabled={busy !== null || reason.trim().length < 3}
                type="submit"
              >
                {busy === "runtime" ? "Applying..." : enabled ? "Disable execution" : "Enable manually"}
              </Button>
              {/*
                * A separate button, not a second meaning for the one beside it.
                * Stopping execution stops agents answering; stopping extraction
                * costs a model call per completed run and changes nothing a
                * person sees. Collapsing them would make the cheap decision
                * carry the expensive one's consequences.
                */}
              <Button
                variant="secondary"
                disabled={busy !== null || reason.trim().length < 3}
                onClick={() => onToggle(enabled, reason.trim(), !extracting)}
              >
                {extracting ? "Stop learning from runs" : "Learn from runs"}
              </Button>
            </form>
            <p className="mb-0 mt-2 text-caption text-muted">
              {extracting
                ? "Each completed run is read once for durable facts, kept against that run's division."
                : "Completed runs are not being read. Notes already kept are still given to the agents that own them."}
            </p>
          </details>}
        </div>
      </div>

      {/*
        * Four zeroes on a fresh install would be decoration, and this screen
        * ships with none: the deployment the design was checked against has one
        * Profile and no runs at all. A sentence says the same thing honestly and
        * says where the first figure will come from.
        */}
      {totals.some(({ value }) => value > 0)
        ? <MetricRow className="border-b-0 border-t pb-0 pt-4 lg:grid-cols-4" aria-label="Hermes run summary">
          {totals.map((total) => <Metric key={total.label} {...total} />)}
        </MetricRow>
        : <p className="m-0 border-t border-border pt-4 text-body text-muted">
          No runs yet. Every run a Profile below produces is counted here, whether it was started from Session or by a governed caller.
        </p>}
    </Panel>
  );
}

interface RunLedgerProps {
  /** Already scoped by the caller; `total` is the full window it came from. */
  runs: readonly AgentRun[];
  total: number;
  profileName: string | null;
  scoped: boolean;
  /**
   * Whether this ledger is the deployment's or the reader's own.
   *
   * `GET /admin/agents/runs` returns every run in the window; `GET /agents/runs`
   * filters to the calling subject. Both render this component with the same
   * shape, so nothing but the copy can tell the two apart.
   */
  administrator: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onScopeChange: (scoped: boolean) => void;
}

/**
 * Recent runs, scoped by default to the Profile selected in the list above.
 *
 * A flat ledger under an unrelated profile list is the weakest way to put these
 * two things on one screen: runs are produced *by* profiles, and the selection
 * in the list is what says which. That selection had no job at all before this
 * -- it tinted a row and nothing more.
 *
 * The escape hatch is not a permanent toggle. A non-administrator's profile list
 * holds only ACTIVE profiles while their run list holds everything they ever
 * started, so runs from a since-suspended Profile would otherwise be
 * unreachable. It appears only when scoping is actually hiding something, which
 * on a single-profile deployment is never.
 */
export function RunLedger({ runs, total, profileName, scoped, administrator, selectedRunId, onSelectRun, onScopeChange }: RunLedgerProps) {
  const hidden = total - runs.length;
  /* Truthiness, not `!== null`: the four sentences below name the Profile, and
     an empty name would put "Produced by , newest first." on the panel. */
  const named = scoped && Boolean(profileName);

  /*
   * Every sentence here describes the same list, so they agree on whose it is.
   *
   * The API filters a non-administrator's runs to their own subject against a
   * Profile that belongs to the whole deployment, so "Across every Profile" and
   * "Nothing has run under X" are claims about the deployment made from one
   * person's window -- the second is not even a hedge, it is false the moment a
   * colleague has used the Profile. Written out in full rather than assembled
   * from fragments: this is the copy, and it should read as copy.
   */
  const description = administrator
    ? named
      ? `Produced by ${profileName}, newest first.`
      : "Across every Profile, newest first."
    : named
      ? `Your runs produced by ${profileName}, newest first.`
      : "Your runs across every Profile, newest first.";

  const emptyTitle = administrator
    ? named ? `Nothing has run under ${profileName}` : "No runs yet"
    : named ? `You have not run ${profileName}` : "You have no runs yet";

  const emptyBody = administrator
    ? named
      ? "Runs appear here with their complete lifecycle as soon as this Profile is used."
      : "Queued work will appear here with its complete lifecycle."
    : named
      ? `Runs appear here with their complete lifecycle as soon as you use ${profileName}. Runs your colleagues started against it are not shown.`
      : "Work you queue will appear here with its complete lifecycle. Runs your colleagues started are not shown.";

  return (
    <Panel aria-label="Execution ledger">
      <PanelHeading
        kicker="Execution ledger"
        title="Recent runs"
        description={description}
        actions={<StatusText>{runs.length} shown</StatusText>}
      />
      <div className="grid max-h-[520px] gap-1 overflow-y-auto">
        {runs.length === 0 && <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>}
        {/*
          * `size="auto"` because a run row is four stacked lines, and every
          * other size is a fixed 28-44px single-line control. Runtime shipped
          * these at the default `h-9`, which drew each row's status, subject and
          * timestamp on top of one another -- invisible to jsdom, and the first
          * thing anyone sees on a deployment that has actually run something.
          */}
        {runs.map((run) => <Button
          variant="ghost"
          size="auto"
          className={cn(
            // `grid-cols-1` rather than an implicit column: the Button base sets
            // `justify-center`, which centred each row's track on its own widest
            // line, so a short input sat visibly further right than a long one.
            "grid w-full grid-cols-1 gap-1 rounded border p-2.5 text-left transition-colors",
            selectedRunId === run.id ? "border-border-strong bg-raised" : "border-transparent hover:bg-raised",
          )}
          key={run.id}
          onClick={() => onSelectRun(run.id)}
        >
          <StatusText dot tone={toneFor(statusTone(run.status))}>{runLabel(run.status)}</StatusText>
          {/* The profile name leads only where the ledger is not already titled
              with it; scoped, the row's own subject is what was asked. */}
          <strong className="truncate text-label font-semibold text-text">
            {scoped ? run.input : run.profileName}
          </strong>
          {!scoped && <p className="mb-0 line-clamp-2 text-caption text-muted">{run.input}</p>}
          <small className="font-mono text-micro text-faint">v{run.profileVersion} · {friendlyTime(run.createdAt)}</small>
        </Button>)}
      </div>
      {scoped && hidden > 0 && (
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => onScopeChange(false)}>
          Show all runs ({total})
        </Button>
      )}
      {!scoped && profileName && (
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => onScopeChange(true)}>
          Show only {profileName}
        </Button>
      )}
    </Panel>
  );
}

interface RunDetailProps {
  run: AgentRun | null;
  events: readonly AgentRunEvent[];
  busy: string | null;
  /**
   * Whether cancelling is this session's to do.
   *
   * The admin route wants `agents:control`; the enterprise route authorises the
   * caller against their own run instead, so this is a scope question only for
   * an administrator. Reading a run is `agents:read` either way, which is why
   * it gates the one button rather than the pane.
   */
  canCancel: boolean;
  onCancel: (run: AgentRun) => void;
}

/** One run: its lifecycle, its bounded activity timeline, and what it produced. */
export function RunDetail({ run, events, busy, canCancel, onCancel }: RunDetailProps) {
  if (!run) {
    return (
      <Panel aria-label="Run detail">
        <EmptyState title="Select a run">Input, output, events, and failure information remain in the OrcaSynapse execution ledger.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel aria-label="Run detail">
      <PanelHeading
        kicker="Run detail"
        title={run.profileName}
        description={`${run.profileSlug} · version ${run.profileVersion}`}
        actions={<StatusText dot tone={toneFor(statusTone(run.status))}>{runLabel(run.status)}</StatusText>}
      />
      <dl className="m-0 grid grid-cols-3 gap-px rounded border border-border bg-border">
        {[
          { label: "Queued", value: friendlyTime(run.queuedAt) },
          { label: "Started", value: friendlyTime(run.startedAt) },
          { label: "Completed", value: friendlyTime(run.completedAt) },
        ].map((fact) => (
          <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
            <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
            <dd className="m-0 mt-1 truncate font-mono text-caption text-muted">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <Tile className="mt-3">
        <MicroLabel className="block">Profile Distribution</MicroLabel>
        <code className="mt-1.5 block break-all font-mono text-micro text-muted">
          {run.profileDistributionDigest ?? "Legacy run — no distribution digest"}
        </code>
      </Tile>
      <section className="mt-3 overflow-hidden rounded border border-border" aria-label="Safe Hermes activity timeline">
        <header className="flex items-center justify-between border-b border-border bg-raised px-3 py-2">
          <MicroLabel>Activity timeline</MicroLabel>
          <StatusText>{events.length} safe event{events.length === 1 ? "" : "s"}</StatusText>
        </header>
        {events.length === 0
          ? <p className="m-0 px-3 py-4 text-body text-faint">No bounded Hermes activity events have been retained for this run.</p>
          /*
            * Grouped by tool call, sharing the function chat uses. Two surfaces
            * read one table, so they had better agree on what a tool call is --
            * this one listed every event separately until `toolCallKey` reached
            * the agents contract.
            */
          : <ol className="m-0 grid list-none p-0">{groupRuntimeEvents(events).map((entry) => {
            const event = entry.events[entry.events.length - 1]!;
            return <li
              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 border-t border-border px-3 py-2.5 first:border-t-0"
              key={entry.key}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0",
                  entry.status === "failed" ? "bg-bad" : entry.status === "completed" ? "bg-good" : "bg-accent",
                )}
              />
              <div className="min-w-0">
                <strong className="block text-caption font-semibold text-text">
                  {entry.kind === "tool" ? `Governed tool: ${entry.label}` : eventTitle(event)}
                  {entry.events.length > 1 ? ` · ${entry.events.length} steps` : ""}
                </strong>
                <p className="mb-0 mt-0.5 text-caption leading-relaxed text-muted">{eventDetail(event)}</p>
                <small className="mt-1 block font-mono text-micro text-faint">
                  {friendlyTime(event.occurredAt)}
                  {entry.durationMs !== null ? ` · ${Math.round(entry.durationMs / 100) / 10}s` : ""}
                  {event.inputTokens !== null || event.outputTokens !== null ? ` · ${(event.inputTokens ?? 0) + (event.outputTokens ?? 0)} tokens` : ""}
                </small>
              </div>
            </li>;
          })}</ol>}
        {/* The list is bounded on purpose, and says so: an operator reading it
            should not assume the omissions are absences. */}
        <footer className="border-t border-border bg-bg px-3 py-2 text-micro leading-relaxed text-faint">
          Token deltas, chain-of-thought, hidden prompts, credentials, tool arguments, and tool results are never
          retained here.
        </footer>
      </section>
      {[
        { label: "Input", body: run.input, tone: "" },
        ...(run.output ? [{ label: "Hermes output", body: run.output, tone: "border-l-2 border-l-accent" }] : []),
      ].map((block) => (
        <Tile className={cn("mt-3", block.tone)} key={block.label}>
          <MicroLabel className="block">{block.label}</MicroLabel>
          <p className="mb-0 mt-1.5 whitespace-pre-wrap break-words text-body leading-relaxed text-text">{block.body}</p>
        </Tile>
      ))}
      {run.failureMessage && <div className="mt-3 rounded border border-bad/40 bg-bad/10 p-3">
        <strong className="block text-micro font-semibold uppercase tabular-nums text-bad">{run.failureCode}</strong>
        <p className="mb-0 mt-1.5 text-body leading-relaxed text-muted">{run.failureMessage}</p>
      </div>}
      {canCancel && runningStatuses.has(run.status) && <Button
        variant="danger"
        className="mt-3"
        disabled={busy !== null || run.status === "CANCEL_REQUESTED"}
        onClick={() => onCancel(run)}
      >
        {run.status === "CANCEL_REQUESTED" ? "Cancellation requested" : "Cancel run"}
      </Button>}
    </Panel>
  );
}
