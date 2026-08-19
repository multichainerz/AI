import type { AgentMetrics, AgentRun, AgentRunEvent, AgentRuntimeControl } from "@orcasynapse/contracts";
import { Switch } from "@/components/ui/switch";
import { failedStatuses, runningStatuses, statusTone } from "./agent-status.js";
import { groupRuntimeEvents } from "./chat/timeline.js";
import {
  Button, EmptyState, Metric, MetricRow, MicroLabel,
  Panel, PanelHeading, StatusText, Tile, cn, toneFor,
} from "./ui/index.js";

const EXECUTION_REASON = "Runtime and Profile Distribution boundaries verified by the platform administrator.";

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
  /** `agents:control`: whether this session may throw the switch at all. */
  canControl: boolean;
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
export function ExecutionBoundary({ runtime, metrics, runs, busy, onToggle, canControl }: ExecutionBoundaryProps) {
  const enabled = runtime?.enabled === true;
  const extracting = runtime?.memoryExtractionEnabled !== false;

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
    <section aria-label="Hermes execution boundary" className="grid shrink-0 gap-3">
      <div className="flex items-center justify-between gap-6">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
          {/* ON/OFF is stated as a word rather than a colour alone, because this
              is the control an operator reaches for when something is already
              going wrong. */}
          <div className={cn(
            "grid h-9 w-9 place-items-center rounded border font-mono text-micro font-bold",
            enabled ? "border-good/50 bg-good/10 text-good" : "border-border-strong bg-raised text-muted",
          )}>
            {enabled ? "ON" : "OFF"}
          </div>
          <div className="min-w-0">
            <MicroLabel className="block">Hermes execution</MicroLabel>
            <strong className="mt-0.5 block text-label font-semibold text-text">
              {enabled ? "Ready for Chat" : "Activates with the first verified Profile"}
            </strong>
          </div>
        </div>
        {/*
          * `PATCH /admin/agents/runtime` wants `agents:control`, which
          * AUDITOR does not hold. The state above is an `agents:read` fact
          * and stays; the control is withheld rather than left to 403.
          */}
        {canControl ? (
          <div className="flex shrink-0 flex-col items-end gap-2.5">
            <label className="flex items-center gap-2.5">
              <span className="text-caption text-muted">{enabled ? "Allowed" : "Off"}</span>
              <Switch
                aria-label={enabled ? "Disable execution" : "Enable execution"}
                checked={enabled}
                disabled={busy !== null}
                onCheckedChange={(next) => onToggle(next, EXECUTION_REASON)}
              />
            </label>
            {/*
              * A separate switch, not a second meaning for the one above.
              * Stopping execution stops agents answering; stopping extraction
              * costs a model call per completed run and changes nothing a
              * person sees. Collapsing them would make the cheap decision
              * carry the expensive one's consequences.
              */}
            <label className="flex items-center gap-2.5">
              <span className="text-caption text-muted">Learn from runs</span>
              <Switch
                aria-label={extracting ? "Stop learning from runs" : "Learn from runs"}
                checked={extracting}
                disabled={busy !== null}
                onCheckedChange={(next) => onToggle(enabled, EXECUTION_REASON, next)}
              />
            </label>
          </div>
        ) : null}
      </div>

      {/*
        * Four zeroes on a fresh install would be decoration, and this screen
        * ships with none: the deployment the design was checked against has one
        * Profile and no runs at all. The ledger beside this strip already says
        * nothing has run, so an empty boundary stays a title and the switches.
        */}
      {totals.some(({ value }) => value > 0) ? (
        <MetricRow className="border-b-0 border-t pb-0 pt-3 lg:grid-cols-4" aria-label="Hermes run summary">
          {totals.map((total) => <Metric key={total.label} {...total} />)}
        </MetricRow>
      ) : null}
    </section>
  );
}

/**
 * How many runs either run endpoint will ever return.
 *
 * `DrizzleAgentManager.listRuns` is a bare `limit: 200` ordered by `createdAt`
 * descending, and `AgentRunList` carries no total, so a full array means "at
 * least 200 exist" and nothing more. Every sentence below that would otherwise
 * describe the deployment has to stop at the edge of that window instead.
 */
const RUN_WINDOW = 200;

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
 * Recent runs, scoped by default to the Profile selected in the list beside it.
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
   *
   * The second axis is the window, and it is the same failure in a different
   * direction. `total` is the size of the array the endpoint returned, capped
   * at `RUN_WINDOW`; when it is full, the loaded runs are the newest 200 across
   * every Profile, and scoping them to one Profile says nothing whatever about
   * a Profile whose runs are all older than that. "Nothing has run under X" is
   * then false for the very deployment that most needs the ledger -- a busy one
   * -- so the windowed sentences describe the window and let it be widened
   * rather than asserting over the far side of it.
   */
  const windowed = total >= RUN_WINDOW;

  const description = windowed
    ? administrator
      ? named
        ? `Produced by ${profileName}, within the newest ${RUN_WINDOW} runs.`
        : `The newest ${RUN_WINDOW} runs, across every Profile.`
      : named
        ? `Your runs produced by ${profileName}, within the newest ${RUN_WINDOW} loaded.`
        : `The newest ${RUN_WINDOW} of your runs, across every Profile.`
    : administrator
      ? named
        ? `Produced by ${profileName}, newest first.`
        : "Across every Profile, newest first."
      : named
        ? `Your runs produced by ${profileName}, newest first.`
        : "Your runs across every Profile, newest first.";

  /*
   * Only the scoped-and-named case can be empty while the window is full, so
   * that is the only title with a windowed form: an unscoped ledger holding 200
   * runs is not empty, and neither is a scoped one below the cap.
   */
  const emptyTitle = administrator
    ? named
      ? windowed ? `Nothing by ${profileName} in the newest ${RUN_WINDOW} runs` : `Nothing has run under ${profileName}`
      : "No runs yet"
    : named
      ? windowed ? `None of your newest ${RUN_WINDOW} runs used ${profileName}` : `You have not run ${profileName}`
      : "You have no runs yet";

  /* `windowed && named`, matching the title above: the name is interpolated,
     and the unnamed branch is unreachable while the window is full anyway. */
  const emptyBody = windowed && named
    ? `This ledger holds the newest ${RUN_WINDOW} runs across every Profile, so older ones by ${profileName} are not loaded and are not counted here.`
    : administrator
      ? named
        ? "Runs appear here with their complete lifecycle as soon as this Profile is used."
        : "Queued work will appear here with its complete lifecycle."
      : named
        ? `Runs appear here with their complete lifecycle as soon as you use ${profileName}. Runs your colleagues started against it are not shown.`
        : "Work you queue will appear here with its complete lifecycle. Runs your colleagues started are not shown.";

  return (
    <Panel aria-label="Execution ledger" className="flex min-h-0 flex-col overflow-hidden p-3">
      <PanelHeading
        className="mb-2 shrink-0"
        kicker="Execution ledger"
        title="Recent runs"
        description={description}
        actions={<StatusText>{runs.length} shown</StatusText>}
      />
      <div className="grid min-h-0 flex-1 content-start gap-1 overflow-y-auto">
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
        /* The count only when it is a count. At the cap it is the window size,
           and "Show all runs (200)" reads as a deployment total on precisely
           the deployments where it is furthest from one. */
        <Button variant="ghost" size="sm" className="mt-2 shrink-0" onClick={() => onScopeChange(false)}>
          {windowed ? `Show the newest ${RUN_WINDOW} runs` : `Show all runs (${total})`}
        </Button>
      )}
      {!scoped && profileName && (
        <Button variant="ghost" size="sm" className="mt-2 shrink-0" onClick={() => onScopeChange(true)}>
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
      <Panel aria-label="Run detail" className="flex min-h-0 flex-col overflow-hidden p-3">
        <EmptyState className="m-auto w-full max-w-[36ch] px-3 py-5" title="Select a run">Input, output, events, and failure information remain in the OrcaSynapse execution ledger.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel aria-label="Run detail" className="flex min-h-0 flex-col overflow-hidden p-3">
      <PanelHeading
        className="mb-2 shrink-0"
        kicker="Run detail"
        title={run.profileName}
        description={`${run.profileSlug} · version ${run.profileVersion}`}
        actions={<StatusText dot tone={toneFor(statusTone(run.status))}>{runLabel(run.status)}</StatusText>}
      />
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto">
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
      <Tile>
        <MicroLabel className="block">Profile Distribution</MicroLabel>
        <code className="mt-1.5 block break-all font-mono text-micro text-muted">
          {run.profileDistributionDigest ?? "Legacy run — no distribution digest"}
        </code>
      </Tile>
      <section className="overflow-hidden rounded border border-border" aria-label="Safe Hermes activity timeline">
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
        {/*
          * This claimed that tool arguments and tool results were "never
          * retained here". Arguments are: Hermes reports the call it is about
          * to make on the TOOL_STARTED event, the projection stores that string
          * in `preview` and `summary`, and `eventDetail` above prints it. On a
          * live run every TOOL_STARTED carried one, and for `execute_code` the
          * string is the Python being executed -- so this footer was denying a
          * guarantee-shaped thing directly underneath the evidence against it.
          *
          * Replaced with what is true, including the part an operator can act
          * on: nothing between Hermes and this table strips a secret that a run
          * writes into its own code. Results and reasoning are conditional --
          * the projection retains `result` and `reasoning` when the runtime
          * sends them, and this deployment's runtime currently sends neither --
          * so they are stated as a capability, not as a promise either way.
          * The bounded-list note is kept; it was the one accurate half.
          */}
        <footer className="border-t border-border bg-bg px-3 py-2 text-micro leading-relaxed text-faint">
          Hermes reports each call before it runs, and that text is retained and shown here — for executed code it is
          the source itself. Nothing strips a credential a run writes into its own code. Tool results and reasoning are
          retained when the runtime sends them. This list is bounded, so an omission is not an absence.
        </footer>
      </section>
      {[
        { label: "Input", body: run.input },
        ...(run.output ? [{ label: "Hermes output", body: run.output }] : []),
      ].map((block) => (
        <Tile key={block.label}>
          <MicroLabel className="block">{block.label}</MicroLabel>
          <p className="mb-0 mt-1.5 whitespace-pre-wrap break-words text-body leading-relaxed text-text">{block.body}</p>
        </Tile>
      ))}
      {run.failureMessage && <div className="rounded border border-bad/40 bg-bad/10 p-3">
        <strong className="block text-micro font-semibold uppercase tabular-nums text-bad">{run.failureCode}</strong>
        <p className="mb-0 mt-1.5 text-body leading-relaxed text-muted">{run.failureMessage}</p>
      </div>}
      </div>
      {canCancel && runningStatuses.has(run.status) && <Button
        variant="danger"
        className="mt-2 shrink-0"
        disabled={busy !== null || run.status === "CANCEL_REQUESTED"}
        onClick={() => onCancel(run)}
      >
        {run.status === "CANCEL_REQUESTED" ? "Cancellation requested" : "Cancel run"}
      </Button>}
    </Panel>
  );
}
