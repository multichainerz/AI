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
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
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
import {
  Alert, Button, Dialog, Field, Input, LockedScreen, MicroLabel,
  PageHeader, Panel, Select, StatusText, cn, toneFor,
} from "./ui/index.js";

interface OnboardingViewProps {
  unlocked: boolean;
  oidcConfigured: boolean;
  connections: ServiceConnectionSummary[];
  agentRuntime: AgentRuntimeControl | null;
  profiles: AgentProfile[];
  runtimeNodes: HermesRuntimeNode[];
  initialTab?: "journey" | "nodes" | "readiness";
  onConfigure: (kind?: ServiceKind) => void;
  onOpenWorkspace: (workspace: "Chat" | "Agents") => void;
  onOpenOperations: () => void;
  onRuntimeNodesChange: (nodes: HermesRuntimeNode[]) => void;
  onSignIn: () => void;
  onSessionExpired: () => void;
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
  onSessionExpired,
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

  // Held in a ref so the snapshot effect below depends only on `unlocked`.
  //
  // App re-renders on its own poll and hands down a fresh `onSessionExpired`
  // arrow every few seconds. Tracking that identity re-ran the load, and each
  // run writes the stored recovery owner back into the field -- so a name an
  // operator was typing into the recovery kit form was silently replaced
  // mid-entry. The route effect above carries a disable for the same hazard.
  const latestOnSessionExpired = useRef(onSessionExpired);
  useEffect(() => {
    latestOnSessionExpired.current = onSessionExpired;
  }, [onSessionExpired]);

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
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
      else setError(cause instanceof Error ? cause.message : "Platform setup could not be loaded.");
    });
    return () => { active = false; };
  }, [unlocked]);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
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
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
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
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
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
    return <LockedScreen
      kicker="Administrator access"
      title="Platform"
      mark="01"
      headline="Sign in to this OrcaSynapse installation"
      reason="Use the local administrator account created by the installer. Keep the separate Installation Key offline for recovery only."
      actionLabel={oidcConfigured ? "Sign in with enterprise identity" : "Sign in locally"}
      onAction={oidcConfigured ? onSignIn : () => onConfigure()}
      {...(oidcConfigured ? { secondaryLabel: "Sign in locally", onSecondary: () => onConfigure() } : {})}
    />;
  }

  const inference = connectionFor(connections, "INFERENCE");
  const hermes = connectionFor(connections, "HERMES");
  const readiness = deriveWorkspaceReadiness({ connections, runtimeNodes, profiles, runtime: agentRuntime });
  const {
    inferenceReady,
    runtimeNodeReady: nodeReady,
    executionReady,
    agenticInfrastructureReady,
    agenticReady,
  } = readiness;
  const readyCoreLayers = Number(inferenceReady) + Number(agenticReady);

  if (panel === "nodes") {
    return <div className="grid gap-5">
      <PageHeader
        kicker="Platform · Agentic System"
        title="Enroll the isolated agent runtime"
        description="The VM2 installer provisions Hermes, managed policy, and signed monitoring as one controlled layer."
        actions={<Button onClick={() => setPanel("overview")}>Back to setup</Button>}
      />
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      <RuntimeNodesPanel
        targetEnvironment={snapshot?.architecture.targetEnvironment ?? "DEVELOPMENT"}
        inferenceReady={inferenceReady}
        onConfigureInference={() => onConfigure("INFERENCE")}
        onNodesChange={onRuntimeNodesChange}
        onSessionExpired={onSessionExpired}
      />
    </div>;
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
      description: "Enroll one isolated Ubuntu VM running the governed Hermes runtime.",
      detail: hermes
        ? `Hermes: ${connectionReadiness(hermes).label} · VM2: ${nodeReady ? "Online" : "Not online"} · Profile: ${executionReady ? "Active" : "Needs activation"}`
        : "One generated command installs and binds the complete VM2 runtime.",
      readiness: agenticReady
        ? { label: "Ready", tone: "ready" as const }
        : hermes
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

  return <div className="grid gap-5">
    <PageHeader
      kicker="Platform setup"
      title="Three layers. One usable AI workspace."
      description="Connect inference, enroll the agent runtime, and add enterprise identity when the deployment is ready for employees."
      actions={
        <div className="text-right" aria-label={`${readyCoreLayers} of 2 required layers ready`}>
          <strong className={cn("block text-figure font-semibold tabular-nums", readyCoreLayers === 2 ? "text-good" : "text-warn")}>
            {readyCoreLayers}/2
          </strong>
          <MicroLabel className="block">required layers ready</MicroLabel>
        </div>
      }
    />

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

    <section className="grid gap-2" aria-label="Platform setup stages">
      {stages.map((stage) => <Panel
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-l-2",
          // One mapping for every readiness vocabulary in the product.
          { good: "border-l-good", bad: "border-l-bad", warn: "border-l-warn", accent: "border-l-accent", neutral: "border-l-border-strong" }[toneFor(stage.readiness.tone)],
        )}
        key={stage.number}
      >
        <div
          aria-hidden="true"
          className="grid h-9 w-9 place-items-center rounded border border-border-strong bg-raised font-mono text-caption font-bold text-accent"
        >
          {stage.number}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="m-0 font-display text-[14px] font-semibold tracking-[-0.01em] text-text">{stage.title}</h2>
            {stage.optional && <MicroLabel className="rounded border border-border bg-raised px-1.5 py-0.5">Optional</MicroLabel>}
          </div>
          <p className="mb-0 mt-1 text-body text-muted">{stage.description}</p>
          <small className="mt-1 block text-caption text-faint">{stage.detail}</small>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusText dot tone={toneFor(stage.readiness.tone)}>{stage.readiness.label}</StatusText>
          <Button onClick={stage.action}>{stage.actionLabel}</Button>
        </div>
      </Panel>)}
    </section>

    <section className="grid gap-4" aria-label="Available workspaces">
      <Panel>
        <MicroLabel className="block">Employee workspace</MicroLabel>
        <h2 className="m-0 mt-1.5 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">Governed Chat</h2>
        <p className="mb-4 mt-1.5 text-body leading-relaxed text-muted">
          Talk to an active Hermes Profile with policy, memory, tool activity, and runtime evidence around every response.
        </p>
        <Button variant="primary" disabled={!readiness.chatReady} onClick={() => onOpenWorkspace("Chat")}>
          {readiness.chatReady ? "Open Chat" : readiness.nextChatStep?.title ?? "Finish setup first"}
        </Button>
      </Panel>
    </section>

    <section className="grid gap-4 lg:grid-cols-2">
      <Panel className="flex flex-col">
        <MicroLabel className="block">Architecture decision</MicroLabel>
        <h2 className="m-0 mt-1.5 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">Topology and target environment</h2>
        <p className="mb-4 mt-1.5 flex-1 text-body leading-relaxed text-muted">
          {snapshot?.architecture.reason
            ? `${snapshot.architecture.topologyMode.toLowerCase().replaceAll("_", " ")} topology recorded for ${snapshot.architecture.targetEnvironment.toLowerCase()}.`
            : "Record a topology and rationale. Validation cannot pass the system stage until this decision exists."}
        </p>
        <Button className="self-start" onClick={() => setArchitectureOpen(true)} disabled={!snapshot}>
          {snapshot?.architecture.reason ? "Change decision" : "Record decision"}
        </Button>
      </Panel>

      <Panel>
        <MicroLabel className="block">Activation</MicroLabel>
        <h2 className="m-0 mt-1.5 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
          {snapshot?.journey.status === "COMPLETED" ? `Activated for ${snapshot.journey.activatedEnvironment?.toLowerCase()}` : "Record environment activation"}
        </h2>
        <p className="mb-0 mt-1.5 text-body leading-relaxed text-muted">
          {snapshot?.journey.status === "COMPLETED"
            ? "This installation is activated. Re-running validation reopens the journey."
            : snapshot?.gate.ready
              ? "Every required contract and stage has passed. Record why this installation is being activated."
              : `${snapshot?.gate.blockers.length ?? 0} blocker${snapshot?.gate.blockers.length === 1 ? "" : "s"} remain.`}
        </p>
        {/* The blockers by name. "3 blockers remain" without them is a dead
            end; with them it is a list of next actions. */}
        {snapshot && !snapshot.gate.ready && snapshot.gate.blockers.length > 0 && (
          <ul className="m-0 mt-3 grid list-none gap-1 p-0">
            {snapshot.gate.blockers.slice(0, 5).map((blocker) => (
              <li className="rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-body text-muted" key={blocker}>
                {blocker}
              </li>
            ))}
          </ul>
        )}
        {snapshot?.journey.status !== "COMPLETED" && (
          <form className="mt-4 flex flex-wrap items-end gap-2.5" onSubmit={(event) => { event.preventDefault(); void activate(); }}>
            <Field label="Activation rationale" className="min-w-[220px] flex-1">
              <Input
                value={activationReason}
                minLength={3}
                maxLength={1000}
                placeholder="First production activation approved by the platform owner"
                disabled={!snapshot?.gate.ready}
                onChange={(event) => setActivationReason(event.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              type="submit"
              disabled={busy !== null || !snapshot?.gate.ready || activationReason.trim().length < 3}
            >
              {busy === "activate" ? "Recording…" : "Activate installation"}
            </Button>
          </form>
        )}
      </Panel>
    </section>

    <Panel className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <strong className="block text-label font-semibold text-text">Production controls stay out of the setup path.</strong>
        <span className="mt-1 block text-body text-muted">
          Readiness evidence, incidents, evaluations, and recovery drills live in Operations.
        </span>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" onClick={onOpenOperations}>Open Operations</Button>
        <Button variant="ghost" onClick={() => setRecoveryOpen(true)}>Installation recovery</Button>
      </div>
    </Panel>

    {/*
      * Two more hand-rolled backdrops become real dialogs. The recovery one
      * takes a passphrase that is never retained anywhere, so losing focus out
      * of it mid-entry is not a recoverable mistake.
      */}
    <Dialog
      open={architectureOpen}
      onClose={() => setArchitectureOpen(false)}
      kicker="Architecture decision"
      title="Topology and target environment"
      description="Changing the topology or target environment invalidates recorded contract evidence, because that evidence was proven against the previous architecture."
      footer={
        <Button variant="primary" type="submit" form="architecture-form" disabled={busy !== null || architectureReason.trim().length < 3}>
          {busy === "architecture" ? "Saving…" : "Save decision"}
        </Button>
      }
    >
      <form className="grid gap-3" id="architecture-form" onSubmit={(event) => void saveArchitecture(event)}>
        <Field label="Topology">
          <Select value={topologyMode} onChange={(event) => setTopologyMode(event.target.value as DeploymentTopologyMode)}>
            <option value="COMPACT">Compact — one host</option>
            <option value="CONTROL_PLANE">Control plane only</option>
            <option value="SEGMENTED_PRODUCTION">Segmented production</option>
          </Select>
        </Field>
        <Field label="Target environment">
          <Select value={targetEnvironment} onChange={(event) => setTargetEnvironment(event.target.value as OnboardingTargetEnvironment)}>
            <option value="DEVELOPMENT">Development</option>
            <option value="PILOT">Pilot</option>
            <option value="PRODUCTION">Production</option>
          </Select>
        </Field>
        <Field label="Rationale">
          <Input value={architectureReason} minLength={3} maxLength={1000} placeholder="Hermes isolated from the control plane for pilot" onChange={(event) => setArchitectureReason(event.target.value)} />
        </Field>
        {targetEnvironment === "PRODUCTION" && (
          <StatusText tone="warn" className="normal-case">
            Production additionally requires a verified recovery kit, enterprise identity, and promoted evaluation evidence.
          </StatusText>
        )}
      </form>
    </Dialog>

    <Dialog
      open={recoveryOpen}
      onClose={() => setRecoveryOpen(false)}
      kicker="Offline recovery"
      title="Protect connector encryption"
      description="Export an encrypted recovery kit and store it outside the OrcaSynapse host. The passphrase and kit are never retained by the dashboard."
    >
      {!snapshot
        ? <p className="m-0 text-body text-faint">Loading recovery state…</p>
        : <div className="grid gap-4">
          <form className="grid gap-3" onSubmit={(event) => void exportRecovery(event)}>
            <Field label="Recovery owner">
              <Input value={recoveryOwner} minLength={2} maxLength={160} placeholder="Infrastructure recovery team" onChange={(event) => setRecoveryOwner(event.target.value)} />
            </Field>
            <Field label="Recovery passphrase">
              <Input type="password" autoComplete="new-password" value={recoveryPassphrase} minLength={16} maxLength={1024} onChange={(event) => setRecoveryPassphrase(event.target.value)} />
            </Field>
            <Field label="Confirm passphrase">
              <Input type="password" autoComplete="new-password" value={recoveryConfirm} minLength={16} maxLength={1024} onChange={(event) => setRecoveryConfirm(event.target.value)} />
            </Field>
            {recoveryConfirm && recoveryPassphrase !== recoveryConfirm && (
              <StatusText tone="bad" className="normal-case">Passphrases do not match.</StatusText>
            )}
            <Button variant="primary" className="justify-self-end" disabled={busy !== null || recoveryOwner.trim().length < 2 || recoveryPassphrase.length < 16 || recoveryPassphrase !== recoveryConfirm} type="submit">
              {busy === "recovery-export" ? "Encrypting…" : "Export recovery kit"}
            </Button>
          </form>
          <div className="flex items-center gap-3 border-t border-border pt-4">
            <MicroLabel>Verify retained copy</MicroLabel>
          </div>
          <label className="grid cursor-pointer gap-1 rounded border border-dashed border-border-strong bg-raised px-4 py-4 text-center">
            <span className="text-body text-text">{recoveryFileName || "Select the saved recovery kit"}</span>
            <input className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void selectRecoveryFile(event)} />
          </label>
          <Field label="Recovery passphrase">
            <Input type="password" autoComplete="off" value={recoveryPassphrase} minLength={16} maxLength={1024} onChange={(event) => setRecoveryPassphrase(event.target.value)} />
          </Field>
          <Button className="justify-self-end" disabled={busy !== null || !recoveryKit || recoveryPassphrase.length < 16} onClick={() => void verifyRecovery()}>
            {busy === "recovery-verify" ? "Verifying…" : "Verify recovery kit"}
          </Button>
        </div>}
    </Dialog>
  </div>;
}
