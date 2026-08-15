/**
 * @vitest-environment jsdom
 *
 * Runtime, the execution half of what used to be "Profiles & runs".
 *
 * The three tests that used to live in `agents-view.test.tsx` and describe
 * execution rather than configuration moved here with the code they cover: the
 * kill switch, and the bounded activity timeline. They are the reason the split
 * had to be a real one rather than two labels over one screen -- an operator
 * reaching for the kill switch is dealing with a problem, and should not have
 * to scroll past an immutable configuration list to find it.
 */
import type { AgentRun, AgentRunEvent } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const runs = [
  {
    id: "r1", profileName: "Support analyst", profileSlug: "support-analyst", profileVersion: 3,
    status: "COMPLETED", input: "What should we check before promoting?", output: "Three things: migrations, runtime, signature.",
    createdAt: "2026-08-07T09:00:00.000Z", queuedAt: "2026-08-07T09:00:00.000Z",
    startedAt: "2026-08-07T09:00:01.000Z", completedAt: "2026-08-07T09:00:06.000Z",
    profileDistributionDigest: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6", failureCode: null, failureMessage: null,
  },
] as unknown as AgentRun[];

const events = [
  { id: "e1", type: "RUN_STARTED", summary: null, toolName: null, childSessionId: null, status: null, occurredAt: "2026-08-07T09:00:01.000Z", durationMs: null, inputTokens: null, outputTokens: null },
  { id: "e2", type: "RUN_COMPLETED", summary: "Answered from one source.", toolName: null, childSessionId: null, status: null, occurredAt: "2026-08-07T09:00:06.000Z", durationMs: 5_100, inputTokens: 880, outputTokens: 260 },
] as unknown as AgentRunEvent[];

const api = vi.hoisted(() => ({
  getAgentRuns: vi.fn(),
  getAgentRunEvents: vi.fn(),
  getAgentRuntime: vi.fn(),
  getAgentMetrics: vi.fn(),
  cancelAgentRun: vi.fn(),
  updateAgentRuntime: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { AgentRuntimeView } = await import("./agent-runtime-view.js");

const props = {
  unlocked: true,
  administrator: true,
  oidcConfigured: false,
  onSignIn: vi.fn(),
  onConfigure: vi.fn(),
  onOpenProfiles: vi.fn(),
  onSessionExpired: vi.fn(),
};

function setupApi(enabled = true) {
  api.getAgentRuns.mockResolvedValue({ items: runs });
  api.getAgentRunEvents.mockResolvedValue({ items: events });
  api.getAgentRuntime.mockResolvedValue({ enabled, reason: "Verified against Hermes on node vm2-a." });
  api.getAgentMetrics.mockResolvedValue({
    profiles: 2, activeProfiles: 1, queuedRuns: 0, runningRuns: 0, completedRuns: 1, failedRuns: 0,
  });
  api.updateAgentRuntime.mockResolvedValue({ enabled: !enabled, reason: "Manual." });
}

async function view(over: Partial<typeof props> = {}) {
  render(<main><AgentRuntimeView {...props} {...over} /></main>);
  await waitFor(() => screen.getAllByText("Support analyst"));
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("agent runtime", () => {
  it("states the execution boundary as a word, not only a colour", async () => {
    // This is the kill switch. An operator reaching for it is already dealing
    // with a problem and should not have to infer the state from a hue.
    setupApi();
    await view();
    expect(screen.getByText("ON")).toBeTruthy();
    expect(screen.getByText("Ready for Chat")).toBeTruthy();
    expect(screen.getByText("Verified against Hermes on node vm2-a.")).toBeTruthy();
  });

  it("sends the operator to Profiles when the boundary has nothing to enable", async () => {
    /*
     * The boundary turns itself on with the first verified Profile, so a
     * disabled one is almost never a Runtime problem -- it is a Profiles
     * problem seen from here. Without this the split would have stranded the
     * operator: the sentence naming the fix would live on one tab and the fix
     * on another, with nothing joining them.
     */
    setupApi(false);
    const user = userEvent.setup();
    await view();
    expect(screen.getByText("OFF")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Profiles" }));
    expect(props.onOpenProfiles).toHaveBeenCalled();
  });

  it("carries the execution ledger and says what its timeline omits", async () => {
    // A bounded list read as a complete one would make absent tool arguments
    // look like tool calls that never happened.
    setupApi();
    const user = userEvent.setup();
    await view();
    expect(screen.getByText("Recent runs")).toBeTruthy();
    await user.click(screen.getAllByText("Support analyst")[0]!);
    const timeline = await screen.findByLabelText("Safe Hermes activity timeline");
    expect(within(timeline).getByText(/never retained here/)).toBeTruthy();
  });

  it("counts runs rather than profiles, which are another tab's subject", async () => {
    setupApi();
    await view();
    const summary = screen.getByLabelText("Hermes run summary");
    expect(within(summary).getByText("Completed runs")).toBeTruthy();
    expect(within(summary).getByText("Queued")).toBeTruthy();
    expect(within(summary).getByText("Running")).toBeTruthy();
    expect(within(summary).queryByText("Profiles")).toBeNull();
  });

  it("keeps the ledger behind an authenticated workspace", () => {
    render(<AgentRuntimeView {...props} unlocked={false} />);
    expect(screen.getByRole("heading", { name: "Agent Runtime" })).toBeTruthy();
    expect(api.getAgentRuns).not.toHaveBeenCalled();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    setupApi();
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
