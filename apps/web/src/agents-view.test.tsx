/**
 * @vitest-environment jsdom
 *
 * Profiles, populated. It is the screen that decides what an agent may do.
 *
 * The kill switch and the execution ledger used to be here too, under a tab
 * called "Profiles & runs"; they now live on Runtime and are covered by
 * `agent-runtime-view.test.tsx`. What this file keeps is the configuration
 * half, plus one assertion that the execution half really left.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so it can be looked at without
 * a session; see `chat-transcript.test.tsx`.
 */
import type { AgentProfile } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getAgentProfiles: vi.fn(async () => ({ items: profiles })),
    getAgentRuntime: vi.fn(async () => ({ enabled: true, reason: "Verified against Hermes on node vm2-a." })),
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
  it("leaves execution to the Runtime tab and keeps only configuration", async () => {
    /*
     * The seam. Everything about a run -- the kill switch, the counters, the
     * ledger, the run detail -- belongs to Runtime now, and the only way to
     * state that from here is to assert their absence. A split that leaves the
     * old content behind under a narrower label is the failure mode this
     * catches.
     */
    await view();
    expect(screen.getByText("Profiles")).toBeTruthy();
    expect(screen.queryByText("Recent runs")).toBeNull();
    expect(screen.queryByText("ON")).toBeNull();
    expect(screen.queryByText("Hermes execution")).toBeNull();
    expect(screen.queryByLabelText("Hermes run summary")).toBeNull();
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

  it("points at the tab that now owns Hermes memory", async () => {
    /*
     * The editor's memory note used to say "Agents → Hermes corpus", a tab
     * that no longer exists. A stale cross-reference in a form that governs an
     * agent is worse than none: it sends the operator looking for a screen and
     * leaves them assuming the capability went away with the label.
     */
    const user = userEvent.setup();
    await view();
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Agents → Memory");
    expect(dialog.textContent).not.toContain("Hermes corpus");
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
