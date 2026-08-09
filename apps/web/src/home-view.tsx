import type {
  AgentMetrics,
  ChatMetrics,
  ConnectionMonitoringControl,
  DocumentMetrics,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { Button, HeroBanner, MicroLabel, PageHeader, Panel, PanelHeading, StatusText, Tile, cn, toneFor } from "./ui/index.js";
import { NodeIcon } from "./ui/relay-icons.js";
import type { ActiveView } from "./workspace-navigation.js";

/**
 * The landing screen, and the reference implementation for every view that
 * follows it onto the primitive set.
 *
 * It answers one question — can I use this workspace yet, and if not, what is
 * the single next thing to do — so everything on it is either a figure, a state,
 * or a way to act on one.
 */

export interface HomeLayer {
  key: "inference" | "agentic" | "access";
  name: string;
  role: string;
  mark: string;
  state: { label: string; tone: string };
  components: Array<{ name: string; label: string; tone: string }>;
}

export interface HomeReadinessCheck {
  label: string;
  detail: string;
  ready: boolean;
  action: ActiveView;
}

interface HomeViewProps {
  apiAvailable: boolean;
  bootstrapState: "LOCKED" | "REQUIRED" | "READY";
  unlocked: boolean;
  healthyConnections: number;
  monitoring: ConnectionMonitoringControl | null;
  chatMetrics: ChatMetrics | null;
  documentMetrics: DocumentMetrics | null;
  agentMetrics: AgentMetrics | null;
  toolMetrics: ToolMetrics | null;
  layers: HomeLayer[];
  readiness: HomeReadinessCheck[];
  onSelect: (view: ActiveView, deploymentTab?: "journey" | "nodes" | "readiness") => void;
  onUnlock: () => void;
}

/**
 * The window a usage figure covers, said in words.
 *
 * "1,284 conversations" is not a fact until you know over what -- an hour and a
 * quarter reads very differently from a quarter. The runtime reports
 * `windowStartedAt`, so the caption states it rather than the interface implying
 * a period it does not know.
 */
function since(startedAt: string): string {
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return "Over the reported window";
  return `Since ${started.toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
}

/** A figure the deployment has not produced yet is absent, never zero. */
function figure(value: number | null | undefined, unlocked: boolean): string {
  if (!unlocked || value === null || value === undefined) return "—";
  return value.toLocaleString();
}

function cadence(seconds: number): string {
  if (seconds < 60) return `Checked every ${seconds} sec`;
  if (seconds < 3_600) return `Checked every ${Math.round(seconds / 60)} min`;
  return `Checked every ${Math.round(seconds / 3_600)} hr`;
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
    >
      <path d="M12 2 20 5v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5l8-3Z" />
    </svg>
  );
}

/** The governed path a message takes. Fixed, and stated the same way every time. */
const RUNTIME_STEPS = [
  { name: "OrcaSynapse", detail: "Identity, policy, audit, and orchestration" },
  { name: "Hermes", detail: "Isolated agent session and execution" },
  { name: "Knowledge index", detail: "Local pgvector retrieval, owner-scoped" },
  { name: "AI Inference", detail: "Approved OpenAI-compatible model serving" },
] as const;

export function HomeView(props: HomeViewProps) {
  const readyCount = props.readiness.filter(({ ready }) => ready).length;
  const allReady = readyCount === props.readiness.length;
  const next = props.readiness.find(({ ready }) => !ready);
  const open = (view: ActiveView) => (props.unlocked ? props.onSelect(view) : props.onUnlock());

  /*
   * There is no password-change arm here any more. The shell hands a session
   * that still owes a password change straight to the front page, so Home is
   * only ever mounted once that flag is false — the arm was drawing a state
   * this screen cannot be in.
   */
  const bannerTitle = props.bootstrapState !== "READY"
    ? props.bootstrapState === "REQUIRED" ? "Installation required" : "Installation trust locked"
    : !props.unlocked
      ? "Local sign-in ready"
      : allReady ? "Workspace ready" : "Administrator workspace active";
  const bannerDetail = props.bootstrapState !== "READY"
    ? "Run the protected VM1 installer before configuring services."
    : !props.unlocked
      ? "Sign in to manage encrypted endpoints, agents, and knowledge."
      : `${readyCount} of ${props.readiness.length} required capabilities are ready.`;

  return (
    <>
      <PageHeader
        kicker="OrcaSynapse control center"
        title={allReady && props.unlocked ? "Your agentic workspace is ready" : "Finish your private AI workspace"}
        description={
          next && props.unlocked
            ? `Next: ${next.detail}`
            : "Chat with governed Hermes agents, add durable knowledge, and operate the complete on-prem system from one place."
        }
        actions={
          <>
            <StatusText dot tone={props.apiAvailable ? "good" : "bad"} className="h-9 items-center border border-border bg-surface px-3">
              {props.apiAvailable ? "Control plane online" : "Control plane offline"}
            </StatusText>
            <Button
              variant="primary"
              onClick={() => props.onSelect(allReady ? "Chat" : (next?.action ?? "Deployment"))}
            >
              {allReady ? "Open Session" : "Continue setup"}
            </Button>
          </>
        }
      />

      <Panel
        className={cn(
          "mb-6 flex items-center gap-4 border-l-2 p-4",
          props.bootstrapState === "READY" ? "border-l-accent" : "border-l-warn",
        )}
      >
        <ShieldIcon className="h-5 w-5 text-accent" />
        <div className="min-w-0 flex-1">
          <strong className="block text-label font-semibold text-text">{bannerTitle}</strong>
          <p className="mb-0 mt-1 text-body text-muted">{bannerDetail}</p>
        </div>
        {/*
          * The readiness fraction, which used to be the banner's headline.
          * Moving the banner to activity would have dropped it from the screen
          * altogether -- so it lands on the callout that already owns the
          * subject, where it is a figure beside its own sentence rather than
          * the loudest number on a page about something else.
          */}
        {props.unlocked && (
          <strong className="shrink-0 font-display text-figure font-semibold tabular-nums text-text">
            {readyCount}/{props.readiness.length}
          </strong>
        )}
        <Button
          onClick={() => (props.unlocked ? props.onSelect(next?.action ?? "Deployment") : props.onUnlock())}
        >
          {props.unlocked ? (allReady ? "Review setup" : "Fix next step") : "Sign in"}
        </Button>
      </Panel>

      {/*
        * What this deployment has actually done.
        *
        * The banner used to restate readiness, which the callout directly above
        * it already carries -- the same fraction twice, in the two loudest
        * places on the screen. Readiness answers "can I use this yet"; that
        * question is answered once, above. This answers the one after it.
        *
        * Every figure here is reported by the runtime. Nothing is derived from
        * a guess and nothing is invented: there is no user count in this
        * product, so there is no user count on this banner.
        */}
      <HeroBanner
        className="mb-4"
        aria-label="Deployment activity"
        highlight={{
          label: "Governed conversations",
          value: figure(props.chatMetrics?.conversations, props.unlocked),
          caption: props.unlocked
            ? props.chatMetrics ? since(props.chatMetrics.windowStartedAt) : "No runs reported yet"
            : "Sign in to see activity",
          /*
           * The bar is the share of responses that completed. It is drawn only
           * when there are responses to divide -- a full green bar over zero
           * work reads as "everything succeeded" when the truth is "nothing has
           * run".
           */
          fill: props.unlocked && props.chatMetrics && props.chatMetrics.responses > 0
            ? props.chatMetrics.completed / props.chatMetrics.responses
            : undefined,
          tone: props.unlocked && props.chatMetrics && props.chatMetrics.responses > 0
            ? props.chatMetrics.failureRate > 0.1 ? "warn" : "good"
            : undefined,
        }}
        metrics={[
          {
            label: "Responses",
            value: figure(props.chatMetrics?.responses, props.unlocked),
            caption: props.chatMetrics ? `${props.chatMetrics.completed.toLocaleString()} completed` : "Awaiting the first run",
          },
          {
            label: "Documents",
            value: figure(props.documentMetrics?.total, props.unlocked),
            caption: props.documentMetrics ? `${props.documentMetrics.ready.toLocaleString()} indexed` : "None uploaded yet",
          },
          {
            label: "Agent profiles",
            value: figure(props.agentMetrics?.profiles, props.unlocked),
            caption: props.agentMetrics ? `${props.agentMetrics.activeProfiles.toLocaleString()} active` : "None defined yet",
          },
          {
            label: "Tools allowed",
            value: figure(props.toolMetrics?.activeTools, props.unlocked),
            caption: props.toolMetrics ? `${props.toolMetrics.activeGrants.toLocaleString()} grants` : "Default deny",
          },
          {
            label: "Healthy services",
            value: props.unlocked ? props.healthyConnections : "—",
            caption: props.monitoring?.enabled ? cadence(props.monitoring.intervalSeconds) : "Credential-aware validation",
          },
        ]}
      />

      {/*
        * The design's ask surface, serving as the doorway into Chat: the whole
        * panel is one launcher, so the "input" is a button drawn in the ask
        * style rather than a field pretending a question could be answered
        * here. The shine sweep and suggestion chips come with it.
        */}
      <Panel className="relative mb-7 overflow-hidden p-5 sm:p-6">
        <span aria-hidden="true" className="anim-shine pointer-events-none absolute inset-y-0 w-2/5 bg-gradient-to-r from-transparent via-soft to-transparent" />
        <div className="relative flex flex-wrap items-center gap-4">
          <span className="flex shrink-0 items-center gap-2 text-micro font-semibold uppercase tracking-[0.08em] text-accent">
            <NodeIcon size={15} />
            Ask
          </span>
          <button
            type="button"
            className="min-w-[220px] flex-1 border-b-[1.5px] border-border pb-2 text-left text-[17px] tracking-[-0.01em] text-faint transition-colors hover:border-accent hover:text-muted"
            onClick={() => open("Chat")}
          >
            Ask about your documents, agents, and operations…
          </button>
          <Button variant="primary" className="shrink-0" onClick={() => open("Chat")}>
            Start a conversation
          </Button>
        </div>
        <div className="relative mt-3.5 flex flex-wrap items-center gap-2.5 sm:pl-[52px]">
          {["What changed in my knowledge sources this week?", "Which services need attention?", "Summarise the latest agent runs"].map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="rounded-pill border border-border px-3.5 py-1.5 text-caption text-muted transition-colors hover:border-accent hover:text-accent"
              onClick={() => open("Chat")}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </Panel>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
        <Panel>
          <PanelHeading
            kicker="Platform foundation"
            title="Three operating layers"
            description="Inference serves models, VM2 runs governed agents, and Enterprise Access adds workforce identity when required. Knowledge and agent memory stay on VM1."
            actions={<Button variant="ghost" size="sm" onClick={() => props.onSelect("Deployment")}>Manage platform</Button>}
          />
          <div className="grid gap-2">
            {props.layers.map((layer) => (
              <Tile as="article" className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3.5" key={layer.key}>
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 place-items-center rounded border border-border-strong bg-surface font-mono text-[10px] font-bold text-accent"
                >
                  {layer.mark}
                </span>
                <div className="min-w-0">
                  <strong className="block text-label font-semibold text-text">{layer.name}</strong>
                  <span className="mt-0.5 block text-caption text-muted">{layer.role}</span>
                  {layer.components.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {layer.components.map((component) => (
                        <StatusText dot key={component.name} tone={toneFor(component.tone)} className="normal-case">
                          {component.name}: {component.label}
                        </StatusText>
                      ))}
                    </div>
                  )}
                </div>
                <StatusText dot tone={toneFor(layer.state.tone)}>{layer.state.label}</StatusText>
                <Button
                  size="sm"
                  onClick={() =>
                    props.unlocked
                      ? props.onSelect("Deployment", layer.key === "agentic" ? "nodes" : "journey")
                      : props.onUnlock()
                  }
                >
                  {props.unlocked ? (layer.state.tone === "unconfigured" ? "Configure" : "Review") : "Sign in"}
                </Button>
              </Tile>
            ))}
          </div>
        </Panel>

        <Panel>
          <PanelHeading
            kicker="Usability, not connection count"
            title="Required capabilities"
            description="Chat becomes ready only when inference, an online VM2 runtime, execution policy, and an active Profile agree."
            actions={
              <StatusText tone={!props.unlocked ? "neutral" : allReady ? "good" : "warn"}>
                {props.unlocked ? `${readyCount}/${props.readiness.length} ready` : "Locked"}
              </StatusText>
            }
          />
          <div className="grid gap-2">
            {props.readiness.map((check) => (
              <button
                className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded border border-border bg-raised p-3 text-left text-text transition-colors hover:border-border-strong"
                key={check.label}
                type="button"
                onClick={() => open(check.action)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5",
                    !props.unlocked ? "bg-faint" : check.ready ? "bg-good" : "bg-warn",
                  )}
                />
                <span className="min-w-0">
                  <strong className="block text-label font-semibold">{check.label}</strong>
                  <small className="mt-1 block truncate text-caption text-muted">
                    {props.unlocked ? check.detail : "Sign in to view current readiness"}
                  </small>
                </span>
                <span aria-hidden="true" className="font-mono text-label text-faint">
                  →
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeading
            kicker="Runtime trust boundary"
            title="One governed execution path"
            description="Every user message enters OrcaSynapse policy, runs through Hermes on VM2, and reaches only the approved inference route."
            actions={<StatusText tone="accent">Default deny</StatusText>}
          />
          {/*
           * Hairlines come from the gap showing the container behind, so a step
           * needs no border of its own and the rules never double up at a seam.
           */}
          <ol className="m-0 grid list-none grid-cols-1 gap-px rounded border border-border bg-border p-0 sm:grid-cols-2 lg:grid-cols-4">
            {RUNTIME_STEPS.map((step, index) => (
              <li className="bg-surface p-3.5" key={step.name}>
                <MicroLabel className="block text-accent">{String(index + 1).padStart(2, "0")}</MicroLabel>
                <strong className="mt-2 block text-label font-semibold text-text">{step.name}</strong>
                <small className="mt-1 block text-caption text-muted">{step.detail}</small>
              </li>
            ))}
          </ol>
          <Tile className="mt-4 flex gap-3 p-3.5">
            <ShieldIcon className="mt-0.5 h-4 w-4 text-accent" />
            <div className="min-w-0">
              <strong className="block text-label font-semibold text-text">Secrets terminate at OrcaSynapse</strong>
              <p className="mb-0 mt-1 text-body text-muted">
                Hermes receives node-scoped runtime access; PostgreSQL and enterprise connector credentials remain on
                VM1.
              </p>
            </div>
          </Tile>
        </Panel>
      </div>
    </>
  );
}
