import type {
  AdministratorSession,
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
  ModelDeployment,
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
  getModelDeployments,
  getOnboardingSnapshot,
  runOnboardingValidation,
} from "./api.js";
import { deriveWorkspaceReadiness } from "./platform-readiness.js";
import {
  DEFAULT_HERMES_COMMIT,
  RuntimeNodesPanel,
  defaultControlPlaneUrl,
} from "./runtime-nodes-panel.js";
import { deriveSetupSteps, type SetupStep, type SetupStepKey } from "./setup-steps.js";
import {
  Alert, Button, EmptyState, LockedScreen, Mark, MicroLabel,
  Panel, PanelHeading, StatusText, StepList, Tile, WorkspaceIntro, cn,
} from "./ui/index.js";

interface OnboardingViewProps {
  session: AdministratorSession | null;
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
    | "error"
    | "diagnostic"
    | "onSave"
    | "onTest"
    | "onDiscoverInference"
    | "onLoadInferenceCatalogue"
    | "canWrite"
    | "canTest"
  >;
  onOpenWorkspace: (workspace: "Chat" | "Agents") => void;
  onRuntimeNodesChange: (nodes: HermesRuntimeNode[]) => void;
  onSessionExpired: () => void;
}

const stepTone = { done: "good", current: "accent", blocked: "warn" } as const;
const stepStatusLabel = { done: "Done", current: "In progress", blocked: "Waiting" } as const;
const stepMark = {
  done: "border-good/40 bg-good/10 text-good",
  current: "border-accent/50 bg-raised text-accent",
  blocked: "border-border-strong bg-raised text-faint",
} as const;

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
  initialStep = null,
  onSelectStep,
  onConfigure,
  connectionEditor,
  onOpenWorkspace,
  onRuntimeNodesChange,
  onSessionExpired,
}: OnboardingViewProps) {
  const { unlocked } = adminAccess(session);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [modelDeployments, setModelDeployments] = useState<ModelDeployment[]>([]);
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
      setModelDeployments([]);
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
    const loadModels = () => {
      void getModelDeployments().then(({ items }) => {
        if (active) setModelDeployments(items);
      }).catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
      });
    };
    loadModels();
    const timer = window.setInterval(loadModels, 15_000);
    return () => { active = false; window.clearInterval(timer); };
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
      actionLabel="Sign in locally"
      onAction={() => onConfigure()}
    />;
  }

  const readiness = deriveWorkspaceReadiness({
    connections, runtimeNodes, profiles, runtime: agentRuntime, modelDeployments,
  });
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
        /*
          * One line, not a three-line score card. This was a `text-figure`
          * fraction stacked over a label and a rule, which made the count the
          * loudest thing on a screen whose subject is the step you are on --
          * and it pushed the header past the height every other workspace uses.
          */
        <div className="flex items-center gap-2.5">
          <span className={cn("font-mono text-caption tabular-nums", allDone ? "text-good" : "text-warn")}>
            {done} of {steps.length}
          </span>
          <span className="text-caption text-muted">steps complete</span>
          {/*
            * `<progress>` rather than a div with a computed width: the fraction
            * is data, and `style-src 'self'` refuses the inline width that
            * would express it.
            */}
          <progress
            className={cn("metric-progress block h-0.5 w-[72px]", allDone ? "is-good" : "is-warn")}
            aria-label={`${done} of ${steps.length} setup steps complete`}
            value={done}
            max={steps.length}
          />
        </div>
      }
    >
      {/*
        * The run of steps sits in the intro card so step 1 does not spend a
        * second panel repeating "where am I". Below `sm` the run stacks back
        * into the vertical rail, which is the only shape three titled steps
        * fit at phone width.
        */}
      <StepList
        label="Setup steps"
        orientation="horizontal"
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
    </WorkspaceIntro>

    {error && <Alert className="shrink-0" onDismiss={() => setError(null)}>{error}</Alert>}

    <div className="grid min-h-0 flex-1 content-start items-start gap-3 overflow-hidden">
      {active && (
        <Panel
          aria-label={`Step ${active.ordinal}: ${active.title}`}
          className="min-h-0 overflow-hidden p-0"
        >
          {/*
            * Step 1 already names itself in the intro rail. Repeating the
            * marker, kicker, title and status here was a second header over
            * the form and is why this step scrolled on a laptop viewport.
            */}
          {active.key !== "inference" && (
            <div className="flex items-start gap-3 p-5">
              <Mark size="sm" className={cn("mt-0.5 border", stepMark[active.status])}>
                {active.status === "done" ? "✓" : active.ordinal}
              </Mark>
              <PanelHeading
                className="mb-0 min-w-0 flex-1"
                kicker={`Step ${active.ordinal} of ${steps.length}`}
                title={active.title}
                actions={<StatusText dot tone={stepTone[active.status]}>{stepStatusLabel[active.status]}</StatusText>}
              />
            </div>
          )}

          {/*
            * Every reason, not the first five. The list this replaces printed a
            * count taken from the whole array beside a `.slice(0, 5)` of it, so
            * the screen contradicted itself whenever more than five things were
            * wrong — which is exactly when an operator is reading it.
            *
            * One labelled list, not a stack of warn tiles: those tiles were
            * the loudest thing on the card, so the form that actually clears
            * them sat under what looked like the work.
            */}
          {active.blockedBy.length > 0 && (
            <div className={cn(
              "bg-raised px-4 py-2.5",
              active.key !== "inference" && "border-t border-border",
            )}>
              <MicroLabel className="mb-1.5 block">Waiting on</MicroLabel>
              <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={`What step ${active.ordinal} is waiting on`}>
                {active.blockedBy.map((blocker) => (
                  <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 text-caption text-text" key={blocker}>
                    <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />
                    {blocker}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={cn(
            "grid gap-3 p-4",
            (active.key !== "inference" || active.blockedBy.length > 0) && "border-t border-border",
            active.key !== "inference" && "p-5",
            active.key === "inference" && "min-h-0 overflow-y-auto",
          )}>
          {active.key === "inference" && (
            <ConnectionDrawer
              embedded
              open
              initialKind="INFERENCE"
              connections={connections}
              busy={connectionEditor.busy}
              error={connectionEditor.error}
              diagnostic={connectionEditor.diagnostic}
              onClose={() => undefined}
              onOpenAgenticSystem={() => undefined}
              onSave={connectionEditor.onSave}
              onTest={connectionEditor.onTest}
              onDiscoverInference={connectionEditor.onDiscoverInference}
              onLoadInferenceCatalogue={connectionEditor.onLoadInferenceCatalogue}
              canWrite={connectionEditor.canWrite ?? true}
              canTest={connectionEditor.canTest ?? true}
            />
          )}

          {active.key === "runtime" && (
            <RuntimeNodesPanel
              session={session}
              targetEnvironment={architecture?.targetEnvironment ?? null}
              inferenceReady={readiness.inferenceReady}
              agentModelReady={readiness.agentModelReady}
              inferenceConnection={readiness.inferenceReady
                ? connections.find((connection) => connection.kind === "INFERENCE" && connection.enabled && connection.status === "HEALTHY") ?? null
                : null}
              onConfigureInference={() => {
                setOpenStep("inference");
                onSelectStep?.("inference");
              }}
              onNodesChange={onRuntimeNodesChange}
              onAgentModelReady={() => {
                void getModelDeployments().then(({ items }) => setModelDeployments(items)).catch((cause: unknown) => {
                  if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
                });
              }}
              onSessionExpired={onSessionExpired}
            />
          )}

          {active.key === "profile" && (
            readiness.profileReady ? (
              <Tile pad="lg" className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <MicroLabel className="mb-1 block">Ready</MicroLabel>
                  <strong className="block text-label font-semibold text-text">An Agent Profile is active</strong>
                  <p className="mb-0 mt-1 max-w-[62ch] text-body text-muted">
                    Opening Profiles re-runs the AI-services check. That check is the only record that Hermes is ready.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void openProfiles()}
                >
                  {busy === "ai-services" ? "Re-running the AI-services check…" : "Manage Agent Profiles"}
                </Button>
              </Tile>
            ) : (
              <EmptyState
                title="Create the profile a session runs under"
                action={
                  <Button
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => void openProfiles()}
                  >
                    {busy === "ai-services" ? "Re-running the AI-services check…" : "Create an Agent Profile"}
                  </Button>
                }
              >
                Activation re-runs the AI-services check first, and is refused until the Hermes API check has passed.
              </EmptyState>
            )
          )}
          </div>
        </Panel>
      )}

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
  </div>;
}
