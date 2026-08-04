import type {
  AgentProfile,
  DeploymentTopologyMode,
  OnboardingTargetEnvironment,
  AgentRuntimeControl,
  HermesRuntimeNode,
  OnboardingSnapshot,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  completeOnboarding,
  exportCredentialRecoveryKit,
  getOnboardingSnapshot,
  updateArchitectureDecision,
  verifyCredentialRecoveryKit,
} from "./api.js";
import { connectionReadiness } from "./connection-readiness.js";
import { connectionFor, deriveWorkspaceReadiness } from "./platform-readiness.js";
import { RuntimeNodesPanel } from "./runtime-nodes-panel.js";

interface OnboardingViewProps {
  unlocked: boolean;
  oidcConfigured: boolean;
  connections: ServiceConnectionSummary[];
  agentRuntime: AgentRuntimeControl | null;
  profiles: AgentProfile[];
  runtimeNodes: HermesRuntimeNode[];
  initialTab?: "journey" | "nodes" | "readiness";
  onConfigure: (kind?: ServiceKind) => void;
  onOpenWorkspace: (workspace: "Chat" | "Documents" | "Agents") => void;
  onOpenOperations: () => void;
  onRuntimeNodesChange: (nodes: HermesRuntimeNode[]) => void;
  onSignIn: () => void;
  onUnauthorized: () => void;
}

type SetupPanel = "overview" | "nodes";

function downloadRecoveryKit(fileName: string, serializedKit: string): void {
  const url = URL.createObjectURL(new Blob([serializedKit], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function OnboardingView({
  connections,
  agentRuntime,
  profiles,
  runtimeNodes,
  unlocked,
  oidcConfigured,
  initialTab = "journey",
  onConfigure,
  onOpenWorkspace,
  onOpenOperations,
  onRuntimeNodesChange,
  onSignIn,
  onUnauthorized,
}: OnboardingViewProps) {
  const [panel, setPanel] = useState<SetupPanel>(initialTab === "nodes" ? "nodes" : "overview");
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryOwner, setRecoveryOwner] = useState("");
  const [recoveryPassphrase, setRecoveryPassphrase] = useState("");
  const [recoveryConfirm, setRecoveryConfirm] = useState("");
  const [recoveryKit, setRecoveryKit] = useState("");
  const [recoveryFileName, setRecoveryFileName] = useState("");
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [topologyMode, setTopologyMode] = useState<DeploymentTopologyMode>("COMPACT");
  const [targetEnvironment, setTargetEnvironment] = useState<OnboardingTargetEnvironment>("DEVELOPMENT");
  const [architectureReason, setArchitectureReason] = useState("");
  const [activationReason, setActivationReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPanel(initialTab === "nodes" ? "nodes" : "overview");
    if (initialTab === "readiness") onOpenOperations();
  // The route token is the source of truth here. Callback identity can change
  // during App refreshes and must not reset an operator who is enrolling VM2.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  useEffect(() => {
    if (!unlocked) {
      setSnapshot(null);
      return;
    }
    let active = true;
    void getOnboardingSnapshot().then((next) => {
      if (!active) return;
      setSnapshot(next);
      setRecoveryOwner(next.recovery.recoveryOwner ?? "");
    }).catch((cause: unknown) => {
      if (!active) return;
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof Error ? cause.message : "Platform setup could not be loaded.");
    });
    return () => { active = false; };
  }, [onUnauthorized, unlocked]);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
      setError(cause instanceof Error ? cause.message : "Platform setup could not be updated.");
    } finally {
      setBusy(null);
    }
  };

  const exportRecovery = async (event: FormEvent) => {
    event.preventDefault();
    if (!snapshot || recoveryPassphrase !== recoveryConfirm) return;
    await run("recovery-export", async () => {
      const exported = await exportCredentialRecoveryKit({
        recoveryOwner: recoveryOwner.trim(),
        passphrase: recoveryPassphrase,
        expectedRevision: snapshot.recovery.revision,
      });
      downloadRecoveryKit(exported.fileName, exported.serializedKit);
      setRecoveryFileName(exported.fileName);
      setRecoveryKit("");
      setRecoveryPassphrase("");
      setRecoveryConfirm("");
      setSnapshot(await getOnboardingSnapshot());
    });
  };

  const verifyRecovery = async () => {
    if (!snapshot) return;
    await run("recovery-verify", async () => {
      setSnapshot(await verifyCredentialRecoveryKit({
        serializedKit: recoveryKit,
        passphrase: recoveryPassphrase,
        expectedRevision: snapshot.recovery.revision,
      }));
      setRecoveryPassphrase("");
      setRecoveryKit("");
      setRecoveryFileName("");
      setRecoveryOpen(false);
    });
  };

  useEffect(() => {
    if (!snapshot) return;
    setTopologyMode(snapshot.architecture.topologyMode);
    setTargetEnvironment(snapshot.architecture.targetEnvironment);
    setArchitectureReason(snapshot.architecture.reason ?? "");
  }, [snapshot?.architecture.revision]);

  const saveArchitecture = async (event: FormEvent) => {
    event.preventDefault();
    if (!snapshot) return;
    setBusy("architecture");
    try {
      await updateArchitectureDecision({
        topologyMode,
        targetEnvironment,
        reason: architectureReason.trim(),
        expectedRevision: snapshot.architecture.revision,
      });
      // Changing topology or target invalidates every contract, so reload the
      // whole snapshot rather than patching the decision in place.
      setSnapshot(await getOnboardingSnapshot());
      setArchitectureOpen(false);
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof Error ? cause.message : "Unable to save the architecture decision.");
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    if (!snapshot) return;
    setBusy("activate");
    try {
      setSnapshot(await completeOnboarding({
        reason: activationReason.trim(),
        expectedRevision: snapshot.journey.revision,
      }));
      setActivationReason("");
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof Error ? cause.message : "Unable to record activation.");
    } finally {
      setBusy(null);
    }
  };

  const selectRecoveryFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 16_384) {
      setError("Recovery kit exceeds the supported size.");
      return;
    }
    setRecoveryFileName(file.name);
    setRecoveryKit(await file.text());
  };

  if (!unlocked) {
    return <section className="setup-locked">
      <div className="setup-lock-symbol" aria-hidden="true">01</div>
      <p className="page-kicker">Administrator access</p>
      <h1>Sign in to this OrcaSynapse installation</h1>
      <p>Use the local administrator account created by the installer. Keep the separate Installation Key offline for recovery only.</p>
      <div className="setup-lock-actions">
        {oidcConfigured && <button className="primary-button" type="button" onClick={onSignIn}>Sign in with enterprise identity</button>}
        <button className={oidcConfigured ? "secondary-button" : "primary-button"} type="button" onClick={() => onConfigure()}>Sign in locally</button>
      </div>
    </section>;
  }

  const inference = connectionFor(connections, "INFERENCE");
  const hermes = connectionFor(connections, "HERMES");
  const memory = connectionFor(connections, "SUPERMEMORY");
  const readiness = deriveWorkspaceReadiness({ connections, runtimeNodes, profiles, runtime: agentRuntime });
  const {
    inferenceReady,
    knowledgeReady: memoryReady,
    runtimeNodeReady: nodeReady,
    executionReady,
    agenticInfrastructureReady,
    agenticReady,
  } = readiness;
  const readyCoreLayers = Number(inferenceReady) + Number(agenticReady);

  if (panel === "nodes") {
    return <section className="setup-workspace platform-setup">
      <header className="platform-setup-header">
        <div>
          <p className="page-kicker">Platform · Agentic System</p>
          <h1>Enroll the isolated agent runtime</h1>
          <p>The VM2 installer provisions Hermes, Supermemory, managed policy, and signed monitoring as one controlled layer.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setPanel("overview")}>Back to setup</button>
      </header>
      {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      <RuntimeNodesPanel
        targetEnvironment={snapshot?.architecture.targetEnvironment ?? "DEVELOPMENT"}
        inferenceReady={inferenceReady}
        onConfigureInference={() => onConfigure("INFERENCE")}
        onNodesChange={onRuntimeNodesChange}
        onUnauthorized={onUnauthorized}
      />
    </section>;
  }

  const stages = [
    {
      number: "01",
      title: "AI Inference",
      description: "Connect the approved OpenAI-compatible model server used by OrcaSynapse and Hermes.",
      detail: inference?.baseUrl ?? "vLLM, llama.cpp, SGLang, Ollama, TGI, or another compatible endpoint.",
      readiness: connectionReadiness(inference),
      action: () => onConfigure("INFERENCE"),
      actionLabel: inference ? "Manage inference" : "Connect inference",
    },
    {
      number: "02",
      title: "Agentic System",
      description: "Enroll one isolated Ubuntu VM containing Hermes and its local Supermemory brain.",
      detail: hermes || memory
        ? `Hermes: ${connectionReadiness(hermes).label} · Knowledge: ${connectionReadiness(memory).label} · VM2: ${nodeReady ? "Online" : "Not online"} · Profile: ${executionReady ? "Active" : "Needs activation"}`
        : "One generated command installs and binds the complete VM2 runtime.",
      readiness: agenticReady
        ? { label: "Ready", tone: "ready" as const }
        : hermes || memory
          ? { label: "Needs attention", tone: "degraded" as const }
          : { label: "Not configured", tone: "neutral" as const },
      action: () => !inferenceReady ? onConfigure("INFERENCE") : agenticInfrastructureReady ? executionReady ? setPanel("nodes") : onOpenWorkspace("Agents") : setPanel("nodes"),
      actionLabel: !inferenceReady ? "Set up inference first" : agenticInfrastructureReady ? executionReady ? "Manage runtime" : "Activate an Agent Profile" : "Enroll VM2",
    },
    {
      number: "03",
      title: "Enterprise Access",
      description: "Add OIDC or Microsoft Entra ID when employees are ready to use the workspace.",
      detail: oidcConfigured ? "Enterprise sign-in is configured." : "Optional for local evaluation; required before multi-user rollout.",
      readiness: oidcConfigured
        ? { label: "Ready", tone: "ready" as const }
        : { label: "Optional", tone: "neutral" as const },
      action: () => onConfigure("OIDC"),
      actionLabel: oidcConfigured ? "Manage access" : "Configure later",
      optional: true,
    },
  ];

  return <section className="setup-workspace platform-setup">
    <header className="platform-setup-header">
      <div>
        <p className="page-kicker">Platform setup</p>
        <h1>Three layers. One usable AI workspace.</h1>
        <p>Connect inference, enroll the agent runtime, and add enterprise identity when the deployment is ready for employees.</p>
      </div>
      <div className="platform-setup-progress" aria-label={`${readyCoreLayers} of 2 required layers ready`}>
        <strong>{readyCoreLayers}/2</strong>
        <span>required layers ready</span>
      </div>
    </header>

    {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

    <section className="platform-stage-list" aria-label="Platform setup stages">
      {stages.map((stage) => <article className={`platform-stage ${stage.readiness.tone}`} key={stage.number}>
        <div className="platform-stage-number" aria-hidden="true">{stage.number}</div>
        <div className="platform-stage-copy">
          <div className="platform-stage-title"><h2>{stage.title}</h2>{stage.optional && <span>Optional</span>}</div>
          <p>{stage.description}</p>
          <small>{stage.detail}</small>
        </div>
        <div className="platform-stage-action">
          <span className={`readiness-badge ${stage.readiness.tone}`}>{stage.readiness.label}</span>
          <button className="secondary-button" type="button" onClick={stage.action}>{stage.actionLabel}</button>
        </div>
      </article>)}
    </section>

    <section className="platform-launch-grid" aria-label="Available workspaces">
      <article>
        <p className="section-kicker">Employee workspace</p>
        <h2>Governed Chat</h2>
        <p>Talk to an active Hermes Profile with policy, memory, tool activity, and runtime evidence around every response.</p>
        <button className="primary-button" type="button" disabled={!readiness.chatReady} onClick={() => onOpenWorkspace("Chat")}>
          {readiness.chatReady ? "Open Chat" : readiness.nextChatStep?.title ?? "Finish setup first"}
        </button>
      </article>
      <article>
        <p className="section-kicker">Enterprise knowledge</p>
        <h2>Knowledge</h2>
        <p>Send approved source files through OrcaSynapse authorization into Supermemory without retaining a second file copy.</p>
        <button className="primary-button" type="button" disabled={!memoryReady} onClick={() => onOpenWorkspace("Documents")}>
          {memoryReady ? "Open Knowledge" : "Enroll Agentic System first"}
        </button>
      </article>
    </section>

    <section className="setup-activation">
      <article>
        <div>
          <p className="section-kicker">Architecture decision</p>
          <h2>Topology and target environment</h2>
          <p>
            {snapshot?.architecture.reason
              ? `${snapshot.architecture.topologyMode.toLowerCase().replaceAll("_", " ")} topology recorded for ${snapshot.architecture.targetEnvironment.toLowerCase()}.`
              : "Record a topology and rationale. Validation cannot pass the system stage until this decision exists."}
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setArchitectureOpen(true)} disabled={!snapshot}>
          {snapshot?.architecture.reason ? "Change decision" : "Record decision"}
        </button>
      </article>

      <article>
        <div>
          <p className="section-kicker">Activation</p>
          <h2>{snapshot?.journey.status === "COMPLETED" ? `Activated for ${snapshot.journey.activatedEnvironment?.toLowerCase()}` : "Record environment activation"}</h2>
          <p>
            {snapshot?.journey.status === "COMPLETED"
              ? "This installation is activated. Re-running validation reopens the journey."
              : snapshot?.gate.ready
                ? "Every required contract and stage has passed. Record why this installation is being activated."
                : `${snapshot?.gate.blockers.length ?? 0} blocker${snapshot?.gate.blockers.length === 1 ? "" : "s"} remain.`}
          </p>
          {snapshot && !snapshot.gate.ready && snapshot.gate.blockers.length > 0 && (
            <ul className="setup-blockers">
              {snapshot.gate.blockers.slice(0, 5).map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          )}
        </div>
        {snapshot?.journey.status !== "COMPLETED" && (
          <form onSubmit={(event) => { event.preventDefault(); void activate(); }}>
            <label>
              Activation rationale
              <input
                value={activationReason}
                minLength={3}
                maxLength={1000}
                placeholder="First production activation approved by the platform owner"
                disabled={!snapshot?.gate.ready}
                onChange={(event) => setActivationReason(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={busy !== null || !snapshot?.gate.ready || activationReason.trim().length < 3}
            >
              {busy === "activate" ? "Recording…" : "Activate installation"}
            </button>
          </form>
        )}
      </article>
    </section>

    <footer className="platform-setup-footer">
      <div>
        <strong>Production controls stay out of the setup path.</strong>
        <span>Readiness evidence, incidents, evaluations, and recovery drills live in Operations.</span>
      </div>
      <button className="text-button" type="button" onClick={onOpenOperations}>Open Operations</button>
      <button className="text-button" type="button" onClick={() => setRecoveryOpen(true)}>Installation recovery</button>
    </footer>

    {architectureOpen && <div className="agent-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setArchitectureOpen(false); }}>
      <section className="setup-evidence-editor" role="dialog" aria-modal="true" aria-labelledby="architecture-title">
        <header>
          <div><p className="section-kicker">Architecture decision</p><h2 id="architecture-title">Topology and target environment</h2></div>
          <button type="button" aria-label="Close architecture decision" onClick={() => setArchitectureOpen(false)}>×</button>
        </header>
        <p>Changing the topology or target environment invalidates recorded contract evidence, because that evidence was proven against the previous architecture.</p>
        <form onSubmit={(event) => void saveArchitecture(event)}>
          <label>Topology
            <select value={topologyMode} onChange={(event) => setTopologyMode(event.target.value as DeploymentTopologyMode)}>
              <option value="COMPACT">Compact — one host</option>
              <option value="CONTROL_PLANE">Control plane only</option>
              <option value="SEGMENTED_PRODUCTION">Segmented production</option>
            </select>
          </label>
          <label>Target environment
            <select value={targetEnvironment} onChange={(event) => setTargetEnvironment(event.target.value as OnboardingTargetEnvironment)}>
              <option value="DEVELOPMENT">Development</option>
              <option value="PILOT">Pilot</option>
              <option value="PRODUCTION">Production</option>
            </select>
          </label>
          <label>Rationale
            <input value={architectureReason} minLength={3} maxLength={1000} placeholder="Hermes isolated from the control plane for pilot" onChange={(event) => setArchitectureReason(event.target.value)} />
          </label>
          {targetEnvironment === "PRODUCTION" && <small className="field-error">Production additionally requires a verified recovery kit, enterprise identity, and promoted evaluation evidence.</small>}
          <button className="primary-button" type="submit" disabled={busy !== null || architectureReason.trim().length < 3}>
            {busy === "architecture" ? "Saving…" : "Save decision"}
          </button>
        </form>
      </section>
    </div>}

    {recoveryOpen && <div className="agent-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecoveryOpen(false); }}>
      <section className="setup-evidence-editor setup-recovery-editor" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <header>
          <div><p className="section-kicker">Offline recovery</p><h2 id="recovery-title">Protect connector encryption</h2></div>
          <button type="button" aria-label="Close recovery" onClick={() => setRecoveryOpen(false)}>×</button>
        </header>
        <p>Export an encrypted recovery kit and store it outside the OrcaSynapse host. The passphrase and kit are never retained by the dashboard.</p>
        {!snapshot ? <div className="setup-loading"><span className="setup-spinner" />Loading recovery state…</div> : <>
          <form onSubmit={(event) => void exportRecovery(event)}>
            <label>Recovery owner<input value={recoveryOwner} minLength={2} maxLength={160} placeholder="Infrastructure recovery team" onChange={(event) => setRecoveryOwner(event.target.value)} /></label>
            <label>Recovery passphrase<input type="password" autoComplete="new-password" value={recoveryPassphrase} minLength={16} maxLength={1024} onChange={(event) => setRecoveryPassphrase(event.target.value)} /></label>
            <label>Confirm passphrase<input type="password" autoComplete="new-password" value={recoveryConfirm} minLength={16} maxLength={1024} onChange={(event) => setRecoveryConfirm(event.target.value)} /></label>
            {recoveryConfirm && recoveryPassphrase !== recoveryConfirm && <small className="field-error">Passphrases do not match.</small>}
            <button className="primary-button" disabled={busy !== null || recoveryOwner.trim().length < 2 || recoveryPassphrase.length < 16 || recoveryPassphrase !== recoveryConfirm} type="submit">{busy === "recovery-export" ? "Encrypting…" : "Export recovery kit"}</button>
          </form>
          <div className="setup-recovery-divider"><span>Verify retained copy</span></div>
          <label className="setup-file-field"><span>{recoveryFileName || "Select the saved recovery kit"}</span><input type="file" accept="application/json,.json" onChange={(event) => void selectRecoveryFile(event)} /></label>
          <label>Recovery passphrase<input type="password" autoComplete="off" value={recoveryPassphrase} minLength={16} maxLength={1024} onChange={(event) => setRecoveryPassphrase(event.target.value)} /></label>
          <button className="secondary-button" disabled={busy !== null || !recoveryKit || recoveryPassphrase.length < 16} type="button" onClick={() => void verifyRecovery()}>{busy === "recovery-verify" ? "Verifying…" : "Verify recovery kit"}</button>
        </>}
      </section>
    </div>}
  </section>;
}
