import type {
  AdministratorSession,
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
  OnboardingSnapshot,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { ListChecks } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ConnectionDrawer } from "./connection-drawer.js";
import { adminAccess } from "./admin-access.js";
import {
  OrcaSynapseApiError,
  getOnboardingSnapshot,
  runOnboardingValidation,
} from "./api.js";
import { connectionReadiness } from "./connection-readiness.js";
import { connectionFor, deriveWorkspaceReadiness } from "./platform-readiness.js";
import {
  DEFAULT_HERMES_COMMIT,
  RuntimeNodesPanel,
  defaultControlPlaneUrl,
} from "./runtime-nodes-panel.js";
import { deriveSetupSteps, type SetupStep, type SetupStepKey } from "./setup-steps.js";
import {
  Alert, Button, LockedScreen, MicroLabel,
  Panel, PanelHeading, StatusText, StepList, Tile, WorkspaceIntro, cn,
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
  /**
   * The inference editor, in the step that owns it. The same callbacks the
   * connection dialog uses everywhere else — only the chrome is different.
   */
  connectionEditor: Pick<
    ComponentProps<typeof ConnectionDrawer>,
    | "busy"
    | "monitoring"
    | "error"
    | "diagnostic"
    | "revisionConnectionId"
    | "revisionHistory"
    | "onSave"
    | "onTest"
    | "onDiscoverInference"
    | "onLoadInferenceCatalogue"
    | "onUpdateMonitoring"
    | "onLoadRevisions"
    | "onRollback"
  >;
  onOpenWorkspace: (workspace: "Chat" | "Agents") => void;
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
 *    moved to Settings → System, the activation record to Operations, the
 *    Governed Chat promo was deleted (it duplicated step 3 and its only button
 *    was a disabled instruction), and the footer that pointed at Operations
 *    and recovery is gone with them — those surfaces have their own tabs.
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
  connectionEditor,
  onOpenWorkspace,
  onRuntimeNodesChange,
  onSignIn,
  onSessionExpired,
}: OnboardingViewProps) {
  const { unlocked } = adminAccess(session);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [openStep, setOpenStep] = useState<SetupStepKey | null>(initialStep);
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
  return <div className="workspace-stack onboarding-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
    <WorkspaceIntro
      icon={<ListChecks className="size-4" aria-hidden="true" />}
      title="Bring this installation up"
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

    {error && <Alert className="shrink-0" onDismiss={() => setError(null)}>{error}</Alert>}

    <div className="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-[264px_minmax(0,1fr)]">
      <Panel className="min-h-0 overflow-y-auto p-3">
      <StepList
        label="Setup steps"
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
      </Panel>

      <div className="grid min-h-0 content-start gap-3 overflow-y-auto">
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
                  {inference?.baseUrl ?? "Choose a local server or a public OpenRouter endpoint."}
                </span>
              </div>
              <StatusText dot tone={connectionReadiness(inference).tone === "ready" ? "good" : inference ? "warn" : "neutral"}>
                {connectionReadiness(inference).label}
              </StatusText>
            </Tile>
            <ConnectionDrawer
              embedded
              open
              initialKind="INFERENCE"
              connections={connections}
              busy={connectionEditor.busy}
              monitoring={connectionEditor.monitoring}
              error={connectionEditor.error}
              diagnostic={connectionEditor.diagnostic}
              revisionConnectionId={connectionEditor.revisionConnectionId}
              revisionHistory={connectionEditor.revisionHistory}
              onClose={() => undefined}
              onOpenAgenticSystem={() => undefined}
              onSave={connectionEditor.onSave}
              onTest={connectionEditor.onTest}
              onDiscoverInference={connectionEditor.onDiscoverInference}
              onLoadInferenceCatalogue={connectionEditor.onLoadInferenceCatalogue}
              onUpdateMonitoring={connectionEditor.onUpdateMonitoring}
              onLoadRevisions={connectionEditor.onLoadRevisions}
              onRollback={connectionEditor.onRollback}
            />
          </div>}

          {active.key === "runtime" && (
            <div className="mt-4">
              <RuntimeNodesPanel
                targetEnvironment={architecture?.targetEnvironment ?? null}
                inferenceReady={readiness.inferenceReady}
                onConfigureInference={() => {
                  setOpenStep("inference");
                  onSelectStep?.("inference");
                }}
                onNodesChange={onRuntimeNodesChange}
                onSessionExpired={onSessionExpired}
              />
            </div>
          )}

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
      </section>}

    {allDone && <Panel>
      <PanelHeading
        className="mb-0"
        kicker="Setup complete"
        title="This installation is ready for governed sessions"
        description="Inference, the isolated runtime, and an active Agent Profile are all answering."
        actions={<Button variant="primary" onClick={() => onOpenWorkspace("Chat")}>Open Session</Button>}
      />
    </Panel>}
      </div>
    </div>
  </div>;
}
