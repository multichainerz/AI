import type {
  AgentMetrics,
  ChatMetrics,
  ConnectionMonitoringControl,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { DashboardHero } from "./dashboard-hero.js";
import type { SetupStepKey } from "./setup-steps.js";
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
  /**
   * The Setup step that repairs this capability, when Setup is the destination.
   *
   * It used to be a tab name (`journey`/`nodes`/`readiness`) belonging to a
   * three-block screen that no longer exists. The step keys are the wizard's
   * own, so a row here and the screen it opens cannot describe different things.
   */
  setupStep?: SetupStepKey;
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
  onSelect: (view: ActiveView, setupStep?: SetupStepKey) => void;
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

  /*
   * The masthead is gone, and with it the `title` and `detail` this computed.
   *
   * Both restated the panel directly beneath them — `detail` spelled out
   * "N of 3 required capabilities are ready. Next: <step>" while Required
   * capabilities already showed the fraction and marked that step NEXT. The
   * label on the primary action is the one string here that nothing else
   * carries, so it is the one that survives.
   */
  const primaryLabel = setupIncomplete
    ? "Open setup"
    : !props.unlocked
      ? "Sign in"
      : allReady ? "Open Session" : "Continue setup";

  const primaryAction = () => {
    if (setupIncomplete) {
      props.onSelect("Deployment", "inference");
    } else if (!props.unlocked) {
      props.onUnlock();
    } else if (allReady) {
      props.onSelect("Chat");
    } else if (next?.setupStep) {
      props.onSelect(next.action, next.setupStep);
    } else {
      props.onSelect(next?.action ?? "Deployment");
    }
  };

  return (
    <DashboardHero
      unlocked={props.unlocked}
      apiAvailable={props.apiAvailable}
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
