/**
 * @vitest-environment jsdom
 *
 * Agent runs, under Operations. The execution ledger and run inspection used
 * to sit on Agents → Profiles beside the kill switch; they live here so
 * reporting sits with Health and the audit trail.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so it can be looked at without
 * a session; see `chat-transcript.test.tsx`.
 */
import { ADMIN_SCOPES } from "@orcasynapse/contracts";
import type {
  AdminScope, AdministratorSession, AgentProfile, AgentRun, AgentRunEvent,
} from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const version = {
  version: 3,
  displayName: "Support analyst",
  purpose: "Helps operators reason about their controlled environment.",
  instructions: "Be precise and state uncertainty.",
  soulMd: "Careful, evidence-led, candid about uncertainty.",
  skills: [],
  modelAlias: "hermes-agent",
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  distributionDigest: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6",
};

const profiles = [
  { id: "p1", slug: "support-analyst", status: "ACTIVE", activeVersion: 3, version },
  {
    id: "p2", slug: "draft-agent", status: "DRAFT", activeVersion: null,
    version: { ...version, version: 1, displayName: "Draft agent", purpose: "Not yet verified against Hermes." },
  },
] as unknown as AgentProfile[];

/** Newest first, as `listRuns` returns them. Two Profiles, so scoping is visible. */
const runs = [
  {
    id: "r1", profileId: "p1", profileName: "Support analyst", profileSlug: "support-analyst", profileVersion: 3,
    status: "COMPLETED", input: "What should we check before promoting?", output: "Three things: migrations, runtime, signature.",
    createdAt: "2026-08-07T09:00:00.000Z", queuedAt: "2026-08-07T09:00:00.000Z", updatedAt: "2026-08-07T09:00:06.000Z",
    startedAt: "2026-08-07T09:00:01.000Z", completedAt: "2026-08-07T09:00:06.000Z",
    profileDistributionDigest: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6", failureCode: null, failureMessage: null,
  },
  {
    id: "r2", profileId: "p2", profileName: "Draft agent", profileSlug: "draft-agent", profileVersion: 1,
    status: "COMPLETED", input: "Summarise the enrolment runbook.", output: "Four stages, two of them manual.",
    createdAt: "2026-08-06T09:00:00.000Z", queuedAt: "2026-08-06T09:00:00.000Z", updatedAt: "2026-08-06T09:00:04.000Z",
    startedAt: "2026-08-06T09:00:01.000Z", completedAt: "2026-08-06T09:00:04.000Z",
    profileDistributionDigest: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6", failureCode: null, failureMessage: null,
  },
] as unknown as AgentRun[];

/** Something to press Cancel on. The fixture runs above are all terminal. */
const runningRun = {
  ...runs[0]!, id: "r3", status: "RUNNING", output: null, completedAt: null,
} as unknown as AgentRun;

function sessionWith(role: AdministratorSession["role"], scopes: AdminScope[]): AdministratorSession {
  return {
    id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "admin", role, scopes,
    createdAt: "2026-08-07T00:00:00.000Z",
    idleExpiresAt: "2026-08-07T00:15:00.000Z", absoluteExpiresAt: "2026-08-07T08:00:00.000Z",
  };
}

const auditor = sessionWith("AUDITOR", ["agents:read"]);
const operations = sessionWith("OPERATIONS_ADMIN", ["agents:read", "agents:control", "readiness:manage"]);
const platform = sessionWith("PLATFORM_ADMIN", [...ADMIN_SCOPES]);

const events = [
  { id: "e1", type: "RUN_STARTED", summary: null, toolName: null, childSessionId: null, status: null, occurredAt: "2026-08-07T09:00:01.000Z", durationMs: null, inputTokens: null, outputTokens: null },
  { id: "e2", type: "RUN_COMPLETED", summary: "Answered from one source.", toolName: null, childSessionId: null, status: null, occurredAt: "2026-08-07T09:00:06.000Z", durationMs: 5_100, inputTokens: 880, outputTokens: 260 },
] as unknown as AgentRunEvent[];

const api = vi.hoisted(() => ({
  getAgentProfiles: vi.fn(),
  getAgentRuns: vi.fn(),
  getAgentRunEvents: vi.fn(),
  cancelAgentRun: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { AgentRunsView } = await import("./agent-runs-view.js");
const { OrcaSynapseApiError } = await import("./api.js");

const props = {
  unlocked: true,
  administrator: true,
  onConfigure: vi.fn(),
  onSessionExpired: vi.fn(),
};

interface ApiState {
  profiles?: AgentProfile[];
  runs?: AgentRun[];
}

function setupApi({ profiles: profileList = profiles, runs: runList = runs }: ApiState = {}) {
  api.getAgentProfiles.mockResolvedValue({ items: profileList, executionEnabled: true });
  api.getAgentRuns.mockResolvedValue({ items: runList });
  api.getAgentRunEvents.mockResolvedValue({ items: events });
  api.cancelAgentRun.mockResolvedValue({ ...runningRun, status: "CANCEL_REQUESTED" });
}

async function view(over: Partial<typeof props> & { session?: AdministratorSession | null } = {}) {
  render(<main><AgentRunsView {...props} {...over} /></main>);
  await waitFor(() => screen.getByLabelText("Execution ledger"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

function ledger(): HTMLElement {
  return screen.getByLabelText("Execution ledger");
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("agent runs", () => {
  it("fills the workspace instead of growing the page past the viewport", async () => {
    setupApi();
    await view();
    const workspace = document.querySelector(".agent-runs-workspace");
    expect(workspace?.className).toMatch(/\bflex\b/);
    expect(workspace?.className).toMatch(/\bh-full\b/);
    expect(workspace?.className).toMatch(/\bmin-h-0\b/);
  });

  it("opens unscoped, because this is a reporting surface", async () => {
    setupApi();
    await view();
    expect(within(ledger()).getByText("What should we check before promoting?")).toBeTruthy();
    expect(within(ledger()).getByText("Summarise the enrolment runbook.")).toBeTruthy();
    expect(within(ledger()).queryByRole("button", { name: /Show all runs/ })).toBeNull();
  });

  it("scopes the ledger to the Profile chosen in the filter", async () => {
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.selectOptions(screen.getByLabelText("Filter by profile"), "p1");
    await waitFor(() => expect(within(ledger()).queryByText("Summarise the enrolment runbook.")).toBeNull());
    expect(within(ledger()).getByText("What should we check before promoting?")).toBeTruthy();
  });

  it("offers the runs its own scoping hides, and nothing when it hides none", async () => {
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.selectOptions(screen.getByLabelText("Filter by profile"), "p1");
    await user.click(within(ledger()).getByRole("button", { name: "Show all runs (2)" }));

    await waitFor(() => expect(within(ledger()).getByText("Draft agent")).toBeTruthy());
    expect(within(ledger()).queryByRole("button", { name: /Show only/ })).toBeNull();
    expect((screen.getByLabelText("Filter by profile") as HTMLSelectElement).value).toBe("");

    cleanup();
    setupApi({ profiles: [profiles[0]!], runs: [runs[0]!] });
    await view();
    await userEvent.setup().selectOptions(screen.getByLabelText("Filter by profile"), "p1");
    expect(within(ledger()).getByText("What should we check before promoting?")).toBeTruthy();
    expect(within(ledger()).queryByRole("button", { name: /Show all runs/ })).toBeNull();
  });

  it("names the Profile in the empty ledger only once a filter is on", async () => {
    setupApi({ runs: [] });
    const user = userEvent.setup();
    await view();
    expect(within(ledger()).getByText("No runs yet")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Filter by profile"), "p1");
    expect(within(ledger()).getByText("Nothing has run under Support analyst")).toBeTruthy();
  });

  it("does not claim a Profile has never run when the window cannot see that far", async () => {
    const window200 = Array.from({ length: 200 }, (_, index) => ({
      ...runs[1]!, id: `w${index}`, createdAt: "2026-08-08T09:00:00.000Z",
    })) as AgentRun[];
    setupApi({ runs: window200 });
    const user = userEvent.setup();
    await view();
    await user.selectOptions(screen.getByLabelText("Filter by profile"), "p1");

    const panel = ledger();
    expect(within(panel).queryByText("Nothing has run under Support analyst")).toBeNull();
    expect(within(panel).getByText("Nothing by Support analyst in the newest 200 runs")).toBeTruthy();
    expect(within(panel).getByText(/older ones by Support analyst are not loaded/)).toBeTruthy();
    expect(within(panel).getByText("Produced by Support analyst, within the newest 200 runs.")).toBeTruthy();

    expect(within(panel).queryByRole("button", { name: "Show all runs (200)" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Show the newest 200 runs" })).toBeTruthy();
  });

  it("drops the detail pane entirely when there is nothing anywhere to select", async () => {
    setupApi({ runs: [] });
    await view();
    expect(ledger()).toBeTruthy();
    expect(screen.queryByLabelText("Run detail")).toBeNull();

    cleanup();
    setupApi();
    await view();
    expect(screen.getByLabelText("Run detail")).toBeTruthy();
  });

  it("opens a run's bounded activity timeline without leaving the screen", async () => {
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.click(within(ledger()).getByText("What should we check before promoting?"));
    const timeline = await screen.findByLabelText("Safe Hermes activity timeline");

    expect(within(timeline).getByText(/an omission is not an absence/)).toBeTruthy();
    expect(within(timeline).getByText(/Nothing strips a credential/)).toBeTruthy();
    expect(within(timeline).queryByText(/never retained here/)).toBeNull();
  });

  it("shows an AUDITOR the ledger and none of the controls that would 403", async () => {
    setupApi({ runs: [runningRun] });
    await view({ session: auditor });
    expect(screen.getByLabelText("Execution ledger")).toBeTruthy();
    expect(screen.getByLabelText("Run detail")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("lets an OPERATIONS_ADMIN cancel a run without authoring a Profile", async () => {
    setupApi({ runs: [runningRun] });
    await view({ session: operations });
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });

  it("takes nothing away from the role that holds every scope", async () => {
    setupApi({ runs: [runningRun] });
    await view({ session: platform });
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });

  it("surfaces a failed Refresh instead of leaving stale runs on screen", async () => {
    setupApi();
    const user = userEvent.setup();
    await view();
    api.getAgentRuns.mockRejectedValue(
      new OrcaSynapseApiError(401, "The administrator session has expired."),
    );

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("The administrator session has expired.")).toBeTruthy();
    expect(props.onSessionExpired).toHaveBeenCalled();
  });

  it("says whose runs the ledger is showing", async () => {
    setupApi();
    await view({ administrator: false });
    expect(within(ledger()).getByText("Your runs")).toBeTruthy();
    expect(within(ledger()).queryByText("All runs")).toBeNull();

    cleanup();
    setupApi();
    await view();
    expect(within(ledger()).getByText("All runs")).toBeTruthy();
  });

  it("does not tell a non-administrator that nothing has run under a Profile others use", async () => {
    setupApi({ runs: [] });
    const user = userEvent.setup();
    await view({ administrator: false });
    await user.selectOptions(screen.getByLabelText("Filter by profile"), "p1");
    const panel = ledger();
    expect(within(panel).getByText("You have not run Support analyst")).toBeTruthy();
    expect(within(panel).queryByText("Nothing has run under Support analyst")).toBeNull();
    expect(within(panel).getByText(/colleagues started against it are not shown/)).toBeTruthy();
  });

  it("keeps the ledger behind an authenticated workspace", () => {
    setupApi();
    render(<AgentRunsView {...props} unlocked={false} />);
    expect(screen.getByRole("heading", { name: "Agent runs" })).toBeTruthy();
    expect(api.getAgentRuns).not.toHaveBeenCalled();
    expect(api.getAgentProfiles).not.toHaveBeenCalled();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    setupApi();
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
