import type {
  AgentMetrics,
  AgentRun,
  ChatMetrics,
  ConnectionMonitoringControl,
  HermesRuntimeNode,
  OperationalIncident,
  ToolMetrics,
  UsageReport,
  UsageWindow,
} from "@orcasynapse/contracts";
import { useEffect, useState } from "react";
import { getAgentRuns, getGatewayUsage, getOperationalIncidents } from "./api.js";
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
  runtimeNodes: HermesRuntimeNode[];
  layers: HomeLayer[];
  readiness: HomeReadinessCheck[];
  onSelect: (view: ActiveView, setupStep?: SetupStepKey) => void;
  onUnlock: () => void;
}

/**
 * The reads only the Dashboard makes, on the Dashboard's own clock.
 *
 * The 15-second reconciler in `app.tsx` carries what several screens share:
 * connections, runtime, profiles, nodes, the three metric scalars. The trend
 * report, the session list and the incident list are drawn by this one screen,
 * so they are fetched here — mounting the Dashboard starts the polls and
 * leaving it stops them, instead of taxing every other screen with reads it
 * will never render.
 *
 * Failures keep the last good report rather than blanking it: a poll that
 * loses one round against a busy API should not turn a chart into an empty
 * state that claims nothing ran. Locking clears everything, because holding
 * one operator's figures to show the next is how the metrics used to leak.
 */
function useDashboardData(unlocked: boolean, period: UsageWindow) {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [incidents, setIncidents] = useState<OperationalIncident[] | null>(null);

  useEffect(() => {
    if (!unlocked) {
      setUsage(null);
      return;
    }
    let active = true;
    const read = () => {
      void getGatewayUsage(period)
        .then((report) => {
          if (active) setUsage(report);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [unlocked, period]);

  useEffect(() => {
    if (!unlocked) {
      setRuns(null);
      setIncidents(null);
      return;
    }
    let active = true;
    const read = () => {
      void getAgentRuns(true)
        .then((list) => {
          if (active) setRuns(list.items);
        })
        .catch(() => undefined);
      void getOperationalIncidents()
        .then((list) => {
          if (active) setIncidents(list.items);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [unlocked]);

  return { usage, runs, incidents };
}

/**
 * The Dashboard is a single command surface. Home owns policy, routing and the
 * screen's own data; DashboardHero owns the dense, fixed presentation.
 */
export function HomeView(props: HomeViewProps) {
  const readyCount = props.readiness.filter(({ ready }) => ready).length;
  const allReady = readyCount === props.readiness.length;
  const next = props.readiness.find(({ ready }) => !ready);
  const setupIncomplete = props.bootstrapState !== "READY";

  /*
   * The trend window is the Dashboard's one piece of view state. It scopes the
   * Activity panel alone — the KPI strip stays pinned to the last 24 hours, so
   * switching the chart to a week never silently re-scopes six other figures.
   */
  const [period, setPeriod] = useState<UsageWindow>("24h");
  const { usage, runs, incidents } = useDashboardData(props.unlocked, period);

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
      bootstrapState={props.bootstrapState}
      primaryLabel={primaryLabel}
      onPrimary={primaryAction}
      onAsk={() => (props.unlocked ? props.onSelect("Chat") : props.onUnlock())}
      onUnlock={props.onUnlock}
      healthyConnections={props.healthyConnections}
      chatMetrics={props.chatMetrics}
      agentMetrics={props.agentMetrics}
      toolMetrics={props.toolMetrics}
      monitoring={props.monitoring}
      runtimeNodes={props.runtimeNodes}
      layers={props.layers}
      readiness={props.readiness}
      usage={usage}
      period={period}
      onPeriod={setPeriod}
      runs={runs}
      incidents={incidents}
      onSelect={props.onSelect}
    />
  );
}
