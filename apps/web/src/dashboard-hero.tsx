import type {
  AgentMetrics,
  AgentRun,
  ChatMetrics,
  ConnectionMonitoringControl,
  HermesRuntimeNode,
  OperationalIncident,
  ToolMetrics,
  UsageBucket,
  UsageReport,
  UsageWindow,
} from "@orcasynapse/contracts";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, MessageSquareText as TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { HomeLayer, HomeReadinessCheck } from "./home-view.js";
import type { SetupStepKey } from "./setup-steps.js";
import type { ActiveView } from "./workspace-navigation.js";

/**
 * The Dashboard's command panel.
 *
 * Four questions, in the order an operator actually asks them: is anything
 * waiting on me (Needs attention), what is happening right now (the live strip
 * and Recent sessions), is usage normal (Activity), and is the machinery sound
 * (System). Bring-up is not a separate mode — an unready capability is simply
 * an attention item, so the same screen carries a deployment from first boot
 * to steady operation without changing shape.
 *
 * It draws only what the runtime reports, in the workspace's own palette:
 * violet stays an accent, and the failed slice is the one red thing on the
 * screen when something is wrong.
 */

interface DashboardHeroProps {
  unlocked: boolean;
  apiAvailable: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  onAsk: () => void;
  onUnlock: () => void;
  healthyConnections: number;
  chatMetrics: ChatMetrics | null;
  agentMetrics: AgentMetrics | null;
  toolMetrics: ToolMetrics | null;
  monitoring: ConnectionMonitoringControl | null;
  runtimeNodes: HermesRuntimeNode[];
  layers: HomeLayer[];
  readiness: HomeReadinessCheck[];
  usage: UsageReport | null;
  period: UsageWindow;
  onPeriod: (period: UsageWindow) => void;
  runs: AgentRun[] | null;
  incidents: OperationalIncident[] | null;
  onSelect: (view: ActiveView, setupStep?: SetupStepKey) => void;
}

/** A figure the deployment has not produced yet is absent, never zero. */
function count(value: number | null | undefined, unlocked: boolean): string {
  if (!unlocked || value === null || value === undefined) return "—";
  return value.toLocaleString();
}

/**
 * Token totals in the width a KPI column actually has.
 *
 * These run to seven figures on a deployment that has been used for a week,
 * and `toLocaleString` puts "1,284,930" in a cell sized for four glyphs. The
 * threshold is 10,000 rather than 1,000 so the common early figure stays exact.
 */
function compact(value: number | null | undefined, unlocked: boolean): string {
  if (!unlocked || value === null || value === undefined) return "—";
  if (value < 10_000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** A share of a whole, or nothing at all when the whole is zero. */
function share(part: number | undefined, whole: number | undefined): number | undefined {
  if (part === undefined || whole === undefined || whole <= 0) return undefined;
  return part / whole;
}

/**
 * The moment a usage window opened, said in words.
 *
 * With the clock time, not only the date: the window is a trailing 24 hours, so
 * one that opened at 09:00 yesterday used to read "since 14 August" — which
 * claims the whole of a day the figure covers a quarter of.
 */
function since(startedAt: string | undefined, unlocked: boolean): string {
  if (!unlocked) return "sign in to view";
  if (!startedAt) return "awaiting the first run";
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return "over the reported window";
  return `since ${started.toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  })}`;
}

function cadence(seconds: number): string {
  if (seconds < 60) return `checked every ${seconds} sec`;
  if (seconds < 3_600) return `checked every ${Math.round(seconds / 60)} min`;
  return `checked every ${Math.round(seconds / 3_600)} hr`;
}

function latency(ms: number | null | undefined, unlocked: boolean): string {
  if (!unlocked || ms === null || ms === undefined) return "—";
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${ms} ms`;
}

function protectedDetail(unlocked: boolean, value: string | undefined, fallback: string): string {
  if (!unlocked) return "sign in to view";
  return value ?? fallback;
}

/** How long ago, in the coarsest unit that is still honest. */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1_000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function bucketLabel(at: string, bucket: UsageReport["bucket"]): string {
  return new Intl.DateTimeFormat("en", bucket === "hour"
    ? { month: "short", day: "numeric", hour: "numeric" }
    : { month: "short", day: "numeric" }).format(new Date(at));
}

/**
 * Wall clock, seconds included.
 *
 * An operations console states the time it is describing. Seconds are the point
 * — a clock that only shows minutes reads as decoration, and this one is here
 * to say the panel is live.
 */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const two = (value: number) => value.toString().padStart(2, "0");
  // The offset the operator is actually in, derived rather than assumed: a
  // deployment is on-premise and its people are in one place, but this
  // interface has no idea which.
  const offsetMinutes = -now.getTimezoneOffset();
  const offset = `UTC${offsetMinutes < 0 ? "−" : "+"}${Math.floor(Math.abs(offsetMinutes) / 60)}`;

  return (
    <div className="flex shrink-0 items-baseline gap-2 text-right">
      <strong
        className="font-mono text-[19px] font-semibold leading-none tabular-nums text-text sm:text-[21px]"
        aria-label="Local time"
      >
        {two(now.getHours())}:{two(now.getMinutes())}:{two(now.getSeconds())}
      </strong>
      <span className="font-mono text-micro uppercase tracking-[0.16em] text-faint">{offset}</span>
    </div>
  );
}

/** The three hops a governed answer passes through, each with its real state. */
function topology(props: DashboardHeroProps) {
  const layerState = (key: HomeLayer["key"]) => props.layers.find((layer) => layer.key === key)?.state;
  const inference = layerState("inference");
  const agentic = layerState("agentic");

  const layerNotes = (key: HomeLayer["key"]) => props.layers.find((layer) => layer.key === key)?.components ?? [];

  return [
    {
      name: "OrcaSynapse",
      role: "Identity, policy, audit",
      // The control plane is the thing rendering this panel. Reporting it as
      // anything but reachable would be a claim contradicted by its own arrival.
      state: "Serving",
      live: true,
      notes: [] as Array<{ name: string; label: string; tone: string }>,
    },
    {
      name: "Hermes",
      role: "Isolated agent session",
      state: agentic?.label ?? "Unknown",
      live: agentic?.tone === "ready",
      notes: layerNotes("agentic"),
    },
    {
      name: "AI Inference",
      role: "Approved model serving",
      state: inference?.label ?? "Unknown",
      live: inference?.tone === "ready",
      notes: layerNotes("inference"),
    },
  ];
}

/**
 * Bring-up progress as a ring rather than a fraction in a chip. Geometry comes
 * through SVG attributes and colour through utility classes, because
 * `style-src 'self'` refuses the inline style a percentage bar would want.
 */
function ReadinessRing({ ready, total, unlocked }: { ready: number; total: number; unlocked: boolean }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const filled = unlocked && total > 0 ? (ready / total) * circumference : 0;
  const complete = unlocked && total > 0 && ready === total;

  return (
    <div className="relative grid size-14 shrink-0 place-items-center">
      <svg className="size-14 -rotate-90" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r={radius} className="fill-none stroke-border" strokeWidth="4" />
        <circle
          cx="28"
          cy="28"
          r={radius}
          className={cn("fill-none transition-[stroke-dasharray]", complete ? "stroke-good" : "stroke-node")}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
      <span className="absolute grid place-items-center font-mono text-caption font-semibold tabular-nums text-text">
        {unlocked ? `${ready}/${total}` : "—"}
      </span>
    </div>
  );
}

/** A dense label/figure pair, for the groups that are read rather than scanned. */
function MiniStat({ label, value, tone }: { label: string; value: string; tone?: "bad" | "warn" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-micro uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd
        className={cn(
          "m-0 mt-0.5 truncate font-mono text-label font-semibold tabular-nums",
          tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-text",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * One cell of the KPI strip. No icon: six 14px glyphs beside six labels said
 * nothing the labels did not, and the strip reads cleaner as type alone.
 */
function StripCell({
  label,
  value,
  detail,
  fill,
  failing,
  warn,
}: {
  label: string;
  value: string;
  detail: string;
  fill?: number | undefined;
  failing?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0 bg-surface px-3 py-2.5">
      <dt className="truncate text-micro uppercase tracking-[0.13em] text-faint">{label}</dt>
      <dd
        className={cn(
          "m-0 mt-1 truncate font-display text-[21px] font-semibold leading-none tabular-nums",
          warn ? "text-warn" : "text-text",
        )}
      >
        {value}
      </dd>
      <dd className="m-0 mt-1 truncate text-micro text-muted">{detail}</dd>
      {fill === undefined ? null : (
        <dd className="m-0">
          <progress
            className={cn("metric-progress mt-1.5 block h-0.5 w-full", failing ? "is-warn" : "is-good")}
            max={100}
            value={Math.round(fill * 100)}
            aria-label={`${label}: proportion of the total`}
          />
        </dd>
      )}
    </div>
  );
}

/**
 * Runs per bucket, in the exact grammar `UsageTrend` draws tokens with on the
 * Usage screen: violet bars, red failure ticks at the baseline, a hairline
 * base, edge timestamps. Same product, same chart language — this one answers
 * "is activity normal" and leaves token mass to Usage.
 *
 * Every dimension is an SVG presentation attribute because the container
 * serves `style-src 'self'`; `preserveAspectRatio="none"` lets one bar per
 * bucket stretch to whatever width the panel has, so the same markup renders
 * 24 buckets and 168.
 */
function ActivityTrend({ series, bucket }: { series: UsageBucket[]; bucket: UsageReport["bucket"] }) {
  const ceiling = Math.max(1, ...series.map((point) => point.runs));
  const span = Math.max(1, series.length);
  const width = 0.78;

  return (
    <figure className="m-0 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-2">
      <svg
        className="h-full min-h-[88px] w-full"
        viewBox={`0 0 ${span} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Runs per ${bucket} across ${series.length} ${bucket === "hour" ? "hours" : "days"}.`}
      >
        <rect x="0" y="99.6" width={span} height="0.4" className="fill-border" />
        {series.map((point, index) => {
          // A bucket that ran nothing draws nothing — absence, not a sliver.
          if (point.runs === 0 && point.failed === 0) return null;
          const height = Math.max(0.8, (point.runs / ceiling) * 96);
          return (
            <g key={point.at}>
              <title>
                {`${bucketLabel(point.at, bucket)} — ${point.runs} ${point.runs === 1 ? "run" : "runs"}${point.failed > 0 ? `, ${point.failed} failed` : ""}`}
              </title>
              {point.runs > 0 && (
                <rect
                  x={index + (1 - width) / 2}
                  y={100 - height}
                  width={width}
                  height={height}
                  className="fill-accent"
                />
              )}
              {point.failed > 0 && (
                <rect
                  x={index + (1 - width) / 2}
                  y="96.5"
                  width={width}
                  height="3.5"
                  className="fill-bad"
                />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex items-center justify-between gap-4 text-micro text-faint">
        <span>{series.length > 0 ? bucketLabel(series[0]!.at, bucket) : ""}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2 bg-accent" />Runs</span>
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2 bg-bad" />Failures</span>
        </span>
        <span>{series.length > 0 ? bucketLabel(series[series.length - 1]!.at, bucket) : ""}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Everything currently waiting on a person, in one queue.
 *
 * Priority is fixed rather than chronological: a decision someone can make now
 * (approvals) outranks a fault (offline node, failed responses), a fault
 * outranks bring-up (unready capabilities), and bring-up outranks the
 * informational tail (open incidents). During installation the queue is
 * exactly the readiness checklist; afterwards those rows retire themselves
 * and the same panel carries operations.
 */
interface AttentionItem {
  key: string;
  tone: "bad" | "warn" | "accent";
  label: string;
  detail: string;
  next?: boolean;
  action: ActiveView;
  setupStep?: SetupStepKey;
}

function attentionItems(props: DashboardHeroProps): AttentionItem[] {
  if (!props.unlocked) return [];
  const items: AttentionItem[] = [];

  const pending = props.toolMetrics?.pendingApprovals ?? 0;
  if (pending > 0) {
    items.push({
      key: "approvals",
      tone: "warn",
      label: pending === 1 ? "1 approval waiting" : `${pending} approvals waiting`,
      detail: "Tool calls are paused until someone decides",
      action: "Integrations",
    });
  }

  for (const node of props.runtimeNodes) {
    if (node.status !== "OFFLINE" && node.status !== "DEGRADED") continue;
    items.push({
      key: `node-${node.id}`,
      tone: "bad",
      label: `${node.displayName} is ${node.status === "OFFLINE" ? "offline" : "degraded"}`,
      detail: node.status === "OFFLINE" ? "Unreachable from the control plane" : "Answering, but not cleanly",
      action: "Deployment",
    });
  }

  const failed = props.chatMetrics?.failed ?? 0;
  if (failed > 0) {
    items.push({
      key: "failed-responses",
      tone: "bad",
      label: failed === 1 ? "1 failed response" : `${failed} failed responses`,
      detail: "In the last 24 hours · read the ledger",
      action: "Agents",
    });
  }

  const nextIndex = props.readiness.findIndex((check) => !check.ready);
  props.readiness.forEach((check, index) => {
    if (check.ready) return;
    items.push({
      key: `readiness-${check.label}`,
      tone: "accent",
      label: check.label,
      detail: check.detail,
      next: index === nextIndex,
      action: check.action,
      ...(check.setupStep ? { setupStep: check.setupStep } : {}),
    });
  });

  for (const incident of props.incidents ?? []) {
    if (incident.status === "RESOLVED") continue;
    items.push({
      key: `incident-${incident.id}`,
      tone: incident.severity === "CRITICAL" ? "bad" : "warn",
      label: incident.title,
      detail: `${incident.severity === "CRITICAL" ? "Critical" : "Warning"} incident · ${incident.component}`,
      action: "Operations",
    });
  }

  return items;
}

/** How many attention rows fit before the panel stops being a glance. */
const ATTENTION_ROWS = 5;

const RUN_TONE: Record<AgentRun["status"], string> = {
  QUEUED: "bg-faint",
  RUNNING: "bg-node",
  WAITING_FOR_APPROVAL: "bg-warn",
  CANCEL_REQUESTED: "bg-warn",
  COMPLETED: "bg-good",
  FAILED: "bg-bad",
  CANCELLED: "bg-warn",
  TIMED_OUT: "bg-bad",
  DENIED: "bg-bad",
};

function runStatusLabel(status: AgentRun["status"]): string {
  const words = status.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The moment a session row should be dated by: done > started > asked. */
function runMoment(run: AgentRun): string | null {
  return run.completedAt ?? run.startedAt ?? run.queuedAt;
}

export function DashboardHero(props: DashboardHeroProps) {
  const hops = topology(props);
  const intact = hops.every((hop) => hop.live);
  const readyCount = props.readiness.filter(({ ready }) => ready).length;
  const workspaceReady = props.unlocked && props.readiness.length > 0 && readyCount === props.readiness.length;

  const access = props.layers.find((layer) => layer.key === "access");
  const completedShare = props.unlocked
    ? share(props.chatMetrics?.completed, props.chatMetrics?.responses)
    : undefined;

  const attention = attentionItems(props);
  const shownAttention = attention.slice(0, ATTENTION_ROWS);
  const hiddenAttention = attention.length - shownAttention.length;

  const tools = props.toolMetrics;
  const pendingApprovals = tools?.pendingApprovals ?? 0;
  const queuedRuns = props.agentMetrics?.queuedRuns ?? 0;

  /*
   * Newest first, decided here rather than assumed: the API orders the ledger
   * for its own screen, and a dashboard that inherits an ordering it never
   * asked for breaks the day the other screen changes its mind.
   */
  const recentRuns = (props.runs ?? [])
    .slice()
    .sort((a, b) => (runMoment(b) ?? "").localeCompare(runMoment(a) ?? ""))
    .slice(0, 6);

  const totals = props.usage?.totals ?? null;
  const nodesOnline = props.runtimeNodes.filter((node) => node.status === "ONLINE").length;

  const openItem = (item: { action: ActiveView; setupStep?: SetupStepKey }) => {
    if (!props.unlocked) {
      props.onUnlock();
    } else if (item.setupStep) {
      props.onSelect(item.action, item.setupStep);
    } else {
      props.onSelect(item.action);
    }
  };

  return (
    <section className="dashboard-hero" aria-label="Deployment command panel">
      <div className="dashboard-hero__inner relative isolate overflow-hidden py-4">
        <div className="dashboard-hero__content relative z-[1] grid min-h-0 gap-4">

        <div className="grid gap-4">
        {/*
          The page's name over the dot-grid field every other title row
          carries, so the Dashboard's header speaks the same texture as the
          workspaces'. The field fades before the readouts start — texture
          behind a name, never behind working controls.
        */}
        <div className="workspace-intro-field flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-1 py-1.5">
          <h1 className="m-0 min-w-0 font-display text-[25px] font-semibold leading-[1.12] tracking-[-0.025em] text-text sm:text-[29px]">
            Control Center
          </h1>
          <div className="flex shrink-0 flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
              <Clock />
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 shrink-0 rounded-full", props.apiAvailable ? "bg-good" : "bg-bad")}
                />
                <span
                  className={cn(
                    "whitespace-nowrap text-micro font-semibold",
                    props.apiAvailable ? "text-good" : "text-bad",
                  )}
                >
                  {props.apiAvailable ? "Control plane online" : "Control plane offline"}
                </span>
              </span>
            </div>
            <Button variant="primary" onClick={props.onPrimary}>
              {props.primaryLabel}
            </Button>
          </div>
        </div>

        {workspaceReady && (
          <Button
            variant="outline"
            size="auto"
            onClick={props.onAsk}
            aria-label="Ask your Hermes agent"
            className="flex w-full flex-row items-center justify-start gap-3 whitespace-normal border-border bg-surface px-4 py-3 text-left font-normal shadow-card hover:border-accent hover:bg-raised hover:text-text"
          >
            <TerminalIcon aria-hidden="true" className="size-[18px] shrink-0 text-muted" />
            <span className="min-w-0 flex-1 text-[15px] tracking-[-0.01em] text-muted">
              Ask your Hermes agent anything…
            </span>
            <span className="hidden text-caption font-semibold text-accent sm:inline">Open Session</span>
          </Button>
        )}

        {/*
          Two strips, two kinds of fact. The left one is a trailing day, said
          once for all four cells instead of as four "/ 24h" suffixes; the
          right one is the current instant, which needs no window at all. The
          old strip mixed an all-time cell into a 24-hour row and patched the
          confusion with labels — the fix is to not mix.
        */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section aria-label="Activity over the last 24 hours">
            <span className="block px-0.5 text-micro font-semibold uppercase tracking-[0.16em] text-faint">
              Last 24 hours
            </span>
            <dl className="m-0 mt-1.5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
              <StripCell
                label="Sessions"
                value={count(props.chatMetrics?.conversations, props.unlocked)}
                detail={since(props.chatMetrics?.windowStartedAt, props.unlocked)}
              />
              <StripCell
                label="Responses"
                value={count(props.chatMetrics?.responses, props.unlocked)}
                detail={protectedDetail(
                  props.unlocked,
                  completedShare === undefined ? "none yet" : `${Math.round(completedShare * 100)}% completed`,
                  "none yet",
                )}
                fill={completedShare}
                failing={(props.chatMetrics?.failureRate ?? 0) > 0.1}
              />
              <StripCell
                label="Tokens"
                value={compact(props.chatMetrics?.totalTokens, props.unlocked)}
                detail={props.unlocked ? "prompt and completion" : "sign in to view"}
              />
              <StripCell
                label="Avg response"
                value={latency(props.chatMetrics?.averageLatencyMs, props.unlocked)}
                detail={props.unlocked ? "end to end" : "sign in to view"}
              />
            </dl>
          </section>
          <section aria-label="Live right now">
            <span className="block px-0.5 text-micro font-semibold uppercase tracking-[0.16em] text-faint">
              Live
            </span>
            <dl className="m-0 mt-1.5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
              <StripCell
                label="Running now"
                value={count(props.agentMetrics?.runningRuns, props.unlocked)}
                detail={protectedDetail(
                  props.unlocked,
                  queuedRuns === 1 ? "1 queued" : `${queuedRuns.toLocaleString()} queued`,
                  "0 queued",
                )}
              />
              <StripCell
                label="Awaiting approval"
                value={count(tools?.pendingApprovals, props.unlocked)}
                detail={protectedDetail(
                  props.unlocked,
                  pendingApprovals > 0 ? "decide in Tools" : "none waiting",
                  "none waiting",
                )}
                warn={props.unlocked && pendingApprovals > 0}
              />
            </dl>
          </section>
        </div>
        </div>

        <div className="dashboard-hero__operations grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1.12fr)_minmax(0,1fr)]">
          {/*
            The trend the poll always carried and no dashboard pixel drew: what
            the deployment actually did, bucket by bucket. The window control
            scopes this panel alone.
          */}
          <section
            className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card"
            aria-label="Activity"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-micro uppercase tracking-[0.18em] text-faint">Activity</span>
                <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">
                  Governed runs
                </h2>
                <span className="mt-1 block text-micro text-muted">
                  {`Per ${props.usage?.bucket ?? "hour"} · last ${props.period === "24h" ? "24 hours" : "7 days"}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Trend window">
                {(["24h", "7d"] as const).map((window) => (
                  <Button
                    key={window}
                    variant="ghost"
                    size="sm"
                    aria-pressed={props.period === window}
                    className={cn(
                      "h-7 px-2.5 font-mono text-micro tabular-nums",
                      props.period === window ? "bg-soft text-accent" : "text-muted",
                    )}
                    onClick={() => props.onPeriod(window)}
                  >
                    {window}
                  </Button>
                ))}
              </div>
            </div>

            {!props.unlocked ? (
              <div className="grid min-h-0 flex-1 place-items-center rounded border border-border bg-bg px-4 py-6">
                <span className="text-caption text-muted">Sign in to see what the deployment has done.</span>
              </div>
            ) : props.usage === null ? (
              <div className="grid min-h-0 flex-1 content-end gap-2">
                <Skeleton className="h-full min-h-[88px] w-full" />
                <Skeleton className="h-3 w-40" />
              </div>
            ) : totals !== null && totals.runs === 0 ? (
              <div className="grid min-h-0 flex-1 content-end">
                <div className="grid place-items-center pb-6">
                  <span className="text-caption text-muted">No runs in this window yet.</span>
                </div>
                <div aria-hidden="true" className="h-px w-full bg-border" />
              </div>
            ) : (
              <ActivityTrend series={props.usage.series} bucket={props.usage.bucket} />
            )}

            {/*
              The window's honest totals. "Tokens · partial" when some runs
              consumed tokens nobody counted; failure rate only once there is a
              denominator; cost only what the upstream actually said.
            */}
            <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-border pt-3 sm:grid-cols-4">
              <MiniStat
                label={totals !== null && totals.tokensUnreported > 0 ? "Tokens · partial" : "Tokens"}
                value={compact(totals?.totalTokens, props.unlocked)}
              />
              <MiniStat
                label="Failure rate"
                value={
                  !props.unlocked || totals === null || totals.runs === 0
                    ? "—"
                    : `${(totals.failureRate * 100).toFixed(1)}%`
                }
                {...(props.unlocked && totals !== null && totals.runs > 0 && totals.failureRate > 0.1
                  ? { tone: "warn" as const }
                  : {})}
              />
              <MiniStat label="p95 latency" value={latency(totals?.p95LatencyMs, props.unlocked)} />
              <MiniStat
                label="Cost"
                value={
                  !props.unlocked || totals === null || totals.costUsd === null
                    ? "—"
                    : `$${totals.costUsd.toFixed(2)}`
                }
              />
            </dl>
          </section>

          {/*
            One queue for everything waiting on a person. During bring-up these
            rows are the readiness checklist; in steady operation they are
            approvals, faults and incidents — and when there is nothing, the
            panel says so instead of stretching three placeholders.
          */}
          <section
            className="flex min-h-0 flex-col rounded-lg border border-border bg-surface p-4 shadow-card"
            aria-label="Needs attention"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-micro uppercase tracking-[0.18em] text-faint">Needs attention</span>
                <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">
                  {!props.unlocked
                    ? "Locked"
                    : attention.length === 0
                      ? "All clear"
                      : attention.length === 1
                        ? "1 item waiting"
                        : `${attention.length} items waiting`}
                </h2>
              </div>
              {props.unlocked && !workspaceReady && (
                <ReadinessRing ready={readyCount} total={props.readiness.length} unlocked={props.unlocked} />
              )}
            </div>

            {!props.unlocked ? (
              <Button
                variant="ghost"
                size="auto"
                className="mt-3 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 whitespace-normal rounded border border-border bg-bg px-3 py-2.5 text-left font-normal hover:border-border-strong hover:bg-raised"
                onClick={props.onUnlock}
              >
                <span className="min-w-0">
                  <strong className="block truncate text-caption font-semibold text-text">Sign in</strong>
                  <small className="mt-0.5 block text-micro font-medium leading-snug text-muted">
                    Approvals, faults and setup steps are inspected by an administrator.
                  </small>
                </span>
                <ArrowRight aria-hidden="true" className="size-4 text-faint" />
              </Button>
            ) : attention.length === 0 ? (
              <div className="mt-3 grid min-h-0 flex-1 place-items-center rounded border border-border bg-bg px-4 py-6">
                <div className="grid justify-items-center gap-1.5 text-center">
                  <CheckCircle2 aria-hidden="true" className="size-5 text-good" />
                  <strong className="text-caption font-semibold text-text">Nothing is waiting on you</strong>
                  <small className="text-micro leading-snug text-muted">
                    Approvals, faults, incidents and setup steps surface here.
                  </small>
                </div>
              </div>
            ) : (
              <div className="mt-3 grid min-h-0 flex-1 content-start gap-2 overflow-hidden">
                {shownAttention.map((item) => (
                  <Button
                    variant="ghost"
                    size="auto"
                    className={cn(
                      "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 whitespace-normal rounded border px-3 py-2.5 text-left font-normal",
                      item.next
                        ? "border-node/35 bg-node/[0.07] hover:border-node/60 hover:bg-node/[0.1]"
                        : "border-border bg-bg hover:border-border-strong hover:bg-raised",
                    )}
                    key={item.key}
                    onClick={() => openItem(item)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        item.tone === "bad" ? "bg-bad" : item.tone === "warn" ? "bg-warn" : "bg-node",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-caption font-semibold text-text">{item.label}</strong>
                        {item.next && <span className="text-micro uppercase tracking-[0.12em] text-node">Next</span>}
                      </span>
                      <small className="mt-0.5 block text-micro font-medium leading-snug text-muted">{item.detail}</small>
                    </span>
                    <ArrowRight aria-hidden="true" className="size-4 text-faint" />
                  </Button>
                ))}
                {hiddenAttention > 0 && (
                  <span className="px-1 text-micro text-faint">
                    {`+${hiddenAttention} more in their own workspaces`}
                  </span>
                )}
              </div>
            )}
          </section>

          {/*
            What just happened, by name. The strip counts the day; this names
            the most recent sessions so "something failed" has a face before
            anyone opens the ledger.
          */}
          <section
            className="flex min-h-0 flex-col rounded-lg border border-border bg-surface p-4 shadow-card"
            aria-label="Recent sessions"
          >
            <div className="min-w-0">
              <span className="block text-micro uppercase tracking-[0.18em] text-faint">Execution</span>
              <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">
                Recent sessions
              </h2>
            </div>

            {!props.unlocked ? (
              <div className="mt-3 grid min-h-0 flex-1 place-items-center rounded border border-border bg-bg px-4 py-6">
                <span className="text-caption text-muted">Sign in to read the ledger.</span>
              </div>
            ) : props.runs === null ? (
              <div className="mt-3 grid content-start gap-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : recentRuns.length === 0 ? (
              <div className="mt-3 grid min-h-0 flex-1 place-items-center rounded border border-border bg-bg px-4 py-6">
                <span className="text-caption text-muted">Sessions will appear here as they execute.</span>
              </div>
            ) : (
              <div className="mt-3 grid min-h-0 flex-1 content-start gap-1.5 overflow-hidden">
                {recentRuns.map((run) => (
                  <Button
                    variant="ghost"
                    size="auto"
                    key={run.id}
                    onClick={() => props.onSelect("Agents")}
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 whitespace-nowrap rounded border border-transparent px-2.5 py-2 text-left font-normal hover:border-border hover:bg-raised"
                  >
                    <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", RUN_TONE[run.status])} />
                    <span className="min-w-0">
                      <span className="block truncate text-caption font-medium text-text">{run.profileName}</span>
                      <span className="block truncate text-micro text-faint">{runStatusLabel(run.status)}</span>
                    </span>
                    <span className="font-mono text-micro tabular-nums text-muted">
                      {run.totalTokens === null ? "" : `${compact(run.totalTokens, true)} tk`}
                    </span>
                    <span className="font-mono text-micro tabular-nums text-faint">{ago(runMoment(run))}</span>
                  </Button>
                ))}
              </div>
            )}
          </section>

          {/*
            The machinery, at rest-state density: the three hops a governed
            answer passes through, the nodes it runs on, and who is allowed in.
            The full-height topology column this used to be said the same
            things in five times the space.
          */}
          <section
            className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card"
            aria-label="System"
          >
            <div className="min-w-0">
              <span className="block text-micro uppercase tracking-[0.18em] text-faint">System</span>
              <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">
                {intact ? "Every hop is answering" : "The path is not complete"}
              </h2>
            </div>

            <ol className="m-0 grid min-h-0 list-none content-start p-0">
              {hops.map((hop, index) => (
                <li className="relative grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 pb-3 last:pb-0" key={hop.name}>
                  {index < hops.length - 1 && (
                    <span aria-hidden="true" className="absolute bottom-0 left-[6px] top-4 w-px bg-border-strong" />
                  )}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative z-[1] mt-1 size-[13px] shrink-0 rounded-full border-2 bg-surface",
                      hop.live ? "border-node" : "border-border-strong",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <strong className="min-w-0 truncate text-caption font-semibold text-text">{hop.name}</strong>
                      <span className={cn("shrink-0 text-micro font-semibold", hop.live ? "text-node" : "text-muted")}>
                        {hop.state}
                      </span>
                    </div>
                    {/*
                      Why, but only when something is wrong: a healthy hop's
                      component list restates "Ready" under "Ready".
                    */}
                    {!hop.live && hop.notes.length > 0 && (
                      <ul className="m-0 mt-1 grid list-none gap-1 p-0">
                        {hop.notes.map((note) => (
                          <li className="flex items-baseline gap-1.5 text-micro leading-snug" key={note.name}>
                            <span
                              aria-hidden="true"
                              className={cn(
                                "mt-1 size-1 shrink-0 rounded-full",
                                note.tone === "ready" ? "bg-good" : note.tone === "degraded" ? "bg-warn" : "bg-faint",
                              )}
                            />
                            <span className="min-w-0 text-faint">
                              <strong className="font-medium text-muted">{note.name}</strong> · {note.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            <dl className="m-0 grid gap-2 border-t border-border pt-3">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-micro uppercase tracking-[0.13em] text-faint">VM2 nodes</dt>
                <dd className="m-0 font-mono text-micro font-semibold tabular-nums text-muted">
                  {!props.unlocked
                    ? "—"
                    : props.runtimeNodes.length === 0
                      ? "none enrolled"
                      : `${nodesOnline}/${props.runtimeNodes.length} online`}
                </dd>
              </div>
              {access && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-micro uppercase tracking-[0.13em] text-faint">Identity</dt>
                  <dd className="m-0 flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 truncate text-micro text-muted">{access.name}</span>
                    <span
                      className={cn(
                        "shrink-0 text-micro font-semibold",
                        access.state.tone === "ready" ? "text-good" : access.state.tone === "degraded" ? "text-warn" : "text-faint",
                      )}
                    >
                      {access.state.label}
                    </span>
                  </dd>
                </div>
              )}
            </dl>

            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-micro text-faint">
              <span>
                <strong className="font-semibold tabular-nums text-muted">
                  {props.unlocked ? props.healthyConnections : "—"}
                </strong>{" "}
                services answering
              </span>
              {props.monitoring?.enabled && <span>{cadence(props.monitoring.intervalSeconds)}</span>}
              <span>Every run written to the ledger</span>
            </div>
          </section>
        </div>
        </div>
      </div>
    </section>
  );
}
