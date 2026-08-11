/**
 * @vitest-environment jsdom
 *
 * Agents, populated — and its first test of any kind. It is the screen that
 * decides what an agent may do and carries the operator kill switch, and it had
 * no coverage.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so it can be looked at without
 * a session; see `chat-transcript.test.tsx`.
 */
import type { AgentProfile, AgentRun, AgentRunEvent } from "@orcasynapse/contracts";
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

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getAgentProfiles: vi.fn(async () => ({ items: profiles })),
    getAgentRuns: vi.fn(async () => ({ items: runs })),
    getAgentRunEvents: vi.fn(async () => ({ items: events })),
    getAgentRuntime: vi.fn(async () => ({ enabled: true, reason: "Verified against Hermes on node vm2-a." })),
    getAgentMetrics: vi.fn(async () => ({ profiles: 2, activeProfiles: 1, queuedRuns: 0, runningRuns: 0, completedRuns: 1 })),
  };
});

const { AgentsView } = await import("./agents-view.js");

const props = {
  unlocked: true,
  administrator: true,
  activationReady: true as boolean | null,
  activationMessage: null as string | null,
  oidcConfigured: false,
  onSignIn: vi.fn(),
  onConfigure: vi.fn(),
  onOpenChat: vi.fn(),
  onOpenReadiness: vi.fn(),
  onSessionExpired: vi.fn(),
};

async function view(over: Partial<typeof props> = {}) {
  render(<main><AgentsView {...props} {...over} /></main>);
  await waitFor(() => screen.getAllByText("Support analyst"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(cleanup);

describe("agents", () => {
  it("states the execution boundary as a word, not only a colour", async () => {
    // This is the kill switch. An operator reaching for it is already dealing
    // with a problem and should not have to infer the state from a hue.
    await view();
    expect(screen.getByText("ON")).toBeTruthy();
    expect(screen.getByText("Ready for Chat")).toBeTruthy();
    expect(screen.getByText("Verified against Hermes on node vm2-a.")).toBeTruthy();
  });

  it("shows the distribution digest on the row, since that is what VM2 admits", async () => {
    // Both profiles carry it, which is the point — it identifies the build,
    // not the profile.
    await view();
    expect(screen.getAllByText(/distro 9f2c4a1b7e/)).toHaveLength(2);
  });

  it("offers Suspend on an active profile and verification on one that is not", async () => {
    await view();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify & activate" })).toBeTruthy();
  });

  it("says what the activity timeline deliberately omits", async () => {
    // A bounded list read as a complete one would make absent tool arguments
    // look like tool calls that never happened.
    const user = userEvent.setup();
    await view();
    await user.click(screen.getAllByText("Support analyst")[0]!);
    const timeline = await screen.findByLabelText("Safe Hermes activity timeline");
    expect(within(timeline).getByText(/never retained here/)).toBeTruthy();
  });

  it("keeps drafting possible while telling the operator activation is not", async () => {
    await view({ activationReady: false, activationMessage: "VM2 is not enrolled yet." });
    expect(screen.getByText("Profiles can be drafted now")).toBeTruthy();
    expect(screen.getByText("VM2 is not enrolled yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft" })).toBeTruthy();
  });

  it("traps focus in the profile editor, which decides what an agent may do", async () => {
    const user = userEvent.setup();
    await view();
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    for (let press = 0; press < 8; press += 1) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
