/**
 * @vitest-environment jsdom
 *
 * Setup as a three-step wizard.
 *
 * The screen this replaces was six unrelated blocks whose ordering an operator
 * had to infer from the order of the cards, with a terminal action that could
 * not be reached at all. The cases below are the ones that make it a sequence
 * rather than a page: one step open, every step re-openable, and every reason a
 * step is waiting attached to that step rather than pooled into a page-level
 * list whose count disagreed with its own contents.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so the populated screen can be
 * looked at without signing in, as elsewhere in this suite. This file carried
 * neither that nor an inline-style assertion before the rewrite, which made it
 * the only view test that could not have caught a CSP-breaking change.
 */
import type {
  AdministratorSession,
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
  OnboardingSnapshot,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = {
  generatedAt: "2026-08-15T00:00:00.000Z",
  installation: {},
  architecture: { topologyMode: "COMPACT", targetEnvironment: "DEVELOPMENT", reason: "Pilot", revision: 1 },
  recovery: { recoveryOwner: "Platform owner", revision: 3 },
  journey: { status: "IN_PROGRESS", activatedEnvironment: null, revision: 2 },
  components: [],
  steps: [],
  evidence: [],
  gate: { ready: false, blockers: [], warnings: [] },
} as unknown as OnboardingSnapshot;

const api = vi.hoisted(() => ({
  getOnboardingSnapshot: vi.fn(),
  getHermesRuntimeNodes: vi.fn(),
  runOnboardingValidation: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, ...api };
});

const { OnboardingView } = await import("./onboarding-view.js");

const session = { role: "PLATFORM_ADMIN", scopes: [], passwordChangeRequired: false } as unknown as AdministratorSession;

function connection(kind: ServiceKind, baseUrl: string): ServiceConnectionSummary {
  return {
    kind,
    baseUrl,
    enabled: true,
    status: "HEALTHY",
    configuration: kind === "INFERENCE" ? { modelAlias: "laguna-s" } : {},
    secretFieldNames: kind === "INFERENCE" ? ["apiKey"] : [],
  } as ServiceConnectionSummary;
}

const onlineNode = {
  id: "3f1d1b9c-5a5c-4a58-9a1e-8b7f3c2d1e00",
  slug: "hermes-runtime-01",
  displayName: "Hermes Runtime 01",
  baseUrl: "http://10.0.0.12:8642",
  status: "ONLINE",
  revision: 1,
  enrolledAt: "2026-08-15T00:00:00.000Z",
  revokedAt: null,
  lastSeenAt: "2026-08-15T00:00:00.000Z",
} as unknown as HermesRuntimeNode;

const activeProfile = { status: "ACTIVE" } as unknown as AgentProfile;
const enabledRuntime = { enabled: true } as unknown as AgentRuntimeControl;

const connectionEditor = {
  busy: false,
  monitoring: null,
  error: null,
  diagnostic: null,
  revisionConnectionId: null,
  revisionHistory: null,
  onSave: vi.fn(async () => undefined),
  onTest: vi.fn(async () => undefined),
  onDiscoverInference: vi.fn(async () => null),
  onLoadInferenceCatalogue: vi.fn(async () => null),
  onUpdateMonitoring: vi.fn(async () => undefined),
  onLoadRevisions: vi.fn(async () => undefined),
  onRollback: vi.fn(async () => undefined),
};

const callbacks = {
  onConfigure: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onRuntimeNodesChange: vi.fn(),
  onSignIn: vi.fn(),
  onSessionExpired: vi.fn(),
};

type Overrides = Partial<Parameters<typeof OnboardingView>[0]>;

function props(overrides: Overrides = {}) {
  return {
    session,
    oidcConfigured: false,
    connections: [],
    agentRuntime: null,
    profiles: [] as AgentProfile[],
    runtimeNodes: [] as HermesRuntimeNode[],
    connectionEditor,
    ...callbacks,
    ...overrides,
  };
}

/** Everything the first step needs, and nothing beyond it. */
const inferenceDone: Overrides = {
  connections: [connection("INFERENCE", "http://vllm.internal:8000")],
};

/** All three steps satisfied. */
const everythingDone: Overrides = {
  connections: [
    connection("INFERENCE", "http://vllm.internal:8000"),
    connection("HERMES", "http://hermes.internal:8642"),
  ],
  runtimeNodes: [onlineNode],
  profiles: [activeProfile],
  agentRuntime: enabledRuntime,
};

async function open(overrides: Overrides = {}) {
  render(<OnboardingView {...props(overrides)} />);
  // The snapshot load runs in an effect; every case below reads a screen that
  // has already seen it.
  await waitFor(() => expect(api.getOnboardingSnapshot).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
}

const rail = () => within(screen.getByRole("list", { name: "Setup steps" }));

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getOnboardingSnapshot.mockResolvedValue(snapshot);
  api.getHermesRuntimeNodes.mockResolvedValue({ items: [] });
  api.runOnboardingValidation.mockResolvedValue(snapshot);
  for (const spy of Object.values(callbacks)) spy.mockReset();
});

afterEach(cleanup);

describe("the setup wizard", () => {
  it("locks against a session that may not call admin routes, not merely a missing one", async () => {
    // `unlocked !== signed in`: the API refuses a session that still owes a
    // forced password change, so a view that took a bare boolean could render
    // a full workspace whose every request returns 403. This was the last admin
    // view taking that boolean rather than the session itself.
    render(<OnboardingView {...props({
      session: { ...session, passwordChangeRequired: true } as AdministratorSession,
    })} />);

    expect(screen.getByText("Sign in to this OrcaSynapse installation")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Setup steps" })).toBeNull();
    expect(api.getOnboardingSnapshot).not.toHaveBeenCalled();
  });

  it("draws three steps and expands exactly one", async () => {
    await open();

    expect(rail().getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Step 1: Connect an inference server" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Step 2:/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /^Step 3:/ })).toBeNull();
  });

  it("opens on the first unfinished step rather than always on the first", async () => {
    await open(inferenceDone);
    expect(screen.getByRole("region", { name: "Step 2: Install the agent runtime" })).toBeTruthy();
  });

  it("keeps a completed step collapsed but re-openable", async () => {
    const user = userEvent.setup();
    await open(inferenceDone);

    // Collapsed: step 1 is finished, so the body has moved on without it.
    expect(screen.queryByRole("region", { name: /^Step 1:/ })).toBeNull();

    await user.click(rail().getByRole("button", { name: /Connect an inference server/ }));
    expect(screen.getByRole("region", { name: "Step 1: Connect an inference server" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Step 2:/ })).toBeNull();
  });

  it("moves the address when a step is opened, so a reload lands back on it", async () => {
    /*
     * The defect this closes: the nodes panel was local state, so Back left
     * Settings entirely and reloading part-way through a twenty-minute VM2
     * install returned to the overview. Opening a step from the rail has to
     * reach the router, not just this component — otherwise the same defect
     * has only moved.
     */
    const user = userEvent.setup();
    const onSelectStep = vi.fn();
    render(<OnboardingView {...props({ ...inferenceDone, onSelectStep })} />);
    await waitFor(() => expect(screen.getByRole("list", { name: "Setup steps" })).toBeTruthy());

    await user.click(rail().getByRole("button", { name: /Create an Agent Profile/ }));

    expect(onSelectStep).toHaveBeenCalledWith("profile");
    expect(screen.getByRole("region", { name: "Step 3: Create an Agent Profile" })).toBeTruthy();
  });

  it("opens the step the address names", async () => {
    /*
     * Named against a state whose natural landing is step 2 and whose
     * last-resort fallback is step 3, so "the address chose this" is the only
     * thing that can put step 1 on screen. Pointing at the step the fallbacks
     * would have picked anyway proves nothing.
     */
    await open({ ...inferenceDone, initialStep: "inference" });
    expect(screen.getByRole("region", { name: "Step 1: Connect an inference server" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Step 2:/ })).toBeNull();
  });

  it("counts exactly what it draws", async () => {
    await open(inferenceDone);
    expect(screen.getByText("1 of 3")).toBeTruthy();

    const bar = screen.getByLabelText("1 of 3 setup steps complete") as HTMLProgressElement;
    expect(bar.value).toBe(1);
    expect(bar.max).toBe(3);
    // A computed inline width is what `style-src 'self'` refuses, so the
    // fraction has to be drawn by an element that carries it as data.
    expect(bar.getAttribute("style")).toBeNull();
  });

  it("puts every blocker inside the step it blocks, and none on the page", async () => {
    /*
     * The block this replaces printed `blockers.length` beside a
     * `.slice(0, 5)` of the same array — "10 blockers remain" over five rows.
     * A per-step list has no count to disagree with, and the assertion that
     * matters is that the reasons are *inside* the step's own region rather
     * than pooled somewhere above it.
     */
    await open();

    const step = within(screen.getByRole("region", { name: "Step 1: Connect an inference server" }));
    const waiting = step.getByRole("list", { name: "What step 1 is waiting on" });
    expect(within(waiting).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(waiting).getByText(/No inference connection is registered/)).toBeTruthy();

    // Nothing outside a step counts blockers at anyone.
    expect(screen.queryByText(/blockers remain/)).toBeNull();
  });

  it("connects inference on the step itself, not in a dialog over it", async () => {
    await open();

    const step = within(screen.getByRole("region", { name: "Step 1: Connect an inference server" }));
    expect(step.getByRole("radiogroup", { name: "Endpoint type" })).toBeTruthy();
    expect(step.getByRole("radio", { name: /Local server/ })).toBeTruthy();
    expect(step.getByRole("radio", { name: /Public endpoint/ })).toBeTruthy();
    expect(step.getByLabelText(/AI Inference address/)).toBeTruthy();
    expect(step.getByRole("button", { name: "Discover server" })).toBeTruthy();
    expect(step.getByRole("button", { name: /Create connection|Activate AI Inference/ })).toBeTruthy();
    expect(document.getElementById("connection-form")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect inference server/i })).toBeNull();
  });

  it("hands the nodes panel no target environment until the snapshot says so", async () => {
    /*
     * The panel used to be given `snapshot?.architecture.targetEnvironment ??
     * "DEVELOPMENT"`, so a PRODUCTION install whose snapshot had not arrived
     * was offered the development enrolment path — unpinned runtime, plain
     * HTTP — which the API then refuses. Held on the wiring rather than only in
     * the panel's own test, because the wrong value was supplied here.
     */
    let resolveSnapshot: (value: OnboardingSnapshot) => void = () => undefined;
    api.getOnboardingSnapshot.mockReturnValue(new Promise<OnboardingSnapshot>((resolve) => { resolveSnapshot = resolve; }));

    render(<OnboardingView {...props({ ...inferenceDone, initialStep: "runtime" })} />);
    await waitFor(() => expect(screen.getByRole("region", { name: /^Step 2:/ })).toBeTruthy());

    // Said twice on purpose: once as a reason this step is waiting, and once by
    // the panel that would otherwise be offering the installer.
    expect(screen.getAllByText(/The architecture decision has not loaded/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Generate installer" })).toHaveProperty("disabled", true);

    // And once it does arrive, the enrolment path opens normally — without
    // which the assertions above would pass against a panel that is simply
    // broken.
    await act(async () => {
      resolveSnapshot(snapshot);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate installer" })).toHaveProperty("disabled", false));
  });

  it("re-runs the AI-services check at the hand-off into step 3", async () => {
    /*
     * Profile activation is refused until the `hermes-api` component has
     * passed, and `POST /onboarding/validate` for the `ai-services` stage is
     * the only thing that records it. Setup never called it — its sole caller
     * was the Agents screen — so an operator following this screen's own
     * ordering was refused for a reason the screen had never mentioned.
     */
    const user = userEvent.setup();
    await open({ ...everythingDone, initialStep: "profile" });

    const step = within(screen.getByRole("region", { name: "Step 3: Create an Agent Profile" }));
    await user.click(step.getByRole("button", { name: /Agent Profiles?$/ }));

    expect(api.runOnboardingValidation).toHaveBeenCalledWith({ stageKey: "ai-services" });
    await waitFor(() => expect(callbacks.onOpenWorkspace).toHaveBeenCalledWith("Agents"));
  });

  it("keeps the blocks that are not setup steps off the setup screen", async () => {
    await open(everythingDone);
    const markup = document.body.innerHTML;

    // The update check moved to Settings → System.
    expect(markup).not.toContain("Check for updates");
    // The activation record moved to Operations.
    expect(markup).not.toContain("Activate installation");
    expect(markup).not.toContain("Activation rationale");
    // The Governed Chat promo is gone: it duplicated step 3 and its only
    // button was a disabled instruction that opened Chat anyway.
    expect(markup).not.toContain("Governed Chat");
    // The footer that pointed at Operations and recovery is gone with them.
    expect(markup).not.toContain("Production controls stay out of the setup path");
    expect(screen.queryByRole("button", { name: "Installation recovery" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Operations" })).toBeNull();
    // Topology/target is an install-time decision, not a Setup step-2 form.
    expect(screen.queryByRole("button", { name: /Record decision|Change decision/ })).toBeNull();
    expect(markup).not.toContain("Architecture decision");
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await open(everythingDone);
    // Assert the screen is populated first: a `not.toMatch` against markup that
    // failed to render passes vacuously.
    expect(screen.getByRole("list", { name: "Setup steps" })).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });

  it("draws the populated screen", async () => {
    await open(inferenceDone);
    expect(screen.getByRole("region", { name: /^Step 2:/ })).toBeTruthy();
    if (process.env.VIEW_PREVIEW_OUT) {
      writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
    }
  });
});
