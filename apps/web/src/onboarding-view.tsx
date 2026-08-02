import type {
  ArchitectureDecision,
  ComponentCompatibility,
  ComponentCompatibilityStatus,
  OnboardingSnapshot,
  OnboardingStepKey,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  completeOnboarding,
  exportCredentialRecoveryKit,
  getOnboardingSnapshot,
  runOnboardingValidation,
  updateArchitectureDecision,
  updateComponentCompatibility,
  verifyCredentialRecoveryKit,
} from "./api.js";
import { RuntimeNodesPanel } from "./runtime-nodes-panel.js";

interface OnboardingViewProps {
  unlocked: boolean;
  oidcConfigured: boolean;
  connections: ServiceConnectionSummary[];
  onConfigure: (kind?: ServiceKind) => void;
  onOpenWorkspace: (workspace: "Chat" | "Documents") => void;
  onSignIn: () => void;
  onUnauthorized: () => void;
}

type WorkspaceTab = "journey" | "nodes" | "readiness" | "architecture" | "evidence";
type SetupMode = "quick" | "advanced";

const serviceActions: Partial<Record<string, Array<{ kind: ServiceKind; label: string }>>> = {
  "identity-recovery": [{ kind: "OIDC", label: "Enterprise Access" }],
  "ai-services": [
    { kind: "INFERENCE", label: "AI Inference" },
    { kind: "SUPERMEMORY", label: "Supermemory" },
  ],
  "hermes-profiles": [{ kind: "HERMES", label: "Hermes runtime" }],
};

function label(value: string): string {
  return value.replaceAll("_", " ").toLowerCase().replace(/^./, (first) => first.toUpperCase());
}

function tone(value: string): string {
  if (["PASSED", "COMPLETED", "VERIFIED", "ACTIVATED"].includes(value)) return "ready";
  if (["IN_PROGRESS", "EXPORTED", "WARNING"].includes(value)) return "processing";
  if (["FAILED", "BLOCKED"].includes(value)) return "failed";
  return "neutral";
}

function percent(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

function downloadRecoveryKit(fileName: string, serializedKit: string): void {
  const url = URL.createObjectURL(new Blob([serializedKit], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function OnboardingView({ connections, unlocked, oidcConfigured, onConfigure, onOpenWorkspace, onSignIn, onUnauthorized }: OnboardingViewProps) {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [setupMode, setSetupMode] = useState<SetupMode>("quick");
  const [tab, setTab] = useState<WorkspaceTab>("journey");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [architecture, setArchitecture] = useState<ArchitectureDecision | null>(null);
  const [architectureReason, setArchitectureReason] = useState("Selected for this customer installation and its target environment.");
  const [componentEditor, setComponentEditor] = useState<ComponentCompatibility | null>(null);
  const [componentStatus, setComponentStatus] = useState<ComponentCompatibilityStatus>("IN_PROGRESS");
  const [componentVersion, setComponentVersion] = useState("");
  const [componentEvidence, setComponentEvidence] = useState("");
  const [componentAuthority, setComponentAuthority] = useState("");
  const [componentNote, setComponentNote] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryOwner, setRecoveryOwner] = useState("");
  const [recoveryPassphrase, setRecoveryPassphrase] = useState("");
  const [recoveryConfirm, setRecoveryConfirm] = useState("");
  const [recoveryKit, setRecoveryKit] = useState("");
  const [recoveryFileName, setRecoveryFileName] = useState("");
  const [completionReason, setCompletionReason] = useState("The automated gate and recorded external authorities approve this environment activation.");

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not update deployment setup.");
  };

  const applySnapshot = (next: OnboardingSnapshot) => {
    setSnapshot(next);
    setArchitecture(next.architecture);
    if (!recoveryOwner && next.recovery.recoveryOwner) setRecoveryOwner(next.recovery.recoveryOwner);
  };

  const load = async () => applySnapshot(await getOnboardingSnapshot());

  useEffect(() => {
    if (!unlocked || setupMode !== "advanced") {
      setSnapshot(null);
      setArchitecture(null);
      return;
    }
    let active = true;
    void getOnboardingSnapshot().then((next) => active && applySnapshot(next)).catch((cause) => active && fail(cause));
    return () => { active = false; };
  }, [setupMode, unlocked]);

  const groupedComponents = useMemo(() => {
    const groups = new Map<string, ComponentCompatibility[]>();
    for (const component of snapshot?.components ?? []) groups.set(component.category, [...(groups.get(component.category) ?? []), component]);
    return [...groups.entries()];
  }, [snapshot]);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const validate = async (stageKey?: OnboardingStepKey) => {
    await run(stageKey ? `validate-${stageKey}` : "validate-all", async () => applySnapshot(await runOnboardingValidation(stageKey ? { stageKey } : {})));
  };

  const saveArchitecture = async (event: FormEvent) => {
    event.preventDefault();
    if (!architecture) return;
    await run("architecture", async () => {
      await updateArchitectureDecision({
        topologyMode: architecture.topologyMode,
        targetEnvironment: architecture.targetEnvironment,
        reason: architectureReason.trim(),
        expectedRevision: architecture.revision,
      });
      await load();
      setTab("journey");
    });
  };

  const openAttestation = (component: ComponentCompatibility) => {
    setComponentEditor(component);
    setComponentStatus(component.status === "NOT_TESTED" ? "IN_PROGRESS" : component.status);
    setComponentVersion(component.observedVersion ?? "");
    setComponentEvidence(component.evidenceRef ?? "");
    setComponentAuthority("");
    setComponentNote(component.note ?? "Customer authority supplied evidence for a control OrcaSynapse cannot exercise directly.");
  };

  const saveAttestation = async (event: FormEvent) => {
    event.preventDefault();
    if (!componentEditor) return;
    await run("attestation", async () => {
      applySnapshot(await updateComponentCompatibility(componentEditor.key, {
        status: componentStatus,
        ...(componentVersion.trim() ? { observedVersion: componentVersion.trim() } : {}),
        ...(componentEvidence.trim() ? { evidenceRef: componentEvidence.trim() } : {}),
        ...(componentAuthority.trim() ? { attestationAuthority: componentAuthority.trim() } : {}),
        note: componentNote.trim(),
        expectedRevision: componentEditor.revision,
      }));
      setComponentEditor(null);
    });
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
      await load();
    });
  };

  const verifyRecovery = async () => {
    if (!snapshot) return;
    await run("recovery-verify", async () => {
      applySnapshot(await verifyCredentialRecoveryKit({
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
      <p>Use the local administrator account provisioned by the installer. Keep the separate Installation Key offline in your organization vault for account recovery only.</p>
      <div className="setup-lock-actions">
        {oidcConfigured && <button className="primary-button" type="button" onClick={onSignIn}>Sign in with enterprise identity</button>}
        <button className={oidcConfigured ? "secondary-button" : "primary-button"} type="button" onClick={() => onConfigure()}>Sign in locally</button>
      </div>
    </section>;
  }

  const connectionFor = (kind: ServiceKind) => connections.find((connection) => connection.kind === kind);
  const supermemory = connectionFor("SUPERMEMORY");
  const hermes = connectionFor("HERMES");
  const inferenceServer = connectionFor("INFERENCE");
  const enterpriseAccess = connectionFor("OIDC");
  const isHealthy = (connection: ServiceConnectionSummary | undefined) => connection?.enabled === true && connection.status === "HEALTHY";
  const inferenceReady = isHealthy(inferenceServer);
  const supermemoryReady = isHealthy(supermemory);
  const hermesReady = isHealthy(hermes);
  const agenticReady = hermesReady && supermemoryReady;

  if (setupMode === "quick") {
    const services: Array<{
      key: string;
      name: string;
      description: string;
      detail: string;
      state: string;
      ready: boolean;
      optional?: boolean;
      kind?: ServiceKind;
    }> = [
      {
        key: "inference",
        name: "AI Inference",
        description: "Enterprise model serving for Chat and governed agents",
        detail: inferenceServer?.baseUrl ?? "Choose vLLM, llama.cpp, SGLang, Ollama, TGI, or another OpenAI-compatible endpoint.",
        state: inferenceReady ? "Healthy" : inferenceServer ? label(inferenceServer.status) : "Not configured",
        ready: inferenceReady,
        kind: "INFERENCE",
      },
      {
        key: "agentic",
        name: "Agentic System",
        description: "Hermes execution with durable Supermemory",
        detail: hermes && supermemory
          ? `Hermes ${label(hermes.status)} · Memory ${label(supermemory.status)}`
          : "One OrcaSynapse-hosted installer provisions Hermes and Supermemory together on the isolated VM.",
        state: agenticReady ? "Healthy" : hermes || supermemory ? "Needs attention" : "Not configured",
        ready: agenticReady,
        kind: "HERMES",
      },
      {
        key: "access",
        name: "Enterprise Access",
        description: "OIDC, Microsoft Entra ID and role-based access",
        detail: oidcConfigured
          ? enterpriseAccess?.baseUrl ?? "Enterprise sign-in is configured."
          : "Configure workforce identity now; tenant data isolation remains a planned phase.",
        state: oidcConfigured ? "Configured" : "Optional",
        ready: oidcConfigured,
        optional: true,
        kind: "OIDC",
      },
    ];

    return <section className="setup-workspace setup-quick-start">
      <header className="setup-quick-hero">
        <div>
          <p className="page-kicker">Development quick start</p>
          <h1>AI Inference, Agentic System, Enterprise Access</h1>
          <p>OrcaSynapse and PostgreSQL are already installed. Connect enterprise model serving, enroll the combined Hermes and Supermemory runtime, then add workforce identity and RBAC.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setSetupMode("advanced")}>Production setup</button>
      </header>

      <section className="setup-quick-services" aria-label="Quick-start services">
        {services.map((service, index) => <article className={service.ready ? "ready" : service.optional ? "optional" : "pending"} key={service.key}>
          <div className="setup-quick-service-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="setup-quick-service-copy">
            <div><h2>{service.name}</h2>{service.optional && <span>Optional</span>}</div>
            <p>{service.description}</p>
            <small>{service.detail}</small>
          </div>
          <div className="setup-quick-service-action">
            <span className={`document-status ${service.ready ? "ready" : "neutral"}`}>{service.state}</span>
            {service.kind && <button className="text-button" type="button" onClick={() => {
              if (!service.ready && service.key === "agentic") {
                setTab("nodes");
                setSetupMode("advanced");
                return;
              }
              onConfigure(service.kind);
            }}>{service.key === "inference" && !inferenceServer ? "Configure directly" : service.ready ? "Review" : service.key === "agentic" ? "Enroll runtime" : "Configure"}</button>}
          </div>
        </article>)}
      </section>

      <section className="setup-quick-launch">
        <article className={inferenceReady ? "ready" : undefined}>
          <div className="setup-quick-launch-icon" aria-hidden="true">C</div>
          <div><p className="section-kicker">Workspace</p><h2>Chat</h2><p>Direct Chat can use approved AI Inference immediately. Enroll the Agentic System for governed runs and durable memory; reviewed tools and subagents are a later opt-in.</p></div>
          <button className="primary-button" type="button" disabled={!inferenceReady} onClick={() => onOpenWorkspace("Chat")}>{inferenceReady ? "Start chatting" : "Set up AI Inference first"}</button>
        </article>
        <article className={supermemoryReady ? "ready" : undefined}>
          <div className="setup-quick-launch-icon" aria-hidden="true">D</div>
          <div><p className="section-kicker">Workspace</p><h2>Documents</h2><p>UTF-8 TXT ingestion publishes normalized knowledge to Supermemory. Rich documents and scanned images are not accepted by this release.</p></div>
          <button className="primary-button" type="button" disabled={!supermemoryReady} onClick={() => onOpenWorkspace("Documents")}>{supermemoryReady ? "Open documents" : "Enroll Agentic System first"}</button>
        </article>
      </section>

      <aside className="setup-quick-deferred">
        <div><p className="section-kicker">Deferred without blocking development</p><h2>Production controls remain available when you need them</h2><p>Tenant isolation, governed MCP tools, recovery evidence, compatibility attestations, and activation gates remain available in Production setup.</p></div>
        <button className="text-button" type="button" onClick={() => setSetupMode("advanced")}>Review production controls</button>
      </aside>
    </section>;
  }

  if (!snapshot || !architecture) return <section className="setup-workspace"><button className="text-button setup-quick-return" type="button" onClick={() => setSetupMode("quick")}>Back to quick start</button><div className="setup-loading" aria-live="polite"><span className="setup-spinner" />Loading production setup…</div></section>;

  const componentProgress = percent(snapshot.gate.passedComponents, snapshot.gate.requiredComponents);
  const stepProgress = percent(snapshot.gate.completedSteps, snapshot.gate.requiredSteps);

  return <section className="setup-workspace">
    <header className="setup-header">
      <div>
        <p className="page-kicker">Deployment control plane</p>
        <h1>{snapshot.journey.status === "COMPLETED" ? "Deployment" : "Guided setup"}</h1>
        <p>Configure the platform through one resumable path. Technical evidence is generated by validation; external attestations remain visibly distinct.</p>
      </div>
      <div className="setup-header-actions">
        <button className="secondary-button" type="button" onClick={() => setSetupMode("quick")}>Quick start</button>
        <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void load()}>Refresh</button>
        <span className={`document-status ${tone(snapshot.journey.status)}`}>{label(snapshot.journey.status)}</span>
      </div>
    </header>

    {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

    <section className="setup-summary">
      <article>
        <div className="setup-ring" style={{ "--progress": `${stepProgress * 3.6}deg` } as CSSProperties}><strong>{stepProgress}%</strong></div>
        <div><span>Guided journey</span><strong>{snapshot.gate.completedSteps} of {snapshot.gate.requiredSteps} stages</strong><small>{label(architecture.topologyMode)} · {label(architecture.targetEnvironment)}</small></div>
      </article>
      <article>
        <div className="setup-ring" style={{ "--progress": `${componentProgress * 3.6}deg` } as CSSProperties}><strong>{componentProgress}%</strong></div>
        <div><span>Required contracts</span><strong>{snapshot.gate.passedComponents} of {snapshot.gate.requiredComponents} passed</strong><small>Requirements follow topology and target</small></div>
      </article>
      <article className={snapshot.gate.ready ? "ready" : "blocked"}>
        <div className="setup-gate-mark">{snapshot.gate.ready ? "✓" : "!"}</div>
        <div><span>{label(snapshot.gate.targetEnvironment)} gate</span><strong>{snapshot.gate.ready ? "Ready to activate" : `${snapshot.gate.blockers.length} blockers`}</strong><small>{snapshot.gate.ready ? "All required evidence is current" : snapshot.gate.blockers[0]}</small></div>
      </article>
    </section>

    <nav className="setup-tabs" aria-label="Deployment setup sections">
      {(["journey", "nodes", "readiness", "architecture", "evidence"] as WorkspaceTab[]).map((item) => <button key={item} className={tab === item ? "active" : undefined} type="button" onClick={() => setTab(item)}>{item === "nodes" ? "Hermes nodes" : item === "readiness" ? "Advanced readiness" : label(item)}</button>)}
    </nav>

    {tab === "journey" && <div className="setup-journey-layout">
      <section className="setup-steps panel">
        <div className="document-section-heading"><div><p className="section-kicker">Customer journey</p><h2>From installation to activation</h2></div><button className="secondary-button" disabled={busy !== null} type="button" onClick={() => void validate()}>Run all checks</button></div>
        <ol>
          {snapshot.steps.map((step) => <li key={step.key} className={snapshot.journey.currentStepKey === step.key ? "current" : undefined}>
            <article className="setup-stage-card">
              <span className={`setup-step-number ${tone(step.status)}`}>{step.status === "COMPLETED" ? "✓" : step.ordinal}</span>
              <div className="setup-stage-copy"><div><strong>{step.title}</strong>{!step.required && <em>Recommended</em>}</div><p>{step.description}</p><small>{step.action} · {step.evidenceRefs.length} generated evidence record{step.evidenceRefs.length === 1 ? "" : "s"}</small>
                {serviceActions[step.key] && <div className="setup-inline-actions">{serviceActions[step.key]?.map((action) => <button className="text-button" key={action.kind} type="button" onClick={() => onConfigure(action.kind)}>{action.label}</button>)}</div>}
                {step.key === "system-topology" && <div className="setup-inline-actions"><button className="text-button" type="button" onClick={() => setTab("architecture")}>Review topology</button></div>}
                {step.key === "ai-services" && architecture.topologyMode !== "COMPACT" && <div className="setup-inline-actions"><button className="text-button" type="button" onClick={() => setTab("nodes")}>Enroll Hermes VM</button></div>}
                {step.key === "identity-recovery" && <div className="setup-inline-actions"><button className="text-button" type="button" onClick={() => setRecoveryOpen(true)}>Recovery kit</button></div>}
              </div>
              <div className="setup-stage-controls"><span className={`document-status ${tone(step.status)}`}>{label(step.status)}</span><button className="secondary-button" disabled={busy !== null} type="button" onClick={() => void validate(step.key)}>{busy === `validate-${step.key}` ? "Checking…" : "Run check"}</button></div>
            </article>
          </li>)}
        </ol>
      </section>
      <aside className="setup-blockers panel">
        <p className="section-kicker">Target gate</p><h2>{label(snapshot.gate.targetEnvironment)} activation</h2>
        <div className={`setup-recovery-state ${tone(snapshot.recovery.status)}`}><span>Credential recovery</span><strong>{label(snapshot.recovery.status)}</strong><small>{snapshot.recovery.recoveryOwner ?? "Assign an off-host recovery owner"}</small><button className="secondary-button" type="button" onClick={() => setRecoveryOpen(true)}>{snapshot.recovery.status === "NOT_EXPORTED" ? "Create recovery kit" : "Manage recovery"}</button></div>
        {snapshot.gate.blockers.length === 0 ? <div className="setup-clear"><strong>All gates are clear</strong><p>This environment can be activated with an audited administrator decision.</p></div> : <ul>{snapshot.gate.blockers.slice(0, 10).map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
        <label>Activation reason<textarea value={completionReason} minLength={3} maxLength={1000} onChange={(event) => setCompletionReason(event.target.value)} /></label>
        <button className="primary-button" type="button" disabled={!snapshot.gate.ready || busy !== null} onClick={() => void run("activate", async () => applySnapshot(await completeOnboarding({ reason: completionReason.trim(), expectedRevision: snapshot.journey.revision })))}>{busy === "activate" ? "Activating…" : snapshot.journey.activatedEnvironment === architecture.targetEnvironment ? `${label(architecture.targetEnvironment)} active` : `Activate ${label(architecture.targetEnvironment)}`}</button>
      </aside>
    </div>}

    {tab === "nodes" && <RuntimeNodesPanel targetEnvironment={architecture.targetEnvironment} onUnauthorized={onUnauthorized} />}

    {tab === "readiness" && <div className="setup-contract-groups">
      <section className="setup-advanced-note"><div><strong>Advanced readiness</strong><p>OrcaSynapse-generated checks are authoritative for testable controls. Use external attestation only when the control belongs to a customer authority outside OrcaSynapse.</p></div><button className="secondary-button" disabled={busy !== null} type="button" onClick={() => void validate()}>Refresh automated evidence</button></section>
      {groupedComponents.map(([category, components]) => <section className="panel" key={category}>
        <div className="document-section-heading"><div><p className="section-kicker">{category}</p><h2>{category} contracts</h2></div><span>{components.filter((item) => item.status === "PASSED").length}/{components.filter((item) => item.required).length || components.length} passed</span></div>
        <div className="setup-contract-list">{components.map((component) => <article key={component.key}>
          <span className={`setup-contract-dot ${tone(component.status)}`} />
          <div><div className="setup-contract-title"><strong>{component.displayName}</strong><em>{component.required ? "Required" : "Conditional"}</em></div><p>{component.expectedContract}</p><small>{component.requirementReason}{component.observedVersion ? ` · ${component.observedVersion}` : ""}{component.evidenceSource ? ` · ${label(component.evidenceSource)}` : ""}</small></div>
          <div className="setup-contract-actions"><span className={`document-status ${tone(component.status)}`}>{label(component.status)}</span><button className="text-button" type="button" onClick={() => openAttestation(component)}>External attestation</button></div>
        </article>)}</div>
      </section>)}
    </div>}

    {tab === "architecture" && <form className="setup-architecture panel" onSubmit={(event) => void saveArchitecture(event)}>
      <div className="document-section-heading"><div><p className="section-kicker">Customer deployment</p><h2>Topology and activation target</h2></div><span>Revision {architecture.revision}</span></div>
      <div className="setup-topology-options">
        {(["COMPACT", "CONTROL_PLANE", "SEGMENTED_PRODUCTION"] as const).map((mode) => <label className={architecture.topologyMode === mode ? "selected" : undefined} key={mode}><input type="radio" name="topology" checked={architecture.topologyMode === mode} onChange={() => setArchitecture({ ...architecture, topologyMode: mode })}/><span><strong>{mode === "COMPACT" ? "Compact" : mode === "CONTROL_PLANE" ? "Control-plane only" : "Segmented production"}</strong><small>{mode === "COMPACT" ? "One server with a hardened Hermes container. Best for evaluation and smaller installations." : mode === "CONTROL_PLANE" ? "OrcaSynapse on this server, connected to customer-operated AI service APIs." : "Separate trust zones for OrcaSynapse, Hermes, and inference/GPU services."}</small></span></label>)}
      </div>
      <div className="setup-architecture-grid">
        <label><span>Activation target</span><select value={architecture.targetEnvironment} onChange={(event) => setArchitecture({ ...architecture, targetEnvironment: event.target.value as ArchitectureDecision["targetEnvironment"] })}><option value="DEVELOPMENT">Development</option><option value="PILOT">Pilot</option><option value="PRODUCTION">Production</option></select><small>Production adds OIDC, complete compatibility, recovery, and approval gates.</small></label>
        <label><span>Installation path</span><input value="Public OrcaSynapse bootstrap + private runtime enrollment" readOnly /><small>The GitHub bootstrap starts OrcaSynapse and PostgreSQL. The dashboard then connects AI Inference and serves the customer-bound Agentic System installer.</small></label>
      </div>
      <div className="setup-architecture-note"><strong>Fixed service ownership</strong><p>OrcaSynapse owns policy and the inference gateway. The selected inference backend owns model serving. Hermes owns agent execution and uses its scoped Supermemory provider for durable memory. Internal Supermemory storage and embeddings are deployment details, not onboarding choices.</p></div>
      <label className="setup-architecture-reason"><span>Decision rationale</span><textarea minLength={3} maxLength={1000} value={architectureReason} onChange={(event) => setArchitectureReason(event.target.value)} /></label>
      <footer><span>Changing topology or target reopens activation and recalculates required contracts.</span><button className="primary-button" disabled={busy !== null || architectureReason.trim().length < 3} type="submit">{busy === "architecture" ? "Saving…" : "Save deployment decision"}</button></footer>
    </form>}

    {tab === "evidence" && <section className="panel setup-evidence-log">
      <div className="document-section-heading"><div><p className="section-kicker">Immutable results</p><h2>Validation evidence</h2></div><span>{snapshot.evidence.length} recent records</span></div>
      {snapshot.evidence.length === 0 ? <div className="setup-empty"><strong>No generated evidence yet</strong><p>Run a stage check to create the first correlated validation record.</p></div> : <ol>{snapshot.evidence.map((item) => <li key={item.id}><span className={`setup-contract-dot ${tone(item.outcome)}`} /><div><div><strong>{item.summary}</strong><em>{label(item.source)}</em></div><small>{label(item.stageKey)} · {item.code}{item.observedVersion ? ` · ${item.observedVersion}` : ""} · {new Date(item.createdAt).toLocaleString()}</small></div><span className={`document-status ${tone(item.outcome)}`}>{label(item.outcome)}</span></li>)}</ol>}
    </section>}

    {componentEditor && <div className="agent-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setComponentEditor(null); }}><form className="setup-evidence-editor" onSubmit={(event) => void saveAttestation(event)}>
      <header><div><p className="section-kicker">External authority only</p><h2>{componentEditor.displayName}</h2></div><button type="button" aria-label="Close" onClick={() => setComponentEditor(null)}>×</button></header>
      <p>Use this only when OrcaSynapse cannot execute the customer-owned control. Automated validation remains visibly distinct.</p>
      <label>Decision<select value={componentStatus} onChange={(event) => setComponentStatus(event.target.value as ComponentCompatibilityStatus)}><option value="IN_PROGRESS">In progress</option><option value="PASSED">Passed</option><option value="FAILED">Failed</option><option value="BLOCKED">Blocked</option></select></label>
      <label>Authority<input value={componentAuthority} maxLength={160} placeholder="OrcaSynapse Security, Infrastructure, or named owner" onChange={(event) => setComponentAuthority(event.target.value)} /></label>
      <label>Observed version<input value={componentVersion} maxLength={240} placeholder="Exact version, revision, or image digest" onChange={(event) => setComponentVersion(event.target.value)} /></label>
      <label>Immutable evidence reference<input value={componentEvidence} maxLength={500} placeholder="Signed report, ticket, or retained evidence URI" onChange={(event) => setComponentEvidence(event.target.value)} /></label>
      <label>Rationale<textarea value={componentNote} minLength={3} maxLength={1000} onChange={(event) => setComponentNote(event.target.value)} /></label>
      <footer><button className="secondary-button" type="button" onClick={() => setComponentEditor(null)}>Cancel</button><button className="primary-button" disabled={busy !== null || componentNote.trim().length < 3 || (componentStatus === "PASSED" && (!componentAuthority.trim() || !componentVersion.trim() || !componentEvidence.trim()))} type="submit">{busy === "attestation" ? "Recording…" : "Record attestation"}</button></footer>
    </form></div>}

    {recoveryOpen && <div className="agent-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecoveryOpen(false); }}><section className="setup-evidence-editor setup-recovery-editor">
      <header><div><p className="section-kicker">Off-host recovery</p><h2>Credential-encryption recovery kit</h2></div><button type="button" aria-label="Close" onClick={() => setRecoveryOpen(false)}>×</button></header>
      <p>The kit is encrypted before it reaches this browser. Store it outside the OrcaSynapse server. OrcaSynapse stores only its checksum and key fingerprint.</p>
      <form onSubmit={(event) => void exportRecovery(event)}>
        <label>Recovery owner<input value={recoveryOwner} minLength={2} maxLength={160} placeholder="Infrastructure recovery team" onChange={(event) => setRecoveryOwner(event.target.value)} /></label>
        <label>Recovery passphrase<input type="password" autoComplete="new-password" value={recoveryPassphrase} minLength={16} maxLength={1024} onChange={(event) => setRecoveryPassphrase(event.target.value)} /></label>
        <label>Confirm passphrase<input type="password" autoComplete="new-password" value={recoveryConfirm} minLength={16} maxLength={1024} onChange={(event) => setRecoveryConfirm(event.target.value)} /></label>
        {recoveryConfirm && recoveryPassphrase !== recoveryConfirm && <small className="field-error">Passphrases do not match.</small>}
        <button className="primary-button" disabled={busy !== null || recoveryOwner.trim().length < 2 || recoveryPassphrase.length < 16 || recoveryPassphrase !== recoveryConfirm} type="submit">{busy === "recovery-export" ? "Encrypting…" : "Export encrypted recovery kit"}</button>
      </form>
      <div className="setup-recovery-divider"><span>Verify retained copy</span></div>
      <label className="setup-file-field"><span>{recoveryFileName || "Select the recovery kit saved outside OrcaSynapse"}</span><input type="file" accept="application/json,.json" onChange={(event) => void selectRecoveryFile(event)} /></label>
      <label>Recovery passphrase<input type="password" autoComplete="off" value={recoveryPassphrase} minLength={16} maxLength={1024} onChange={(event) => setRecoveryPassphrase(event.target.value)} /></label>
      <button className="secondary-button" disabled={busy !== null || !recoveryKit || recoveryPassphrase.length < 16} type="button" onClick={() => void verifyRecovery()}>{busy === "recovery-verify" ? "Verifying…" : "Verify recovery kit"}</button>
      <small>OrcaSynapse never stores the kit or recovery passphrase. Losing every key copy makes encrypted connector credentials unrecoverable.</small>
    </section></div>}
  </section>;
}
