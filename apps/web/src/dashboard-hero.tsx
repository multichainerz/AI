import type {
  AgentMetrics,
  ChatMetrics,
  ConnectionMonitoringControl,
  DocumentMetrics,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { useEffect, useState } from "react";
import { cn } from "./ui/index.js";
import type { HomeLayer } from "./home-view.js";
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
  healthyConnections: number;
  chatMetrics: ChatMetrics | null;
  documentMetrics: DocumentMetrics | null;
  agentMetrics: AgentMetrics | null;
  toolMetrics: ToolMetrics | null;
  monitoring: ConnectionMonitoringControl | null;
  layers: HomeLayer[];
  onSelect: (view: ActiveView) => void;
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
  if (!unlocked || !startedAt) return "awaiting the first run";
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
    <div className="text-right">
      <strong
        className="block font-mono text-[30px] font-semibold leading-none tabular-nums text-white sm:text-[38px]"
        aria-label="Local time"
      >
        {two(now.getHours())}:{two(now.getMinutes())}:{two(now.getSeconds())}
      </strong>
      <span className="mt-1.5 block font-mono text-micro uppercase tracking-[0.22em] text-white/55">{offset}</span>
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
      live: documentsReady > 0,
    },
    {
      name: "AI Inference",
      role: "Approved model serving",
      state: inference?.label ?? "Unknown",
      live: inference?.tone === "ready",
    },
  ];
}

const ACTIONS: ReadonlyArray<{ label: string; detail: string; view: ActiveView }> = [
  { label: "Start a session", detail: "Ask a governed agent", view: "Chat" },
  { label: "Add knowledge", detail: "Upload and index documents", view: "Documents" },
  { label: "Agent profiles", detail: "Instructions, memory, tools", view: "Agents" },
  { label: "Platform setup", detail: "Runtimes, models, policy", view: "Deployment" },
];

export function DashboardHero(props: DashboardHeroProps) {
  const hops = topology(props);
  const intact = hops.every((hop) => hop.live);

  return (
    <section className="dashboard-hero" aria-label="Deployment command panel">
      <div className="relative isolate overflow-hidden py-7">
        <span aria-hidden="true" className="dashboard-hero-grid pointer-events-none absolute inset-0 -z-10" />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          {/* Identity and figures */}
          <div className="grid content-start gap-4">
            <div className="rounded-lg border border-white/10 bg-white/[0.045] p-5">
              <strong className="block font-display text-[19px] font-semibold tracking-[-0.02em] text-white">
                Private AI control plane
              </strong>
              <p className="mb-0 mt-1 text-caption leading-relaxed text-white/65">
                Every answer is a governed run inside this deployment. Nothing leaves it.
              </p>

              <div className="mt-4 grid grid-cols-2 gap-3">
                {[
                  {
                    value: count(props.chatMetrics?.conversations, props.unlocked),
                    label: "Sessions",
                    sub: since(props.chatMetrics?.windowStartedAt, props.unlocked),
                  },
                  {
                    value: count(props.documentMetrics?.total, props.unlocked),
                    label: "Documents",
                    sub: props.documentMetrics
                      ? `${props.documentMetrics.ready.toLocaleString()} indexed`
                      : "none uploaded",
                  },
                ].map((stat) => (
                  <div className="min-w-0 rounded border border-white/10 bg-white/[0.03] px-3.5 py-3" key={stat.label}>
                    <strong className="block font-display text-[30px] font-semibold leading-none tabular-nums text-white">
                      {stat.value}
                    </strong>
                    <span className="mt-1.5 block text-micro uppercase tracking-[0.14em] text-white/55">
                      {stat.label}
                    </span>
                    <span className="mt-1 block truncate text-micro text-white/60">{stat.sub}</span>
                  </div>
                ))}
              </div>

              <dl className="m-0 mt-3 grid grid-cols-2 gap-3">
                {[
                  {
                    label: "Responses",
                    value: count(props.chatMetrics?.responses, props.unlocked),
                    sub: props.chatMetrics ? `${props.chatMetrics.completed.toLocaleString()} completed` : "none yet",
                    /*
                     * The completed share, drawn.
                     *
                     * This is the one figure on the panel with a denominator,
                     * and it has been lost once already: moving Home onto
                     * `HeroBanner` in ai-v1.88.0 dropped the `fill` that drew it
                     * and every test stayed green. It is drawn only when there
                     * are responses to divide -- a full bar over zero work reads
                     * as "everything succeeded" where the truth is "nothing has
                     * run".
                     */
                    fill: props.unlocked && props.chatMetrics && props.chatMetrics.responses > 0
                      ? props.chatMetrics.completed / props.chatMetrics.responses
                      : undefined,
                    failing: (props.chatMetrics?.failureRate ?? 0) > 0.1,
                  },
                  {
                    label: "Agent profiles",
                    value: count(props.agentMetrics?.profiles, props.unlocked),
                    sub: props.agentMetrics ? `${props.agentMetrics.activeProfiles.toLocaleString()} active` : "none yet",
                  },
                  {
                    label: "Tools allowed",
                    value: count(props.toolMetrics?.activeTools, props.unlocked),
                    sub: props.toolMetrics ? `${props.toolMetrics.activeGrants.toLocaleString()} grants` : "default deny",
                  },
                  {
                    label: "Avg response",
                    value: latency(props.chatMetrics?.averageLatencyMs, props.unlocked),
                    sub: "end to end",
                  },
                ].map((stat) => (
                  <div className="min-w-0 rounded border border-white/[0.08] px-3 py-2.5" key={stat.label}>
                    <dt className="truncate text-micro uppercase tracking-[0.14em] text-white/55">{stat.label}</dt>
                    <dd className="m-0 mt-1 truncate font-display text-[17px] font-semibold tabular-nums text-white">
                      {stat.value}
                    </dd>
                    <dd className="m-0 mt-0.5 truncate text-micro text-white/60">{stat.sub}</dd>
                    {stat.fill === undefined ? null : (
                      <dd className="m-0">
                        <progress
                          className={cn("metric-progress mt-2 block h-0.5 w-full", stat.failing ? "is-warn" : "is-good")}
                          max={100}
                          value={Math.round(stat.fill * 100)}
                          aria-label="Share of responses that completed"
                        />
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </div>

            {/* The four things an operator comes here to start. */}
            <div className="grid grid-cols-2 gap-3">
              {ACTIONS.map((action) => (
                <button
                  type="button"
                  key={action.label}
                  onClick={() => props.onSelect(action.view)}
                  className="group grid content-start gap-1 rounded-lg border border-white/10 bg-white/[0.035] p-3.5 text-left transition-colors hover:border-white/25 hover:bg-white/[0.07]"
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="min-w-0 truncate text-caption font-semibold text-white">{action.label}</strong>
                    <span aria-hidden="true" className="shrink-0 text-white/40 transition-colors group-hover:text-white">
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4.2 9.8 9.8 4.2M5.2 4.2h4.6v4.6" />
                      </svg>
                    </span>
                  </span>
                  <span className="text-micro leading-relaxed text-white/55">{action.detail}</span>
                </button>
              ))}
            </div>
          </div>

          {/* The governed path, and the clock */}
          {/* A column, not a grid of rows: the assurance strip takes `mt-auto` so
              it sits on the panel's floor instead of leaving a void beneath the
              topology whenever the left column is the taller of the two. */}
          <div className="flex flex-col gap-5 rounded-lg border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="block text-micro uppercase tracking-[0.18em] text-white/55">Governed path</span>
                <strong className="mt-1.5 block font-display text-[19px] font-semibold tracking-[-0.02em] text-white">
                  {intact ? "Every hop is answering" : "The path is not complete"}
                </strong>
                <p className="mb-0 mt-1 max-w-[52ch] text-caption leading-relaxed text-white/65">
                  A question passes through all four. Any hop that is not answering is the reason Session cannot run.
                </p>
              </div>
              <Clock />
            </div>

            <ol className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-4">
              {hops.map((hop, index) => (
                <li
                  className={cn(
                    "relative grid content-start gap-1.5 rounded-lg border p-3.5",
                    hop.live ? "border-node/40 bg-node/[0.07]" : "border-white/10 bg-white/[0.02]",
                  )}
                  key={hop.name}
                >
                  {/* The connector, drawn between cards rather than under them,
                      so the sequence survives the grid wrapping to two rows. */}
                  {index > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute -left-3 top-1/2 hidden h-px w-3 bg-white/15 xl:block"
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

            <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-4 text-micro text-white/55">
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
          </div>
        </div>
      </div>
    </section>
  );
}
