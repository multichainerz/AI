import type { ChatMetrics, ConnectionMonitoringControl } from "@orcasynapse/contracts";
import type { ActiveView } from "./workspace-navigation.js";

export interface HomeLayer {
  key: "inference" | "agentic" | "access";
  name: string;
  role: string;
  mark: string;
  tone: string;
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
  passwordChangePending: boolean;
  healthyConnections: number;
  monitoring: ConnectionMonitoringControl | null;
  chatMetrics: ChatMetrics | null;
  layers: HomeLayer[];
  readiness: HomeReadinessCheck[];
  onSelect: (view: ActiveView, deploymentTab?: "journey" | "nodes" | "readiness") => void;
  onUnlock: () => void;
}

function cadence(seconds: number): string {
  if (seconds < 60) return `Checked every ${seconds} sec`;
  if (seconds < 3_600) return `Checked every ${Math.round(seconds / 60)} min`;
  return `Checked every ${Math.round(seconds / 3_600)} hr`;
}

function ShieldIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 20 5v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5l8-3Z" /></svg>;
}

export function HomeView(props: HomeViewProps) {
  const readyCount = props.readiness.filter(({ ready }) => ready).length;
  const allReady = readyCount === props.readiness.length;
  const next = props.readiness.find(({ ready }) => !ready);
  const open = (view: ActiveView) => props.unlocked ? props.onSelect(view) : props.onUnlock();

  return <>
    <header className="topbar">
      <div className="page-heading">
        <p className="page-kicker">OrcaSynapse control center</p>
        <h1>{allReady && props.unlocked ? "Your agentic workspace is ready" : "Finish your private AI workspace"}</h1>
        <p>{next && props.unlocked ? `Next: ${next.detail}` : "Chat with governed Hermes agents, add durable knowledge, and operate the complete on-prem system from one place."}</p>
      </div>
      <div className="topbar-actions">
        <span className={`status-chip ${props.apiAvailable ? "online" : "offline"}`}><i />{props.apiAvailable ? "Control plane online" : "Control plane offline"}</span>
        <button className="primary-button" type="button" onClick={() => props.onSelect(allReady ? "Chat" : next?.action ?? "Deployment")}>{allReady ? "Open Chat" : "Continue setup"}</button>
      </div>
    </header>

    <section className={`setup-banner ${props.bootstrapState.toLowerCase()}`}>
      <div className="banner-icon"><ShieldIcon /></div>
      <div>
        <strong>{props.bootstrapState === "READY" ? props.unlocked ? allReady ? "Workspace ready" : "Administrator workspace active" : props.passwordChangePending ? "Password change required" : "Local sign-in ready" : props.bootstrapState === "REQUIRED" ? "Installation required" : "Installation trust locked"}</strong>
        <p>{props.bootstrapState === "READY" ? props.unlocked ? `${readyCount} of ${props.readiness.length} required capabilities are ready.` : props.passwordChangePending ? "Replace the temporary password before opening administrative operations." : "Sign in to manage encrypted endpoints, agents, and knowledge." : "Run the protected VM1 installer before configuring services."}</p>
      </div>
      <button type="button" onClick={() => props.unlocked ? props.onSelect(next?.action ?? "Deployment") : props.onUnlock()}>{props.unlocked ? allReady ? "Review setup" : "Fix next step" : "Sign in"}</button>
    </section>

    <section className="metrics" aria-label="Platform summary">
      <article><span>Capability readiness</span><strong>{props.unlocked ? `${readyCount}/${props.readiness.length}` : "—"}</strong><small>{props.unlocked ? allReady ? "Chat and Knowledge are usable" : "One clear path remains" : "Sign in to verify"}</small></article>
      <article><span>Healthy services</span><strong>{props.unlocked ? props.healthyConnections : "—"}</strong><small>{props.monitoring?.enabled ? cadence(props.monitoring.intervalSeconds) : "Credential-aware validation"}</small></article>
      <article><span>Hermes responses</span><strong>{props.unlocked ? props.chatMetrics?.responses.toLocaleString() ?? "0" : "—"}</strong><small>Completed in the last 24 hours</small></article>
      <article><span>Policy posture</span><strong className="metric-posture">Default deny</strong><small>Explicit identity, Profile, and tool grants</small></article>
    </section>

    <div className="content-grid">
      <section className="panel connections-panel">
        <div className="panel-heading">
          <div><p className="section-kicker">Platform foundation</p><h2>Three operating layers</h2><p>Inference serves models, VM2 runs governed agents and memory, and Enterprise Access adds workforce identity when required.</p></div>
          <button className="text-button" type="button" onClick={() => props.onSelect("Deployment")}>Manage platform</button>
        </div>
        <div className="connection-list">
          {props.layers.map((layer) => <article className="connection connection-layer" key={layer.key}>
            <div className={`connection-mark ${layer.tone}`}>{layer.mark}</div>
            <div className="connection-copy">
              <strong>{layer.name}</strong><span>{layer.role}</span>
              {layer.components.length > 0 && <div className="connection-components">{layer.components.map((component) => <small key={component.name}><i className={component.tone} />{component.name}: {component.label}</small>)}</div>}
            </div>
            <span className={`connection-status ${layer.state.tone}`}><i />{layer.state.label}</span>
            <button type="button" onClick={() => props.unlocked ? props.onSelect("Deployment", layer.key === "agentic" ? "nodes" : "journey") : props.onUnlock()}>{props.unlocked ? layer.state.tone === "unconfigured" ? "Configure" : "Review" : "Sign in"}</button>
          </article>)}
        </div>
      </section>

      <section className="panel readiness-panel home-next-step">
        <div className="panel-heading"><div><p className="section-kicker">Usability, not connection count</p><h2>Required capabilities</h2><p>Chat becomes ready only when inference, an online VM2 runtime, execution policy, and an active Profile agree.</p></div><span className={`readiness-count ${!props.unlocked ? "restricted" : allReady ? "ready" : "pending"}`}>{props.unlocked ? `${readyCount}/${props.readiness.length} ready` : "Sign in to verify"}</span></div>
        <div className="readiness-list">
          {props.readiness.map((check) => <button type="button" key={check.label} onClick={() => open(check.action)}>
            <span className={`readiness-dot ${!props.unlocked ? "restricted" : check.ready ? "ready" : "pending"}`}><i /></span>
            <span><strong>{check.label}</strong><small>{props.unlocked ? check.detail : "Sign in to view current readiness"}</small></span>
            <span aria-hidden="true">→</span>
          </button>)}
        </div>
      </section>

      <section className="panel architecture-panel">
        <div className="panel-heading"><div><p className="section-kicker">Runtime trust boundary</p><h2>One governed execution path</h2><p>Every user message enters OrcaSynapse policy, runs through Hermes on VM2, and reaches only the approved inference route.</p></div><span className="phase-tag">Default deny</span></div>
        <ol className="runtime-flow">
          <li><span>1</span><div><strong>OrcaSynapse</strong><small>Identity, policy, audit, and orchestration</small></div></li>
          <li><span>2</span><div><strong>Hermes</strong><small>Isolated agent session and execution</small></div></li>
          <li><span>3</span><div><strong>Supermemory</strong><small>Durable local knowledge and memory</small></div></li>
          <li><span>4</span><div><strong>AI Inference</strong><small>Approved OpenAI-compatible model serving</small></div></li>
        </ol>
        <div className="boundary-note"><ShieldIcon /><div><strong>Secrets terminate at OrcaSynapse</strong><p>Hermes receives node-scoped runtime access; PostgreSQL and enterprise connector credentials remain on VM1.</p></div></div>
      </section>
    </div>
  </>;
}
