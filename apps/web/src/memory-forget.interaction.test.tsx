/**
 * @vitest-environment jsdom
 *
 * The preview is the whole safety argument for a semantic bulk delete, so it is
 * worth proving that nothing is forgotten before the operator confirms — and
 * that the confirm sends the same request with the dry run turned off.
 */
import { ADMIN_SCOPES, type AdministratorSession } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-08-06T00:00:00.000Z",
  idleExpiresAt: "2026-08-06T01:00:00.000Z",
  absoluteExpiresAt: "2026-08-06T08:00:00.000Z",
};

const records = {
  items: [{
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    ownerSubject: "user:ada",
    agentProfileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    agentProfileSlug: "support-agent",
    content: "The user leads the Titan migration.",
    profileScope: "EPISODIC" as const,
    sourceRunId: null,
    retentionUntil: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  }],
};

const forgetMatchingAgentMemory = vi.fn(async (input: { dryRun: boolean }) => ({
  dryRun: input.dryRun,
  forgetBatchId: input.dryRun ? null : "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  candidates: [{
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    content: "The user leads the Titan migration.",
    profileScope: "EPISODIC" as const,
    matched: true,
  }],
  matched: 1,
  forgotten: input.dryRun ? 0 : 1,
  truncated: false,
  capped: false,
}));

/**
 * A macrotask of latency on both loads, because a mock that answers inside the
 * same microtask queue as the keystroke that caused it models a local variable,
 * not a control plane across a link.
 *
 * It is not decoration. While the filter box was itself the fetch key, opening
 * this screen and typing into its three fields ran twenty-five load cycles, and
 * under this mock on a loaded machine the first case here failed on the 5000 ms
 * timeout in two of four whole-suite runs. Post-commit it runs two.
 */
const afterOneMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getMemoryPolicies: vi.fn(async () => { await afterOneMacrotask(); return { items: [] }; }),
    getAgentMemoryRecords: vi.fn(async () => { await afterOneMacrotask(); return records; }),
    forgetMatchingAgentMemory,
  };
});

const { MemoryView } = await import("./memory-view.js");

const props = { session, onOpenSettings: vi.fn(), onSessionExpired: vi.fn() };

beforeEach(() => { forgetMatchingAgentMemory.mockClear(); });
afterEach(cleanup);

describe("forget by topic", () => {
  /**
   * The control only appears once a person is named, so every case starts here.
   * Naming is two steps: the box is a draft, and the panel is scoped to the
   * value committed out of it, so nothing below exists before the click.
   */
  async function openFor(user: ReturnType<typeof userEvent.setup>) {
    render(<MemoryView {...props} />);
    await user.type(await screen.findByPlaceholderText(/filter by person/i), "user:ada");
    await user.click(screen.getByRole("button", { name: /^filter$/i }));
    await user.type(screen.getByLabelText(/decision reason/i), "They asked us to forget it.");
    await user.type(await screen.findByPlaceholderText(/project titan/i), "Project Titan");
  }

  it("previews the matches without forgetting anything", async () => {
    const user = userEvent.setup();
    await openFor(user);

    await user.click(screen.getByRole("button", { name: /preview what matches/i }));

    // Scoped by walking up from the summary to the element that owns the list,
    // rather than by class name: `.closest(".memory-forget-preview")!` threw a
    // TypeError instead of failing cleanly once that class moved.
    const summary = await screen.findByText(/judged to be about/i);
    const previewPanel = summary.parentElement!;
    const items = previewPanel.querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(previewPanel.textContent).toContain("The user leads the Titan migration.");
    expect(forgetMatchingAgentMemory).toHaveBeenCalledTimes(1);
    expect(forgetMatchingAgentMemory.mock.calls[0]?.[0]).toMatchObject({
      ownerSubject: "user:ada", target: "Project Titan", dryRun: true,
    });
  });

  it("commits only after the operator confirms the preview", async () => {
    const user = userEvent.setup();
    await openFor(user);
    await user.click(screen.getByRole("button", { name: /preview what matches/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /forget these 1/i })).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /forget these 1/i }));

    await waitFor(() => expect(forgetMatchingAgentMemory).toHaveBeenCalledTimes(2));
    expect(forgetMatchingAgentMemory.mock.calls[1]?.[0]).toMatchObject({
      ownerSubject: "user:ada", target: "Project Titan", dryRun: false,
    });
  });

  it("will not preview once the audit reason is cleared", async () => {
    // Every forget is recorded with a reason, so an empty one blocks the action
    // rather than writing a blank into the trail.
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    await user.type(await screen.findByPlaceholderText(/filter by person/i), "user:ada");
    await user.click(screen.getByRole("button", { name: /^filter$/i }));
    await user.type(await screen.findByPlaceholderText(/project titan/i), "Project Titan");
    await user.clear(screen.getByLabelText(/decision reason/i));

    expect(screen.getByRole("button", { name: /preview what matches/i })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: /preview what matches/i }));
    expect(forgetMatchingAgentMemory).not.toHaveBeenCalled();
  });

  it("says plainly when nothing matched, rather than showing an empty list", async () => {
    forgetMatchingAgentMemory.mockResolvedValueOnce({
      dryRun: true, forgetBatchId: null, candidates: [], matched: 0, forgotten: 0,
      truncated: false, capped: false,
    });
    const user = userEvent.setup();
    await openFor(user);

    await user.click(screen.getByRole("button", { name: /preview what matches/i }));

    await waitFor(() => expect(screen.getByText(/nothing matched/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /forget these/i })).toBeNull();
  });

  it("warns when the scan could not read everything stored", async () => {
    // Silent truncation would let "1 matched" stand for a scan that never
    // reached most of the person's memory.
    forgetMatchingAgentMemory.mockResolvedValueOnce({
      dryRun: true,
      forgetBatchId: null,
      candidates: [{
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        content: "The user leads the Titan migration.",
        profileScope: "EPISODIC" as const,
        matched: true,
      }],
      matched: 1, forgotten: 0, truncated: true, capped: false,
    });
    const user = userEvent.setup();
    await openFor(user);

    await user.click(screen.getByRole("button", { name: /preview what matches/i }));

    await waitFor(() => expect(screen.getByText(/the scan was partial/i)).toBeTruthy());
  });
});
