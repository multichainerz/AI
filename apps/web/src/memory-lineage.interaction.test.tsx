/**
 * @vitest-environment jsdom
 *
 * Version chains shipped in v0.9.0 and forget batches in v1.0.0, and
 * neither was visible anywhere until now — the contract did not carry the fields
 * and the list had no lifecycle predicate, so a corrected fact and its
 * replacement appeared side by side, identical. These cases hold that shut.
 */
import { ADMIN_SCOPES, type AdministratorSession, type AgentMemoryRecord } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-08-07T00:00:00.000Z",
  idleExpiresAt: "2026-08-07T01:00:00.000Z",
  absoluteExpiresAt: "2026-08-07T08:00:00.000Z",
};

const base = {
  ownerSubject: "user:ada",
  agentProfileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  agentProfileSlug: "support-agent",
  profileScope: "STATIC" as const,
  sourceRunId: null,
  retentionUntil: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  parentMemoryId: null,
  rootMemoryId: null,
  supersededAt: null,
  supersededReason: null,
  forgottenAt: null,
  forgetReason: null,
  forgetBatchId: null,
};

const current: AgentMemoryRecord = {
  ...base,
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  content: "The user works in Bandung.",
  version: 2,
  parentMemoryId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  rootMemoryId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  isLatest: true,
};

const retired: AgentMemoryRecord = {
  ...base,
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  content: "The user works in Jakarta.",
  version: 1,
  isLatest: false,
  supersededAt: "2026-08-07T00:30:00.000Z",
  supersededReason: "Superseded by a later statement: The user works in Bandung.",
};

const forgotten: AgentMemoryRecord = {
  ...base,
  id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  content: "The user leads the Titan migration.",
  version: 1,
  isLatest: true,
  forgottenAt: "2026-08-07T00:45:00.000Z",
  forgetReason: "They asked us to forget the project.",
  forgetBatchId: "6d5af930-66fb-4741-a9e2-1665c3730546",
};

const getAgentMemoryRecords = vi.fn(async (query: { includeHistory?: boolean } = {}) => ({
  items: query.includeHistory ? [current, retired, forgotten] : [current],
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, getMemoryPolicies: vi.fn(async () => ({ items: [] })), getAgentMemoryRecords };
});

const { MemoryView } = await import("./memory-view.js");
const props = { session, onOpenSettings: vi.fn(), onSessionExpired: vi.fn() };

beforeEach(() => { getAgentMemoryRecords.mockClear(); });
afterEach(cleanup);

describe("memory lineage", () => {
  it("lists only what the agent would recall, until history is asked for", async () => {
    render(<MemoryView {...props} />);

    await screen.findByText("The user works in Bandung.");
    expect(screen.queryByText("The user works in Jakarta.")).toBeNull();
    expect(getAgentMemoryRecords.mock.calls[0]?.[0]).toMatchObject({ includeHistory: false });
  });

  it("says a fact was corrected rather than presenting it as original", async () => {
    render(<MemoryView {...props} />);

    // v2 is the whole point: without it a corrected fact reads as a first
    // statement and nothing hints that an earlier belief existed.
    await waitFor(() => expect(screen.getByText("v2")).toBeTruthy());
  });

  it("brings in corrections and forgotten facts on request, with their reasons", async () => {
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    await screen.findByText("The user works in Bandung.");

    await user.click(screen.getByLabelText(/show corrected and forgotten/i));

    await waitFor(() => expect(screen.getByText("The user works in Jakarta.")).toBeTruthy());
    expect(screen.getByText("superseded")).toBeTruthy();
    expect(screen.getByText(/Retired: Superseded by a later statement/)).toBeTruthy();
    expect(screen.getByText("forgotten")).toBeTruthy();
    expect(screen.getByText(/Forgotten: They asked us to forget the project/)).toBeTruthy();
    expect(getAgentMemoryRecords.mock.calls.at(-1)?.[0]).toMatchObject({ includeHistory: true });
  });

  it("offers Forget only on a fact that is still live", async () => {
    // Forgetting something already retired or already forgotten is a no-op that
    // would still write an audit entry claiming an operator did something.
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    await screen.findByText("The user works in Bandung.");
    expect(screen.getAllByRole("button", { name: /^forget$/i })).toHaveLength(1);

    await user.click(screen.getByLabelText(/show corrected and forgotten/i));

    await waitFor(() => expect(screen.getByText("The user works in Jakarta.")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: /^forget$/i })).toHaveLength(1);
  });
});
