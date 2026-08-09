import type {
  AgentMetrics,
  ChatMetrics,
  ConnectionMonitoringControl,
  DocumentMetrics,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./ui/index.js";
import { GearIcon, MonitorIcon, RobotIcon, StorageIcon, SyncIcon, TerminalIcon } from "./ui/relay-icons.js";
import type { HomeLayer, HomeReadinessCheck } from "./home-view.js";
import type { ActiveView } from "./workspace-navigation.js";

/**
 * The Dashboard's command panel.
 *
 * Every other screen in this product is a page of cards. This is the one
 * surface that is meant to be looked at rather than read: a full-bleed dark
 * field carrying what the deployment is, what it has done, and whether the
 * governed path from a question to an answer is intact end to end.
 *
 * It draws only what the runtime reports. There is no map here because there is
 * no geography in an on-premise control plane -- the equivalent "territory" is
 * the four hops a message actually takes, which is what the topology draws, with
 * each hop's real state rather than a decorative one.
 *
 * Fixed dark in both themes, like the navigation rail: a command console that
 * turns near-white in light mode stops being one, and takes every foreground on
 * it below AA on the way.
 */

interface DashboardHeroProps {
  unlocked: boolean;
  apiAvailable: boolean;
  /** The page's own title, which this panel now carries. */
  title: string;
  detail: string;
  primaryLabel: string;
  onPrimary: () => void;
  onAsk: () => void;
  onUnlock: () => void;
  healthyConnections: number;
  chatMetrics: ChatMetrics | null;
  documentMetrics: DocumentMetrics | null;
  agentMetrics: AgentMetrics | null;
  toolMetrics: ToolMetrics | null;
  monitoring: ConnectionMonitoringControl | null;
  layers: HomeLayer[];
  readiness: HomeReadinessCheck[];
  onSelect: (view: ActiveView, deploymentTab?: "journey" | "nodes" | "readiness") => void;
}

interface DashboardMetric {
  label: string;
  icon: ReactNode;
  value: string;
  detail: string;
  fill?: number | undefined;
  failing?: boolean;
}

/** A figure the deployment has not produced yet is absent, never zero. */
function count(value: number | null | undefined, unlocked: boolean): string {
  if (!unlocked || value === null || value === undefined) return "—";
  return value.toLocaleString();
}

/**
 * The window a usage figure covers, said in words.
 *
 * "342 sessions" is not a fact until you know over what -- an hour and a quarter
 * reads very differently from a quarter. The runtime reports `windowStartedAt`,
 * so the caption states it rather than the panel implying a period it does not
 * know.
 */
function since(startedAt: string | undefined, unlocked: boolean): string {
  if (!unlocked) return "sign in to view";
  if (!startedAt) return "awaiting the first run";
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return "over the reported window";
  return `since ${started.toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
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
        className="font-mono text-[19px] font-semibold leading-none tabular-nums text-white sm:text-[21px]"
        aria-label="Local time"
      >
        {two(now.getHours())}:{two(now.getMinutes())}:{two(now.getSeconds())}
      </strong>
      <span className="font-mono text-micro uppercase tracking-[0.16em] text-white/55">{offset}</span>
    </div>
  );
}

/** The four hops a governed answer passes through, each with its real state. */
function topology(props: DashboardHeroProps) {
  const layerState = (key: HomeLayer["key"]) => props.layers.find((layer) => layer.key === key)?.state;
  const inference = layerState("inference");
  const agentic = layerState("agentic");
  const documentsReady = props.documentMetrics?.ready ?? 0;

  return [
    {
      name: "OrcaSynapse",
      role: "Identity, policy, audit",
      // The control plane is the thing rendering this panel. Reporting it as
      // anything but reachable would be a claim contradicted by its own arrival.
      state: "Serving",
      live: true,
    },
    {
      name: "Hermes",
      role: "Isolated agent session",
      state: agentic?.label ?? "Unknown",
      live: agentic?.tone === "ready",
    },
    {
      name: "Knowledge",
      role: "Owner-scoped retrieval",
      // A state, not a count. The Documents figure above already reports how
      // many are indexed; repeating it here says the same thing twice and stops
      // the hop from answering the question this row asks, which is whether
      // retrieval can serve anything at all.
      state: props.unlocked ? (documentsReady > 0 ? "Searchable" : "Empty index") : "Not readable",
      live: props.unlocked && documentsReady > 0,
    },
    {
      name: "AI Inference",
      role: "Approved model serving",
      state: inference?.label ?? "Unknown",
      live: inference?.tone === "ready",
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

        {[
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
        ].map(([cx, cy, tone, halo, core]) => (
          <g className={`dashboard-synapse__node dashboard-synapse__node--${tone}`} key={`${cx}-${cy}`}>
            {tone === "hub" && <circle className="dashboard-synapse__node-ring" cx={cx} cy={cy} r={Number(halo) + 9} />}
            <circle className="dashboard-synapse__node-halo" cx={cx} cy={cy} r={halo} />
            <circle className="dashboard-synapse__node-core" cx={cx} cy={cy} r={core} />
          </g>
        ))}
      </g>
    </svg>
  );
}

export function DashboardHero(props: DashboardHeroProps) {
  const hops = topology(props);
  const intact = hops.every((hop) => hop.live);
  const readyCount = props.readiness.filter(({ ready }) => ready).length;
  const nextIndex = props.unlocked ? props.readiness.findIndex(({ ready }) => !ready) : -1;
  const metrics: DashboardMetric[] = [
    {
      label: "Sessions",
      icon: <TerminalIcon size={14} />,
      value: count(props.chatMetrics?.conversations, props.unlocked),
      detail: since(props.chatMetrics?.windowStartedAt, props.unlocked),
    },
    {
      label: "Documents",
      icon: <StorageIcon size={14} />,
      value: count(props.documentMetrics?.total, props.unlocked),
      detail: protectedDetail(
        props.unlocked,
        props.documentMetrics ? `${props.documentMetrics.ready.toLocaleString()} indexed` : undefined,
        "none uploaded",
      ),
    },
    {
      label: "Responses",
      icon: <SyncIcon size={14} />,
      value: count(props.chatMetrics?.responses, props.unlocked),
      detail: protectedDetail(
        props.unlocked,
        props.chatMetrics ? `${props.chatMetrics.completed.toLocaleString()} completed` : undefined,
        "none yet",
      ),
      fill: props.unlocked && props.chatMetrics && props.chatMetrics.responses > 0
        ? props.chatMetrics.completed / props.chatMetrics.responses
        : undefined,
      failing: (props.chatMetrics?.failureRate ?? 0) > 0.1,
    },
    {
      label: "Agent profiles",
      icon: <RobotIcon size={14} />,
      value: count(props.agentMetrics?.profiles, props.unlocked),
      detail: protectedDetail(
        props.unlocked,
        props.agentMetrics ? `${props.agentMetrics.activeProfiles.toLocaleString()} active` : undefined,
        "none yet",
      ),
    },
    {
      label: "Tools allowed",
      icon: <GearIcon size={14} />,
      value: count(props.toolMetrics?.activeTools, props.unlocked),
      detail: protectedDetail(
        props.unlocked,
        props.toolMetrics ? `${props.toolMetrics.activeGrants.toLocaleString()} grants` : undefined,
        "default deny",
      ),
    },
    {
      label: "Avg response",
      icon: <MonitorIcon size={14} />,
      value: latency(props.chatMetrics?.averageLatencyMs, props.unlocked),
      detail: props.unlocked ? "end to end" : "sign in to view",
    },
  ];
  const openReadiness = (check: HomeReadinessCheck) => {
    if (!props.unlocked) {
      props.onUnlock();
    } else if (check.deploymentTab) {
      props.onSelect(check.action, check.deploymentTab);
    } else {
      props.onSelect(check.action);
    }
  };

  return (
    <section className="dashboard-hero" aria-label="Deployment command panel">
      <div className="dashboard-hero__inner relative isolate overflow-hidden py-5">
        <div className="dashboard-hero__content relative z-[1] grid gap-3.5">

        {/*
          * The masthead, absorbed.
          *
          * It was a separate `PageHeader` above the panel -- a strip of title
          * and buttons on the page background, so the screen opened with a band
          * of chrome and only then reached the thing worth looking at. Inside,
          * it is the panel's own first line and the field runs behind it.
          */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 max-w-[72ch]">
            <span className="block text-micro uppercase tracking-[0.18em] text-white/55">
              OrcaSynapse control center
            </span>
            <h1 className="m-0 mt-1.5 font-display text-[25px] font-semibold leading-[1.12] tracking-[-0.025em] text-white sm:text-[29px]">
              {props.title}
            </h1>
            <p className="mb-0 mt-1.5 max-w-[72ch] text-caption leading-relaxed text-white/60">{props.detail}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2.5">
            <span className="flex items-center gap-2 rounded-pill border border-white/15 bg-white/[0.06] px-3 py-1.5 text-micro uppercase tracking-[0.12em] text-white/75">
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 rounded-pill", props.apiAvailable ? "bg-node" : "bg-bad")}
              />
              {props.apiAvailable ? "Control plane online" : "Control plane offline"}
            </span>
            <button
              type="button"
              onClick={props.onPrimary}
              className="rounded-pill bg-white px-4 py-2 text-caption font-semibold text-[#2B1364] transition-colors hover:bg-white/90"
            >
              {props.primaryLabel}
            </button>
          </div>
        </div>

        {/*
          * The launch bar.
          *
          * It was a card below the panel, which made starting a session
          * something you did *after* reading the console rather than the thing
          * the console is for. It is a button drawn as a field, not an input:
          * nothing typed here could be answered here, and a real input would
          * promise otherwise.
          */}
        <div className="rounded-lg border border-white/12 bg-white/[0.05] p-3.5">
          <div className="flex flex-wrap items-center gap-3.5">
            {/* Session's own icon, the one the rail uses, rather than a generic
                node glyph beside the word "ASK" — the placeholder already says
                what the row is for, so the label was the caption on a caption. */}
            <span
              aria-hidden="true"
              className="flex shrink-0 text-white/60 [&_.fill-node]:fill-current [&_.stroke-node]:stroke-current"
            >
              <TerminalIcon size={19} />
            </span>
            <button
              type="button"
              onClick={props.onAsk}
              className="min-w-[220px] flex-1 border-b-[1.5px] border-white/20 pb-2 text-left text-[17px] tracking-[-0.01em] text-white/65 transition-colors hover:border-node hover:text-white/80"
            >
              Ask about your documents, agents, and operations…
            </button>
            <button
              type="button"
              onClick={props.onAsk}
              className="shrink-0 rounded-pill bg-accent-fill px-4 py-2 text-caption font-semibold text-white transition-colors hover:bg-accent-strong hover:text-[#2B1364]"
            >
              Start a session
            </button>
          </div>
        </div>

        <dl
          aria-label="Operational activity"
          className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 sm:grid-cols-3 xl:grid-cols-6"
        >
          {metrics.map((metric) => (
            <div className="min-w-0 bg-[#2B1364]/90 px-3 py-2.5" key={metric.label}>
              <dt className="flex items-center gap-1.5 truncate text-micro uppercase tracking-[0.13em] text-white/55">
                <span aria-hidden="true" className="flex shrink-0 [&_.fill-node]:fill-current [&_.stroke-node]:stroke-current">
                  {metric.icon}
                </span>
                <span className="truncate">{metric.label}</span>
              </dt>
              <dd className="m-0 mt-1 truncate font-display text-[21px] font-semibold leading-none tabular-nums text-white">
                {metric.value}
              </dd>
              <dd className="m-0 mt-1 truncate text-micro text-white/60">{metric.detail}</dd>
              {metric.fill === undefined ? null : (
                <dd className="m-0">
                  <progress
                    className={cn("metric-progress mt-1.5 block h-0.5 w-full", metric.failing ? "is-warn" : "is-good")}
                    max={100}
                    value={Math.round(metric.fill * 100)}
                    aria-label="Share of responses that completed"
                  />
                </dd>
              )}
            </div>
          ))}
        </dl>

        <div className="dashboard-hero__operations grid min-h-0 gap-3.5 xl:grid-cols-[minmax(280px,0.82fr)_minmax(0,1.58fr)]">
          <section className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.035] p-4" aria-labelledby="dashboard-readiness-title">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="block text-micro uppercase tracking-[0.18em] text-white/55">Workspace readiness</span>
                <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-white" id="dashboard-readiness-title">
                  Required capabilities
                </h2>
              </div>
              <strong className="rounded-pill border border-white/12 bg-white/[0.05] px-2.5 py-1 font-mono text-micro font-semibold tabular-nums text-white/75">
                {props.unlocked ? `${readyCount}/${props.readiness.length} ready` : "Locked"}
              </strong>
            </div>

            <div className="mt-3 grid gap-2">
              {props.readiness.map((check, index) => {
                const isNext = index === nextIndex;
                return (
                  <button
                    className={cn(
                      "grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded border px-3 py-2 text-left transition-colors",
                      isNext
                        ? "border-node/35 bg-node/[0.07] hover:border-node/60"
                        : "border-white/10 bg-black/10 hover:border-white/25",
                    )}
                    key={check.label}
                    type="button"
                    onClick={() => openReadiness(check)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1.5 w-1.5 rounded-pill",
                        !props.unlocked ? "bg-white/30" : check.ready ? "bg-node" : "bg-white/35",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-caption font-semibold text-white">{check.label}</strong>
                        {isNext && <span className="text-micro uppercase tracking-[0.12em] text-node">Next</span>}
                      </span>
                      <small className="mt-0.5 block text-micro leading-snug text-white/55">
                        {props.unlocked ? check.detail : "Sign in to inspect readiness"}
                      </small>
                    </span>
                    <span aria-hidden="true" className="font-mono text-caption text-white/40">→</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* The governed path, and the clock */}
          {/* A column, not a grid of rows: the assurance strip takes `mt-auto` so
              it sits on the panel's floor instead of leaving a void beneath the
              topology whenever the left column is the taller of the two. */}
          <section className="flex min-h-0 flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4" aria-labelledby="dashboard-path-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-micro uppercase tracking-[0.18em] text-white/55">Governed path</span>
                <h2 className="m-0 mt-1 font-display text-[17px] font-semibold tracking-[-0.02em] text-white" id="dashboard-path-title">
                  {intact ? "Every hop is answering" : "The path is not complete"}
                </h2>
              </div>
              <Clock />
            </div>

            <ol className="m-0 grid list-none gap-2.5 p-0 sm:grid-cols-2 xl:grid-cols-4">
              {hops.map((hop, index) => (
                <li
                  className={cn(
                    "relative grid content-start gap-1.5 rounded-lg border p-3",
                    hop.live ? "border-node/40 bg-node/[0.07]" : "border-white/10 bg-white/[0.02]",
                  )}
                  key={hop.name}
                >
                  {/* The connector, drawn between cards rather than under them,
                      so the sequence survives the grid wrapping to two rows. */}
                  {index > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute -left-2.5 top-1/2 hidden h-px w-2.5 bg-white/15 xl:block"
                    />
                  )}
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn("h-1.5 w-1.5 shrink-0 rounded-pill", hop.live ? "bg-node" : "bg-white/30")}
                    />
                    <strong className="min-w-0 truncate text-caption font-semibold text-white">{hop.name}</strong>
                  </span>
                  <span className="block text-micro leading-relaxed text-white/55">{hop.role}</span>
                  <span
                    className={cn(
                      "mt-0.5 block truncate text-micro font-semibold",
                      hop.live ? "text-node" : "text-white/70",
                    )}
                  >
                    {hop.state}
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/10 pt-3 text-micro text-white/55">
              <span>
                <strong className="font-semibold tabular-nums text-white/85">
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
        </div>
        </div>
      </div>
    </section>
  );
}
