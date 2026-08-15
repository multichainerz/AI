import type {
  AgentMetrics,
  ChatMetrics,
  ConnectionMonitoringControl,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Layers as LayersIcon, MessageSquareText as TerminalIcon, Monitor as MonitorIcon, RefreshCw as SyncIcon, Settings as GearIcon, ThumbsUp as ThumbsUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HomeLayer, HomeReadinessCheck } from "./home-view.js";
import type { SetupStepKey } from "./setup-steps.js";
import type { ActiveView } from "./workspace-navigation.js";

/**
 * The Dashboard's command panel.
 *
 * Every other screen in this product is a page of cards. This is the one
 * surface that is meant to be looked at rather than read: a full-bleed themed
 * field carrying what the deployment is, what it has done, and whether the
 * governed path from a question to an answer is intact end to end.
 *
 * It draws only what the runtime reports. There is no map here because there is
 * no geography in an on-premise control plane -- the equivalent "territory" is
 * the four hops a message actually takes, which is what the topology draws, with
 * each hop's real state rather than a decorative one.
 *
 * It uses the workspace's black/white canvas and keeps violet for actions and
 * emphasis, so the same operational hierarchy survives either theme.
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
  layers: HomeLayer[];
  readiness: HomeReadinessCheck[];
  onSelect: (view: ActiveView, setupStep?: SetupStepKey) => void;
}

interface DashboardMetric {
  label: string;
  /**
   * The period the figure covers, stated beside its name.
   *
   * Not decoration: this strip draws chat figures from a trailing 24-hour
   * window next to tool figures that are every call since the install, and
   * with neither labelled "Responses 12" read as the same day's work as
   * "Tool calls 8,431". `operations-view.tsx` has always said "/ 24h" on the
   * same data; this is that treatment, applied to all six cells.
   */
  window: "24h" | "all time";
  icon: ReactNode;
  value: string;
  detail: string;
  fill?: number | undefined;
  failing?: boolean;
}

/**
 * Ratings needed before a satisfaction score is allowed to read as a verdict.
 *
 * `helpfulShare < 0.5` with no floor turns one not-helpful click into a
 * warn-coloured 0% for the whole deployment. Nothing in the product writes chat
 * feedback today — there is no surface for it — so this tile is structurally
 * 0 of 0, and the two honest states are "nothing rated" and "too few to judge".
 */
const RATINGS_BEFORE_A_VERDICT = 20;

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
 * "342 sessions" is not a fact until you know over what -- an hour and a quarter
 * reads very differently from a quarter. The runtime reports `windowStartedAt`,
 * so the caption states it rather than the panel implying a period it does not
 * know.
 *
 * With the clock time, not only the date: the window is a trailing 24 hours, so
 * one that opened at 09:00 yesterday used to read "since 14 August" -- which
 * claims the whole of a day the figure covers a quarter of, and says nothing
 * about the three quarters of today that it also covers.
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

/**
 * Wall clock, seconds included.
 *
 * An operations console states the time it is describing. Seconds are the point
 * -- a clock that only shows minutes reads as decoration, and this one is here
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

/** The four hops a governed answer passes through, each with its real state. */
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
      notes: [],
    },
    {
      name: "Hermes",
      role: "Isolated agent session",
      state: agentic?.label ?? "Unknown",
      live: agentic?.tone === "ready",
      /*
       * Why the hop is in the state it is in.
       *
       * `HomeLayer.components` has always carried this — "Hermes: Needs
       * Profile or policy" — and no surface drew it, so the panel could say
       * "Degraded" and leave the operator to go and find out what that meant.
       */
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
 * A quiet neural field behind the command panel.
 *
 * The topology below is operational information; this layer is atmosphere, so
 * it is deliberately absent from the accessibility tree and never responds to
 * a pointer. The graph is intentionally static: varied hub, branch and terminal
 * sizes provide depth without asking a low-power dashboard to repaint the whole
 * hero every frame.
 */
export function SynapseField({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("dashboard-synapse", className)}
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 1040 680"
    >
      <g className="dashboard-synapse__network">
        <SynapseNetworkLinks />
        {SYNAPSE_NODES.map(([cx, cy, tone, halo, core]) => (
          <g className={`dashboard-synapse__node dashboard-synapse__node--${tone}`} key={`${cx}-${cy}`}>
            {tone === "hub" && <circle className="dashboard-synapse__node-ring" cx={cx} cy={cy} r={halo + 9} />}
            <circle className="dashboard-synapse__node-halo" cx={cx} cy={cy} r={halo} />
            <circle className="dashboard-synapse__node-core" cx={cx} cy={cy} r={core} />
          </g>
        ))}
      </g>
    </svg>
  );
}

type SynapseNodeTone = "terminal" | "branch" | "hub";
type SynapseNode = [cx: number, cy: number, tone: SynapseNodeTone, halo: number, core: number];

const SYNAPSE_NODES: SynapseNode[] = [
  [18, 344, "terminal", 6, 1.4],
  [24, 444, "terminal", 8, 1.6],
  [24, 650, "terminal", 5, 1.2],
  [40, 128, "branch", 11, 2.2],
  [54, 180, "terminal", 7, 1.5],
  [76, 512, "terminal", 5, 1.2],
  [84, 364, "branch", 10, 2.1],
  [100, 566, "branch", 14, 2.8],
  [120, 24, "terminal", 6, 1.4],
  [178, 300, "hub", 23, 5.2],
  [194, 622, "branch", 12, 2.4],
  [206, 18, "terminal", 5, 1.2],
  [260, 266, "branch", 13, 2.7],
  [270, 516, "terminal", 8, 1.7],
  [322, 92, "hub", 29, 6.8],
  [366, 148, "branch", 10, 2.1],
  [366, 424, "hub", 19, 4.4],
  [430, 92, "terminal", 6, 1.3],
  [454, 512, "branch", 11, 2.3],
  [468, 302, "branch", 13, 2.7],
  [518, 22, "terminal", 7, 1.5],
  [520, 388, "branch", 15, 3.2],
  [554, 146, "hub", 26, 6],
  [576, 564, "branch", 11, 2.3],
  [604, 272, "terminal", 7, 1.5],
  [622, 18, "terminal", 8, 1.7],
  [622, 642, "branch", 15, 3.1],
  [686, 414, "hub", 31, 7.2],
  [720, 300, "hub", 21, 4.8],
  [760, 118, "branch", 12, 2.5],
  [812, 632, "terminal", 7, 1.5],
  [820, 442, "branch", 14, 2.9],
  [870, 290, "terminal", 6, 1.3],
  [914, 500, "branch", 13, 2.6],
  [916, 374, "branch", 10, 2.1],
  [918, 92, "branch", 12, 2.5],
  [940, 252, "terminal", 7, 1.5],
  [972, 420, "terminal", 5, 1.2],
  [1012, 214, "terminal", 6, 1.3],
  [1016, 316, "branch", 11, 2.2],
  [1016, 560, "terminal", 8, 1.7],
  [1024, 516, "terminal", 6, 1.3],
  [1038, 290, "terminal", 5, 1.2],
];

function SynapseNetworkLinks() {
  return (
    <>
      <path className="dashboard-synapse__link" d="M40 128C150 56 226 106 322 92C430 76 460 160 554 146C654 130 718 56 918 92" />
      <path className="dashboard-synapse__link" d="M322 92C300 190 222 212 178 300C130 398 178 482 100 566" />
      <path className="dashboard-synapse__link" d="M322 92C398 176 386 244 468 302C534 350 624 324 686 414C734 480 804 510 914 500" />
      <path className="dashboard-synapse__link" d="M554 146C588 214 680 230 720 300C780 400 818 360 916 374" />
      <path className="dashboard-synapse__link" d="M178 300C256 284 324 344 366 424C404 496 500 526 576 564" />
      <path className="dashboard-synapse__link" d="M468 302C430 352 438 408 366 424" />
      <path className="dashboard-synapse__link" d="M720 300C658 312 620 372 686 414" />
      <path className="dashboard-synapse__link" d="M40 128C74 208 112 250 178 300" />
      <path className="dashboard-synapse__link" d="M100 566C192 616 288 554 366 424" />
      <path className="dashboard-synapse__link" d="M622 18C730 24 828 46 918 92" />
      <path className="dashboard-synapse__link" d="M576 564C684 610 820 570 914 500" />
      <path className="dashboard-synapse__link" d="M686 414C776 456 850 430 916 374" />
      <path className="dashboard-synapse__link" d="M468 302C504 246 520 190 554 146" />
      <path className="dashboard-synapse__link" d="M54 180C132 150 230 168 366 148" />
      <path className="dashboard-synapse__link" d="M194 622C330 664 478 650 622 642" />
      <path className="dashboard-synapse__link" d="M622 642C760 654 894 618 1016 560" />
      <path className="dashboard-synapse__link" d="M100 566C80 510 48 480 24 444" />
      <path className="dashboard-synapse__link" d="M686 414C624 444 594 506 576 564" />
      <path className="dashboard-synapse__link" d="M916 374C964 406 996 458 1024 516" />
      <path className="dashboard-synapse__link" d="M18 344C42 356 60 364 84 364C118 360 146 332 178 300" />
      <path className="dashboard-synapse__link" d="M24 444C40 478 56 500 76 512C84 530 92 548 100 566" />
      <path className="dashboard-synapse__link" d="M178 300C212 280 236 266 260 266C288 240 304 160 322 92" />
      <path className="dashboard-synapse__link" d="M100 566C164 558 214 534 270 516C310 500 342 458 366 424" />
      <path className="dashboard-synapse__link" d="M322 92C364 100 396 98 430 92C468 84 506 108 554 146" />
      <path className="dashboard-synapse__link" d="M366 424C392 464 420 492 454 512C498 538 534 550 576 564" />
      <path className="dashboard-synapse__link" d="M468 302C486 346 500 372 520 388C560 420 624 422 686 414" />
      <path className="dashboard-synapse__link" d="M554 146C568 190 582 236 604 272C634 308 676 306 720 300" />
      <path className="dashboard-synapse__link" d="M554 146C616 112 686 106 760 118C822 128 870 108 918 92" />
      <path className="dashboard-synapse__link" d="M686 414C730 420 774 432 820 442C850 450 884 478 914 500" />
      <path className="dashboard-synapse__link" d="M720 300C772 284 820 280 870 290C898 296 912 330 916 374" />
      <path className="dashboard-synapse__link" d="M916 374C944 388 960 404 972 420C992 446 1010 500 1024 516" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M554 146C526 84 560 34 622 18" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M720 300C790 264 858 238 940 252" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M178 300C108 278 70 324 18 344" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M178 300C142 236 88 214 54 180" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M366 424C318 508 246 550 194 622" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M468 302C448 232 410 184 366 148" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M686 414C648 490 660 554 622 642" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M720 300C820 304 906 326 1016 316" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M918 92C974 126 982 176 1012 214" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M54 180C18 112 58 52 120 24" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M322 92C282 50 246 38 206 18" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M366 148C420 92 468 48 518 22" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M194 622C142 650 88 660 24 650" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M622 642C680 606 744 600 812 632" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M1016 316C1030 368 1032 424 1024 516" />
      <path className="dashboard-synapse__link dashboard-synapse__link--faint" d="M1012 214C1028 238 1036 262 1038 290" />
      <path className="dashboard-synapse__highlight" d="M40 128C150 56 226 106 322 92C430 76 460 160 554 146C654 130 718 56 918 92" />
      <path className="dashboard-synapse__highlight" d="M322 92C300 190 222 212 178 300C130 398 178 482 100 566" />
      <path className="dashboard-synapse__highlight" d="M322 92C398 176 386 244 468 302C534 350 624 324 686 414C734 480 804 510 914 500" />
      <path className="dashboard-synapse__highlight" d="M178 300C256 284 324 344 366 424C404 496 500 526 576 564" />
      <path className="dashboard-synapse__highlight" d="M554 146C588 214 680 230 720 300C780 400 818 360 916 374" />
    </>
  );
}

/**
 * Bring-up progress as a ring rather than a fraction in a chip.
 *
 * The number is still written in the middle — the ring is what makes "two of
 * three" legible from across a room, which is the distance an operations
 * screen is actually read from. Geometry comes through SVG attributes and
 * colour through utility classes, because `style-src 'self'` refuses the
 * inline style a percentage-driven bar would normally want.
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

/**
 * One stage of the run pipeline: a count, and the share of the pipeline it is.
 *
 * `<progress>` rather than a div with a width, for the same CSP reason as the
 * ring — and it carries the semantics for free, so a screen reader reports the
 * proportion instead of an unlabelled decoration.
 */
function PipelineRow({
  label,
  value,
  fraction,
  tone,
  unlocked,
}: {
  label: string;
  value: number | undefined;
  fraction: number | undefined;
  tone: "good" | "warn" | "bad" | "accent";
  unlocked: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1">
      <span className="truncate text-caption text-muted">{label}</span>
      <strong className="font-mono text-label font-semibold tabular-nums text-text">
        {count(value, unlocked)}
      </strong>
      {/*
        No bar at all rather than an empty one, for the reason the metric strip
        already gives: a zero-width track under a dash reads as "nothing is
        ready" when the truth is "nobody has looked yet", or "no run has been
        attempted". Both are absences, and only one of them is about the runs.
      */}
      {fraction === undefined ? null : (
        <progress
          className={cn(
            "metric-progress col-span-2 block h-1 w-full",
            tone === "good" && "is-good",
            tone === "warn" && "is-warn",
            tone === "bad" && "is-bad",
          )}
          max={100}
          value={Math.round(fraction * 100)}
          /*
            "Share of all runs" was a claim the contract cannot support:
            `AGENT_RUN_STATUSES` also carries CANCELLED, TIMED_OUT and DENIED,
            and `AgentMetrics` reports none of the three, so a cancelled run is
            in no bucket here and the denominator is these four stages alone.
          */
          aria-label={`${label}: share of the runs in these four stages`}
        />
      )}
    </div>
  );
}

/**
 * Response outcomes as one bar, because they are parts of one total.
 *
 * Three separate figures make a reader do the division; a single divided bar
 * shows the failure sliver at a glance. Widths are SVG attributes, and the
 * whole thing collapses to an empty track before anything has run rather than
 * to a full green one — the same distinction the completed-share bar draws.
 */
function OutcomeBar({ completed, failed, cancelled }: { completed: number; failed: number; cancelled: number }) {
  const total = completed + failed + cancelled;
  const width = (part: number) => (total > 0 ? (part / total) * 100 : 0);
  const completedWidth = width(completed);
  const failedWidth = width(failed);

  return (
    <svg
      className="h-1.5 w-full overflow-hidden rounded-pill"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect x="0" y="0" width="100" height="6" className="fill-border" />
      <rect x="0" y="0" width={completedWidth} height="6" className="fill-good" />
      <rect x={completedWidth} y="0" width={failedWidth} height="6" className="fill-bad" />
      <rect x={completedWidth + failedWidth} y="0" width={width(cancelled)} height="6" className="fill-warn" />
    </svg>
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

export function DashboardHero(props: DashboardHeroProps) {
  const hops = topology(props);
  const intact = hops.every((hop) => hop.live);
  const readyCount = props.readiness.filter(({ ready }) => ready).length;
  const nextIndex = props.unlocked ? props.readiness.findIndex(({ ready }) => !ready) : -1;
  const workspaceReady = props.unlocked && props.readiness.length > 0 && readyCount === props.readiness.length;

  const access = props.layers.find((layer) => layer.key === "access");
  const completedShare = props.unlocked
    ? share(props.chatMetrics?.completed, props.chatMetrics?.responses)
    : undefined;
  const feedback = props.chatMetrics?.feedback;
  const rated = (feedback?.helpful ?? 0) + (feedback?.notHelpful ?? 0);
  const helpfulShare = props.unlocked ? share(feedback?.helpful, rated) : undefined;

  /*
   * The run pipeline, as four stages of one total.
   *
   * These four figures arrive on every poll and nothing drew them: the panel
   * reported how many Profiles exist while saying nothing about what those
   * Profiles are currently doing, which is the question an operations screen
   * exists to answer.
   */
  const runs = props.agentMetrics;
  const runTotal = (runs?.queuedRuns ?? 0) + (runs?.runningRuns ?? 0) + (runs?.completedRuns ?? 0) + (runs?.failedRuns ?? 0);
  const stages = [
    { label: "Queued", value: runs?.queuedRuns, tone: "accent" as const },
    { label: "Running", value: runs?.runningRuns, tone: "accent" as const },
    { label: "Completed", value: runs?.completedRuns, tone: "good" as const },
    { label: "Failed", value: runs?.failedRuns, tone: "bad" as const },
  ];

  /*
   * Every tool call the ledger holds an outcome for.
   *
   * The headline used to be `completedCalls` alone, sitting beside a Denied
   * figure that was never part of it — so the obvious subtraction gave the
   * wrong answer, and `failedCalls` arrived on every poll and reached no pixel.
   * Executing calls are deliberately out: they have not finished, so they
   * belong to no outcome yet, and including them would break the subtraction
   * again in the other direction.
   */
  const tools = props.toolMetrics;
  const recordedCalls = tools ? tools.completedCalls + tools.deniedCalls + tools.failedCalls : undefined;

  const metrics: DashboardMetric[] = [
    {
      label: "Sessions",
      window: "24h",
      icon: <TerminalIcon size={14} />,
      value: count(props.chatMetrics?.conversations, props.unlocked),
      detail: since(props.chatMetrics?.windowStartedAt, props.unlocked),
    },
    {
      label: "Responses",
      window: "24h",
      icon: <SyncIcon size={14} />,
      value: count(props.chatMetrics?.responses, props.unlocked),
      /*
       * The completed *share*, not the completed count. The count is stated
       * once, under the outcome bar that divides it — saying "1,249 completed"
       * in both places spends two of the screen's six headline slots on one
       * fact, and the percentage is the thing this tile's bar is drawing.
       */
      detail: protectedDetail(
        props.unlocked,
        completedShare === undefined ? "none yet" : `${Math.round(completedShare * 100)}% completed`,
        "none yet",
      ),
      fill: completedShare,
      failing: (props.chatMetrics?.failureRate ?? 0) > 0.1,
    },
    {
      label: "Avg response",
      window: "24h",
      icon: <MonitorIcon size={14} />,
      value: latency(props.chatMetrics?.averageLatencyMs, props.unlocked),
      detail: props.unlocked ? "end to end" : "sign in to view",
    },
    {
      label: "Tokens",
      window: "24h",
      icon: <LayersIcon size={14} />,
      value: compact(props.chatMetrics?.totalTokens, props.unlocked),
      detail: props.unlocked ? "prompt and completion" : "sign in to view",
    },
    {
      label: "Tool calls",
      // The one cell here the runtime reports without a window: every call
      // since the install, not the last day's.
      window: "all time",
      icon: <GearIcon size={14} />,
      value: count(recordedCalls, props.unlocked),
      detail: protectedDetail(
        props.unlocked,
        tools ? `${tools.activeGrants.toLocaleString()} grants` : undefined,
        "default deny",
      ),
    },
    {
      label: "Rated helpful",
      window: "24h",
      icon: <ThumbsUpIcon size={14} />,
      value: helpfulShare === undefined ? "—" : `${Math.round(helpfulShare * 100)}%`,
      detail: protectedDetail(
        props.unlocked,
        rated > 0 ? `${rated.toLocaleString()} rated` : "no ratings yet",
        "no ratings yet",
      ),
      fill: helpfulShare,
      // A verdict needs a sample. Below the floor the tile still states the
      // share and the count it came from; it just does not paint one click as
      // a deployment-wide failure.
      failing: helpfulShare !== undefined && rated >= RATINGS_BEFORE_A_VERDICT && helpfulShare < 0.5,
    },
  ];
  const openReadiness = (check: HomeReadinessCheck) => {
    if (!props.unlocked) {
      props.onUnlock();
    } else if (check.setupStep) {
      props.onSelect(check.action, check.setupStep);
    } else {
      props.onSelect(check.action);
    }
  };

  return (
    <section className="dashboard-hero" aria-label="Deployment command panel">
      <div className="dashboard-hero__inner relative isolate overflow-hidden py-4">
        <div className="dashboard-hero__content relative z-[1] grid min-h-0 gap-4">

        <div className="grid gap-4">
        {/*
          A fixed title, not a status sentence.

          The heading used to change with readiness — "Finish your private AI
          workspace", "Your agentic workspace is ready" — above a line reading
          "0 of 3 required capabilities are ready. Next: Connect and verify
          model serving." Both restated the Required capabilities panel forty
          pixels below, which already shows the fraction and marks that exact
          step NEXT. The panel keeps that job; this is just the page's name,
          and the `<h1>` the Dashboard needs as its landmark.
        */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <h1 className="m-0 min-w-0 font-display text-[25px] font-semibold leading-[1.12] tracking-[-0.025em] text-text sm:text-[29px]">
            OrcaSynapse control center
          </h1>
          {/*
            Two groups, not three competing chips.

            The status used to be a `h-9` bordered pill sitting between the
            clock and the primary button — the same height, the same radius and
            the same weight as the one control on the row, so the first thing
            an operator tried to do with it was click it. It is a readout, and
            the clock beside it is a readout, so they share one quiet module and
            the button is left as the only thing on the row shaped like a
            control. The dot also stopped being cyan inside a green chip:
            `bg-node` is the live-node accent, and pairing it with success text
            put two unrelated semantics in one 90px space.
          */}
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

        <dl
          aria-label="Operational activity"
          className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-6"
        >
          {metrics.map((metric) => (
            <div className="min-w-0 bg-surface px-3 py-2.5" key={metric.label}>
              <dt className="flex items-center gap-1.5 text-micro uppercase tracking-[0.13em] text-faint">
                <span aria-hidden="true" className="flex shrink-0">
                  {metric.icon}
                </span>
                {/*
                  The window is `shrink-0` and the name is what truncates. Six
                  cells across a desktop column leave about 120px of label, and
                  the period is the half a reader cannot infer: "SESSIONS" is
                  legible from its own figure, "/ 24h" is not recoverable from
                  anything else on the tile.
                */}
                <span className="truncate">{metric.label}</span>
                <span className="shrink-0">/ {metric.window}</span>
              </dt>
              <dd className="m-0 mt-1 truncate font-display text-[21px] font-semibold leading-none tabular-nums text-text">
                {metric.value}
              </dd>
              <dd className="m-0 mt-1 truncate text-micro text-muted">{metric.detail}</dd>
              {metric.fill === undefined ? null : (
                <dd className="m-0">
                  <progress
                    className={cn("metric-progress mt-1.5 block h-0.5 w-full", metric.failing ? "is-warn" : "is-good")}
                    max={100}
                    value={Math.round(metric.fill * 100)}
                    aria-label={`${metric.label}: proportion of the total`}
                  />
                </dd>
              )}
            </div>
          ))}
        </dl>
        </div>

        <div className="dashboard-hero__operations grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)_minmax(0,0.92fr)]">
          <section className="flex min-h-0 flex-col rounded-lg border border-border bg-surface p-4 shadow-card" aria-labelledby="dashboard-readiness-title">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-micro uppercase tracking-[0.18em] text-faint">Workspace readiness</span>
                <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-text" id="dashboard-readiness-title">
                  Required capabilities
                </h2>
                <strong className="mt-1.5 inline-block font-mono text-micro font-semibold tabular-nums text-muted">
                  {props.unlocked ? `${readyCount}/${props.readiness.length} ready` : "Locked"}
                </strong>
              </div>
              <ReadinessRing ready={readyCount} total={props.readiness.length} unlocked={props.unlocked} />
            </div>

            {/*
              `auto-rows-fr` rather than `content-start`: at the desktop
              baseline this column has ~300px more height than three 56px rows
              need, and a checklist that hugs the top under a third of a screen
              of nothing reads as a panel that failed to load. Equal rows make
              the space deliberate and the targets easier to hit.
            */}
            <div className="mt-3 grid min-h-0 flex-1 auto-rows-fr gap-2">
              {props.readiness.map((check, index) => {
                const isNext = index === nextIndex;
                return (
                  <Button
                    variant="ghost"
                    size="auto"
                    className={cn(
                      "grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 whitespace-normal rounded border px-3 py-2.5 text-left font-normal",
                      isNext
                        ? "border-node/35 bg-node/[0.07] hover:border-node/60 hover:bg-node/[0.1]"
                        : "border-border bg-bg hover:border-border-strong hover:bg-raised",
                    )}
                    key={check.label}
                    onClick={() => openReadiness(check)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        !props.unlocked ? "bg-faint" : check.ready ? "bg-node" : "bg-faint",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-caption font-semibold text-text">{check.label}</strong>
                        {isNext && <span className="text-micro uppercase tracking-[0.12em] text-node">Next</span>}
                      </span>
                      <small className="mt-0.5 block text-micro font-medium leading-snug text-muted">
                        {props.unlocked ? check.detail : "Sign in to inspect readiness"}
                      </small>
                    </span>
                    <ArrowRight aria-hidden="true" className="size-4 text-faint" />
                  </Button>
                );
              })}
            </div>

            {/*
              Only the layer the governed path does not already carry.

              The first draft listed all three, which put "AI Inference —
              Ready" and "Agentic System — Degraded" on the screen twice: the
              path column derives its two middle hops from exactly those two
              layer states. Enterprise access is the one that appears nowhere
              else, and it is a real deployment question, so it is the one that
              stays. It is text rather than a button on purpose — "AI
              Inference" already names a capability button above, and two
              controls with one name is ambiguous to a pointer and a screen
              reader alike.
            */}
            {access && (
              <dl className="mt-auto grid gap-1 border-t border-border pt-3">
                <dt className="text-micro uppercase tracking-[0.18em] text-faint">Identity</dt>
                <dd className="m-0 flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-caption text-muted">{access.name}</span>
                  <span
                    className={cn(
                      "shrink-0 text-micro font-semibold",
                      access.state.tone === "ready" ? "text-good" : access.state.tone === "degraded" ? "text-warn" : "text-faint",
                    )}
                  >
                    {access.state.label}
                  </span>
                </dd>
              </dl>
            )}
          </section>

          <section className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card" aria-labelledby="dashboard-path-title">
            <div className="min-w-0">
              <span className="block text-micro uppercase tracking-[0.18em] text-faint">Governed path</span>
              <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-text" id="dashboard-path-title">
                {intact ? "Every hop is answering" : "The path is not complete"}
              </h2>
            </div>

            {/*
              The hops read top to bottom, as a chain rather than three tiles.

              Side by side they were three cards of equal weight with a 10px
              rule between them, which says "these are related" and nothing
              about direction. A message travels through these in order, and a
              spine drawn between the markers is what makes that order the
              first thing the panel says. It also gives the column something to
              fill its height with, which the row never did.
            */}
            <ol className="m-0 grid min-h-0 flex-1 list-none auto-rows-fr content-stretch p-0">
              {hops.map((hop, index) => (
                <li className="relative grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 pb-4 last:pb-0" key={hop.name}>
                  {index < hops.length - 1 && (
                    <span aria-hidden="true" className="absolute bottom-1 left-[7px] top-5 w-px bg-border-strong" />
                  )}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative z-[1] mt-1 size-[15px] shrink-0 rounded-full border-2 bg-surface",
                      hop.live ? "border-node" : "border-border-strong",
                    )}
                  />
                  <div className="min-w-0 pb-0.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <strong className="min-w-0 truncate text-caption font-semibold text-text">{hop.name}</strong>
                      <span className={cn("shrink-0 text-micro font-semibold", hop.live ? "text-node" : "text-muted")}>
                        {hop.state}
                      </span>
                    </div>
                    <span className="mt-0.5 block text-micro leading-relaxed text-muted">{hop.role}</span>
                    {hop.notes.length > 0 && (
                      <ul className="m-0 mt-1.5 grid list-none gap-1 p-0">
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

            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-micro text-faint">
              <span>
                <strong className="font-semibold tabular-nums text-muted">
                  {props.unlocked ? props.healthyConnections : "—"}
                </strong>{" "}
                services answering
              </span>
              {props.monitoring?.enabled && <span>{cadence(props.monitoring.intervalSeconds)}</span>}
              <span>Owner-scoped retrieval</span>
              <span>Default-deny tool policy</span>
              <span>Every run written to the ledger</span>
            </div>
          </section>

          {/*
            What the deployment is doing right now.

            Every figure in this column already arrived on each poll and none
            of them were drawn: run stages, the cancelled and failed shares of
            a response total, and the approvals a tool call is waiting on. The
            panel could say how many Profiles existed but not whether any of
            them were running, which is the first thing anyone opens an
            operations screen to find out.
          */}
          <section
            className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card"
            aria-labelledby="dashboard-execution-title"
          >
            <div className="min-w-0">
              <span className="block text-micro uppercase tracking-[0.18em] text-faint">Execution</span>
              <h2
                className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-text"
                id="dashboard-execution-title"
              >
                Run pipeline
              </h2>
              {/*
                Stated because this column mixes two periods too: the run
                stages are every run since the install, and the response
                outcomes below them are the same trailing day as the strip
                above. `AgentMetrics` carries no window at all, so a caption is
                the only place this can be said.
              */}
              <span className="mt-1 block text-micro text-muted">All time</span>
            </div>

            <div className="grid content-start gap-2.5">
              {stages.map((stage) => (
                <PipelineRow
                  key={stage.label}
                  label={stage.label}
                  value={stage.value}
                  fraction={props.unlocked ? share(stage.value, runTotal) : undefined}
                  tone={stage.tone}
                  unlocked={props.unlocked}
                />
              ))}
            </div>

            <div className="border-t border-border pt-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-micro uppercase tracking-[0.13em] text-faint">Response outcomes / 24h</span>
                <span className="font-mono text-micro tabular-nums text-muted">
                  {count(props.chatMetrics?.responses, props.unlocked)}
                </span>
              </div>
              <div className="mt-2">
                <OutcomeBar
                  completed={props.unlocked ? props.chatMetrics?.completed ?? 0 : 0}
                  failed={props.unlocked ? props.chatMetrics?.failed ?? 0 : 0}
                  cancelled={props.unlocked ? props.chatMetrics?.cancelled ?? 0 : 0}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-micro text-muted">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-good" />
                  {count(props.chatMetrics?.completed, props.unlocked)} completed
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-bad" />
                  {count(props.chatMetrics?.failed, props.unlocked)} failed
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
                  {count(props.chatMetrics?.cancelled, props.unlocked)} cancelled
                </span>
              </div>
            </div>

            {/*
              Two columns rather than three, because there are four figures now.

              `failedCalls` arrived on every poll and was drawn nowhere, which
              is also what made the headline Tool calls figure unreadable —
              there was no way to see what the total was missing. Both call
              outcomes name the noun: "Failed" alone would sit in the same
              column as the failed *run* count above it, meaning something
              else entirely.
            */}
            <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-border pt-3">
              <MiniStat label="Tools live" value={count(tools?.activeTools, props.unlocked)} />
              <MiniStat
                label="Awaiting approval"
                value={count(tools?.pendingApprovals, props.unlocked)}
                {...((tools?.pendingApprovals ?? 0) > 0 && props.unlocked ? { tone: "warn" as const } : {})}
              />
              <MiniStat
                label="Denied calls"
                value={count(tools?.deniedCalls, props.unlocked)}
                {...((tools?.deniedCalls ?? 0) > 0 && props.unlocked ? { tone: "bad" as const } : {})}
              />
              <MiniStat
                label="Failed calls"
                value={count(tools?.failedCalls, props.unlocked)}
                {...((tools?.failedCalls ?? 0) > 0 && props.unlocked ? { tone: "bad" as const } : {})}
              />
            </dl>
          </section>
        </div>
        </div>
      </div>
    </section>
  );
}
