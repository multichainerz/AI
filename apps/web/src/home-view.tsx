import type {
  AgentMetrics,
  ChatMetrics,
  ConnectionMonitoringControl,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { DashboardHero } from "./dashboard-hero.js";
import type { ActiveView } from "./workspace-navigation.js";

/** The compact deployment state the Dashboard uses to derive its live path. */
export interface HomeLayer {
  key: "inference" | "agentic" | "access";
  name: string;
  role: string;
  mark: string;
  state: { label: string; tone: string };
  components: Array<{ name: string; label: string; tone: string }>;
}

/** A capability and the exact workspace destination that can repair it. */
export interface HomeReadinessCheck {
  label: string;
  detail: string;
  ready: boolean;
  action: ActiveView;
  deploymentTab?: "journey" | "nodes" | "readiness";
}

interface HomeViewProps {
  apiAvailable: boolean;
  bootstrapState: "LOCKED" | "REQUIRED" | "READY";
  unlocked: boolean;
  healthyConnections: number;
  monitoring: ConnectionMonitoringControl | null;
  chatMetrics: ChatMetrics | null;
  agentMetrics: AgentMetrics | null;
  toolMetrics: ToolMetrics | null;
  layers: HomeLayer[];
  readiness: HomeReadinessCheck[];
  onSelect: (view: ActiveView, deploymentTab?: "journey" | "nodes" | "readiness") => void;
  onUnlock: () => void;
}

/**
 * The Dashboard is a single command surface. Home owns policy and routing;
 * DashboardHero owns the dense, fixed-dark presentation.
 */
export function HomeView(props: HomeViewProps) {
  const readyCount = props.readiness.filter(({ ready }) => ready).length;
  const allReady = readyCount === props.readiness.length;
  const next = props.readiness.find(({ ready }) => !ready);
  const setupIncomplete = props.bootstrapState !== "READY";

  const title = setupIncomplete
    ? props.bootstrapState === "REQUIRED" ? "Installation required" : "Installation trust locked"
    : !props.unlocked
      ? "Local sign-in ready"
      : allReady ? "Your agentic workspace is ready" : "Finish your private AI workspace";
  const detail = setupIncomplete
    ? "Run the protected VM1 installer before configuring services."
    : !props.unlocked
      ? "Sign in to manage encrypted endpoints, agents, and policy."
      : allReady
        ? "Every required capability is ready for governed sessions."
        : `${readyCount} of ${props.readiness.length} required capabilities are ready${next ? `. Next: ${next.detail}.` : "."}`;
  const primaryLabel = setupIncomplete
    ? "Open setup"
    : !props.unlocked
      ? "Sign in"
      : allReady ? "Open Session" : "Continue setup";

  const primaryAction = () => {
    if (setupIncomplete) {
      props.onSelect("Deployment", "journey");
    } else if (!props.unlocked) {
      props.onUnlock();
    } else if (allReady) {
      props.onSelect("Chat");
    } else if (next?.deploymentTab) {
      props.onSelect(next.action, next.deploymentTab);
    } else {
      props.onSelect(next?.action ?? "Deployment");
    }
  };

  return (
    <DashboardHero
      unlocked={props.unlocked}
      apiAvailable={props.apiAvailable}
      title={title}
      detail={detail}
      primaryLabel={primaryLabel}
      onPrimary={primaryAction}
      onAsk={() => (props.unlocked ? props.onSelect("Chat") : props.onUnlock())}
      onUnlock={props.onUnlock}
      healthyConnections={props.healthyConnections}
      chatMetrics={props.chatMetrics}
      agentMetrics={props.agentMetrics}
      toolMetrics={props.toolMetrics}
      monitoring={props.monitoring}
      layers={props.layers}
      readiness={props.readiness}
      onSelect={props.onSelect}
    />
  );
}
