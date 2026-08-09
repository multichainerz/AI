import type {
  AgentMetrics,
  ChatMetrics,
  ConnectionMonitoringControl,
  DocumentMetrics,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { Button, MicroLabel, Panel, PanelHeading, StatusText, Tile, cn, toneFor } from "./ui/index.js";
import { DashboardHero } from "./dashboard-hero.js";
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
      {/*
        * The command panel, full-bleed and first.
        *
        * What stood here was a KPI strip in a card -- the same shape as every
        * other row on the page, so the screen an operator lands on looked like
        * a report rather than a console. This is the one surface meant to be
        * looked at rather than read.
        */}
      <DashboardHero
        unlocked={props.unlocked}
        apiAvailable={props.apiAvailable}
        title={allReady && props.unlocked ? "Your agentic workspace is ready" : "Finish your private AI workspace"}
        nextStep={
          next && props.unlocked
            ? `Next: ${next.detail}`
            : "Ask governed Hermes agents, add durable knowledge, and operate the complete on-prem system from one place."
        }
        primaryLabel={allReady ? "Open Session" : "Continue setup"}
        onPrimary={() => props.onSelect(allReady ? "Chat" : (next?.action ?? "Deployment"))}
        onAsk={() => open("Chat")}
        healthyConnections={props.healthyConnections}
        chatMetrics={props.chatMetrics}
        documentMetrics={props.documentMetrics}
        agentMetrics={props.agentMetrics}
        toolMetrics={props.toolMetrics}
        monitoring={props.monitoring}
        layers={props.layers}
        onSelect={props.onSelect}
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
