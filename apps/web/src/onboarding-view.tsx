import type {
  AdministratorSession,
  AgentProfile,
  DeploymentTopologyMode,
  OnboardingTargetEnvironment,
  AgentRuntimeControl,
  HermesRuntimeNode,
  OnboardingSnapshot,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { adminAccess } from "./admin-access.js";
import {
  OrcaSynapseApiError,
  getOnboardingSnapshot,
  runOnboardingValidation,
  updateArchitectureDecision,
} from "./api.js";
import { connectionReadiness } from "./connection-readiness.js";
import { connectionFor, deriveWorkspaceReadiness } from "./platform-readiness.js";
import { RecoveryKitDialog } from "./recovery-kit-dialog.js";
import {
  DEFAULT_HERMES_COMMIT,
  RuntimeNodesPanel,
  defaultControlPlaneUrl,
} from "./runtime-nodes-panel.js";
import { deriveSetupSteps, type SetupStep, type SetupStepKey } from "./setup-steps.js";
import {
  Alert, Button, Dialog, Field, Input, LockedScreen, MicroLabel,
  PageHeader, Panel, PanelHeading, Select, StatusText, StepList, Tile, cn,
} from "./ui/index.js";

interface OnboardingViewProps {
  session: AdministratorSession | null;
  oidcConfigured: boolean;
  connections: ServiceConnectionSummary[];
  agentRuntime: AgentRuntimeControl | null;
  profiles: AgentProfile[];
  runtimeNodes: HermesRuntimeNode[];
  /** The step named by `#settings/setup/<step>`, if the route named one. */
  initialStep?: SetupStepKey | null;
  /**
   * Reports the step an operator opened, so the address can follow.
   *
   * Without it the rail would be local state again — which is the defect this
   * screen is replacing: Back left Settings entirely, and reloading part-way
   * through a twenty-minute VM2 install returned to the overview.
   */
  onSelectStep?: (step: SetupStepKey) => void;
  onConfigure: (kind?: ServiceKind) => void;
  onOpenWorkspace: (workspace: "Chat" | "Agents") => void;
  onOpenOperations: () => void;
  onRuntimeNodesChange: (nodes: HermesRuntimeNode[]) => void;
  onSignIn: () => void;
  onSessionExpired: () => void;
}

const stepTone = { done: "good", current: "accent", blocked: "warn" } as const;
const stepStatusLabel = { done: "Done", current: "In progress", blocked: "Waiting" } as const;

/**
 * Setup, as the sequence it actually is.
 *
 * This screen used to present six unrelated blocks and nine buttons, in an
 * order the operator had to infer from the order of the cards, with a terminal
 * action that could not be reached at all. It is one job — get from a fresh
 * install to a governed session — and that job has exactly three steps, so it
 * is drawn as three steps: a rail on the left, one expanded step on the right,
 * and every completed step still one click away.
 *
 * Two rules hold the shape:
 *
 * 1. **Blockers live inside the step they block.** The page-level list this
 *    replaces said "10 blockers remain" beside five rows, because the count was
 *    `blockers.length` and the list was `.slice(0, 5)`. Attaching each reason to
 *    its own step removes that class of mismatch by construction — there is no
 *    count to disagree with a list.
 * 2. **Nothing that is not one of the three steps stays.** The update check
 *    moved to Settings → Application, the activation record to Operations, the
 *    Governed Chat promo was deleted (it duplicated step 3 and its only button
 *    was a disabled instruction), and recovery became a footer action, which is
 *    what it always was.
 */
export function OnboardingView({
  session,
  connections,
  agentRuntime,
  profiles,
  runtimeNodes,
  oidcConfigured,
  initialStep = null,
  onSelectStep,
  onConfigure,
  onOpenWorkspace,
  onOpenOperations,
  onRuntimeNodesChange,
  onSignIn,
  onSessionExpired,
}: OnboardingViewProps) {
  const { unlocked } = adminAccess(session);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [openStep, setOpenStep] = useState<SetupStepKey | null>(initialStep);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [topologyMode, setTopologyMode] = useState<DeploymentTopologyMode>("COMPACT");
  const [targetEnvironment, setTargetEnvironment] = useState<OnboardingTargetEnvironment>("DEVELOPMENT");
  const [architectureReason, setArchitectureReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpenStep(initialStep);
  // The route token is the source of truth here. Callback identity can change
  // during App refreshes and must not close the step an operator is working in.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStep]);

  // Held in a ref so the snapshot effect below depends only on `unlocked`.
  //
  // App re-renders on its own poll and hands down a fresh `onSessionExpired`
  // arrow every few seconds. Tracking that identity re-ran the load, and each
  // run wrote stored values back into fields an operator was typing into. The
  // route effect above carries a disable for the same hazard.
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
      if (active) setSnapshot(next);
    }).catch((cause: unknown) => {
      if (!active) return;
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
      else setError(cause instanceof Error ? cause.message : "Application settings could not be loaded.");
    });
    return () => { active = false; };
  }, [unlocked]);

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

  /**
   * The 2 → 3 hand-off.
   *
   * Profile activation refuses unless the `hermes-api` component is PASSED, and
   * the only thing that writes that is `POST /onboarding/validate` for the
   * `ai-services` stage. Setup never called it — its sole caller was the Agents
   * screen, which ran it implicitly — so an operator who followed this screen's
   * ordering arrived at profile activation and was refused for a reason the
   * screen had never mentioned. Running it here makes the hand-off explicit at
   * the boundary that needs it.
   */
  const openProfiles = async () => {
    if (busy) return;
    setBusy("ai-services");
    try {
      setSnapshot(await runOnboardingValidation({ stageKey: "ai-services" }));
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
        onSessionExpired();
        setBusy(null);
        return;
      }
      // A failed re-validation is worth reporting, but it must not strand the
      // operator on a screen whose only remaining action is the one it blocked.
      setError(cause instanceof Error ? cause.message : "The AI-services check could not be re-run.");
    } finally {
      setBusy(null);
    }
    onOpenWorkspace("Agents");
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Administrator access"
      title="Settings"
      mark="01"
      headline="Sign in to this OrcaSynapse installation"
      reason="Use the local administrator account created by the installer. Keep the separate Installation Key offline for recovery only."
      actionLabel={oidcConfigured ? "Sign in with enterprise identity" : "Sign in locally"}
      onAction={oidcConfigured ? onSignIn : () => onConfigure()}
      {...(oidcConfigured ? { secondaryLabel: "Sign in locally", onSecondary: () => onConfigure() } : {})}
    />;
  }

  const inference = connectionFor(connections, "INFERENCE");
  const readiness = deriveWorkspaceReadiness({ connections, runtimeNodes, profiles, runtime: agentRuntime });
  const architecture = snapshot?.architecture ?? null;

  /*
   * `?? "DEVELOPMENT"` is safe here and was not safe in the nodes panel, which
   * is worth stating because it is the same expression.
   *
   * There it decided whether to *offer* an enrolment, so guessing DEVELOPMENT
   * removed the production artifact guard from a PRODUCTION install. Here it
   * only decides which reasons are listed, and the panel still refuses to enrol
   * anything until the target is known — so the worst this default can do is
   * omit a line for the moment before the snapshot lands, which the extra
   * blocker below states outright.
   */
  const steps: SetupStep[] = deriveSetupSteps({
    readiness,
    connections,
    runtimeNodes,
    targetEnvironment: architecture?.targetEnvironment ?? "DEVELOPMENT",
    hermesCommit: DEFAULT_HERMES_COMMIT,
    controlPlaneUrl: defaultControlPlaneUrl(),
  }).map((step) => step.key === "runtime" && architecture === null && step.status !== "done"
    ? {
      ...step,
      blockedBy: [
        ...step.blockedBy,
        "The architecture decision has not loaded, so production artifact requirements cannot be checked yet.",
      ],
    }
    : step);

  const done = steps.filter((step) => step.status === "done").length;
  const allDone = done === steps.length;
  const active = steps.find((step) => step.key === openStep)
    ?? steps.find((step) => step.status === "current")
    ?? steps[steps.length - 1];
  const productionBlocked = architecture?.targetEnvironment === "PRODUCTION";

  return <div className="grid gap-5">
    <PageHeader
      kicker="Application settings"
      title="Bring this installation up"
      description="Three steps between a fresh install and a governed session. Each is finished when OrcaSynapse can prove it, not when it has been opened."
      actions={
        <div className="min-w-[150px] text-right">
          <strong className={cn("block text-figure font-semibold tabular-nums", allDone ? "text-good" : "text-warn")}>
            {done} of {steps.length}
          </strong>
          <MicroLabel className="block">steps complete</MicroLabel>
          {/*
            * `<progress>` rather than a div with a computed width: the fraction
            * is data, and `style-src 'self'` refuses the inline width that
            * would express it.
            */}
          <progress
            className={cn("metric-progress mt-2 block h-0.5 w-full", allDone ? "is-good" : "is-warn")}
            aria-label={`${done} of ${steps.length} setup steps complete`}
            value={done}
            max={steps.length}
          />
        </div>
      }
    />

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

    <div className="grid gap-5 lg:grid-cols-[264px_minmax(0,1fr)] lg:items-start">
      <StepList
        label="Setup steps"
        className="lg:sticky lg:top-4"
        activeKey={active?.key ?? ""}
        items={steps.map((step) => ({
          key: step.key,
          ordinal: step.ordinal,
          title: step.title,
          status: step.status,
          ...(step.status === "done" ? {} : { caption: step.blockedBy[0] ?? step.purpose }),
        }))}
        onSelect={(key) => {
          // Both: the local state keeps the rail responsive even where no
          // router is wired, and the callback is what puts the step in the
          // address so Back and a reload agree with the screen.
          setOpenStep(key as SetupStepKey);
          onSelectStep?.(key as SetupStepKey);
        }}
      />

      {active && <section className="grid gap-4" aria-label={`Step ${active.ordinal}: ${active.title}`}>
        <Panel>
          <PanelHeading
            kicker={`Step ${active.ordinal} of ${steps.length}`}
            title={active.title}
            description={active.purpose}
            actions={<StatusText dot tone={stepTone[active.status]}>{stepStatusLabel[active.status]}</StatusText>}
          />

          {/*
            * Every reason, not the first five. The list this replaces printed a
            * count taken from the whole array beside a `.slice(0, 5)` of it, so
            * the screen contradicted itself whenever more than five things were
            * wrong — which is exactly when an operator is reading it.
            */}
          {active.blockedBy.length > 0 && (
            <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={`What step ${active.ordinal} is waiting on`}>
              {active.blockedBy.map((blocker) => (
                // `text-text`, not the `text-muted` the block this replaces
                // used: muted over the warn tint measures 4.46:1 in dark theme,
                // which is under AA — and a blocker is the one thing on the
                // step nobody should have to lean in to read.
                <li className="rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-body text-text" key={blocker}>
                  {blocker}
                </li>
              ))}
            </ul>
          )}

          {active.key === "inference" && <div className="mt-4 grid gap-3">
            <Tile className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <MicroLabel className="block">Endpoint</MicroLabel>
                <span className="mt-1 block truncate text-body text-text">
                  {inference?.baseUrl ?? "vLLM, llama.cpp, SGLang, Ollama, TGI, or another OpenAI-compatible server."}
                </span>
              </div>
              <StatusText dot tone={connectionReadiness(inference).tone === "ready" ? "good" : inference ? "warn" : "neutral"}>
                {connectionReadiness(inference).label}
              </StatusText>
            </Tile>
            {/*
              * The two traps, stated where they can still be avoided. Neither
              * appears anywhere in the product today, and both are silent: the
              * enrolment seed takes the single healthy inference connection and
              * reads a served model off it, so a second healthy endpoint and a
              * healthy endpoint with no model alias both end the same way — a
              * VM2 installer that cannot be generated, for a reason the screen
              * never named.
              */}
            <p className="m-0 text-caption leading-relaxed text-faint">
              OrcaSynapse seeds VM2 from <strong className="font-semibold text-muted">exactly one</strong> healthy
              inference connection, and reads the served model off it. A second healthy endpoint removes the ability to
              enrol rather than adding redundancy, and a connection that tests healthy without a selected model cannot
              seed anything.
            </p>
            <Button className="justify-self-start" variant={active.status === "done" ? "ghost" : "primary"} onClick={() => onConfigure("INFERENCE")}>
              {inference ? "Manage inference server" : "Connect inference server"}
            </Button>
          </div>}

          {active.key === "runtime" && <div className="mt-4 grid gap-3">
            {/*
              * The architecture decision belongs to this step: the target
              * environment is what decides whether enrolment demands a
              * commit-pinned runtime and an HTTPS origin.
              */}
            <Tile className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <MicroLabel className="block">Architecture decision</MicroLabel>
                <span className="mt-1 block text-body text-text">
                  {architecture
                    ? `${architecture.topologyMode.toLowerCase().replaceAll("_", " ")} topology · ${architecture.targetEnvironment.toLowerCase()}`
                    : "Not loaded"}
                </span>
              </div>
              <Button disabled={!snapshot} onClick={() => setArchitectureOpen(true)}>
                {architecture?.reason ? "Change decision" : "Record decision"}
              </Button>
            </Tile>
          </div>}

          {active.key === "profile" && <div className="mt-4 grid gap-3">
            <p className="m-0 text-caption leading-relaxed text-faint">
              Activating a Profile re-runs the AI-services check first: activation is refused until the Hermes API
              component has passed, and that check is the only thing that records it.
            </p>
            <Button
              className="justify-self-start"
              variant={active.status === "done" ? "ghost" : "primary"}
              disabled={busy !== null}
              onClick={() => void openProfiles()}
            >
              {busy === "ai-services" ? "Re-running the AI-services check…" : readiness.profileReady ? "Manage Agent Profiles" : "Create an Agent Profile"}
            </Button>
          </div>}
        </Panel>

        {active.key === "runtime" && <RuntimeNodesPanel
          targetEnvironment={architecture?.targetEnvironment ?? null}
          inferenceReady={readiness.inferenceReady}
          onConfigureInference={() => onConfigure("INFERENCE")}
          onNodesChange={onRuntimeNodesChange}
          onSessionExpired={onSessionExpired}
        />}
      </section>}
    </div>

    {allDone && <Panel>
      <PanelHeading
        className="mb-0"
        kicker="Setup complete"
        title="This installation is ready for governed sessions"
        description="Inference, the isolated runtime, and an active Agent Profile are all answering."
        actions={<Button variant="primary" onClick={() => onOpenWorkspace("Chat")}>Open Session</Button>}
      />
    </Panel>}

    <Panel className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <strong className="block text-label font-semibold text-text">Production controls stay out of the setup path.</strong>
          {/*
            Names only what an operator will actually find. The line used to
            list five destinations, three of which were wrong after this
            restructure: pilot readiness was deleted outright (nothing can
            create a readiness control), the activation record has no screen
            anywhere yet, and recovery is the button to the right of this
            sentence rather than something in Operations.
          */}
          <span className="mt-1 block text-body text-muted">
            Incidents and the audit trail live in Operations. Recovery is here.
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onOpenOperations}>Open Operations</Button>
          <Button variant="ghost" onClick={() => setRecoveryOpen(true)}>Installation recovery</Button>
        </div>
      </div>
      {/*
        * Stated at the point it matters — directly beneath the sentence that
        * sends an operator to Operations to record activation — rather than
        * left to look like their mistake once they get there.
        *
        * A PRODUCTION-target installation cannot record activation today, by
        * two independent server-side mechanisms, and nothing on this screen
        * changes either one. Deliberately not gated on the three steps being
        * finished: the deadlock is a property of the target, and an operator
        * blocked at step 2 for a related reason deserves to know it now.
        */}
      {productionBlocked && <Tile className="grid gap-1.5">
        <strong className="text-label font-semibold text-text">Recording activation needs backend work on a Production target.</strong>
        <span className="text-body leading-relaxed text-muted">
          Every passing automated check is downgraded to a warning when the target is Production, which leaves its
          component short of passed; and the gate adds a Production blocker until a readiness control is accepted, which
          nothing can create yet. The three steps above are unaffected — the attestation record is what is blocked.
        </span>
      </Tile>}
    </Panel>

    <Dialog
      open={architectureOpen}
      onClose={() => setArchitectureOpen(false)}
      kicker="Architecture decision"
      title="Topology and target environment"
      description="Saving this resets every recorded component to not-tested and every stage to not-started, because that evidence was proven against the previous architecture. Nothing is deleted, but everything has to be re-run."
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
            Production enrolment additionally requires a 40-character Hermes commit and an HTTPS OrcaSynapse origin.
          </StatusText>
        )}
      </form>
    </Dialog>

    <RecoveryKitDialog
      open={recoveryOpen}
      snapshot={snapshot}
      onClose={() => setRecoveryOpen(false)}
      onSnapshot={setSnapshot}
      onSessionExpired={onSessionExpired}
    />
  </div>;
}
