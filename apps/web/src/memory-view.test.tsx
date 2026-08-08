/**
 * @vitest-environment jsdom
 *
 * Two ways this screen could act on something other than what it showed.
 *
 * The bulk forget read the person out of the filter box again at commit time,
 * while the preview was only withdrawn when the *topic* changed. Preview against
 * one person, correct the filter to another, confirm — and the second person's
 * memory was forgotten irreversibly, under a confirmation on screen that
 * described the first. And Edit seeded the draft from the whole policy row, so
 * the PATCH carried nine server-owned columns into a `.strict()` schema: every
 * policy edit died at the door with raw Zod text in the error banner.
 */
import {
  ADMIN_SCOPES,
  updateMemoryPolicySchema,
  type AdministratorSession,
  type AgentMemoryRecord,
  type MemoryPolicy,
} from "@orcasynapse/contracts";
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

/** DRAFT, not ACTIVE: Edit is only offered on a policy that is not live. */
const policy: MemoryPolicy = {
  id: "b7f0f5f6-9a4a-4a3e-9a54-6c0c1a2b3c4d",
  slug: "default-memory",
  displayName: "Default memory policy",
  description: "Bounds what every agent may remember about the people it serves.",
  status: "DRAFT",
  revision: 4,
  firstActivatedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  maximumCaptureMode: "LEARN_USER",
  retentionDays: 365,
  maximumItemsPerOwner: 500,
  recallLimit: 6,
  recallMinimumScore: 0.4,
  knowledgeRecallLimit: 18,
  knowledgeMinimumScore: 0.35,
  distillCapture: true,
};

/** The columns the server owns. None of them may ride out on a PATCH. */
const SERVER_OWNED_KEYS = [
  "id", "slug", "status", "revision", "firstActivatedAt",
  "createdBy", "updatedBy", "createdAt", "updatedAt",
];

function recordFor(ownerSubject: string): AgentMemoryRecord {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    ownerSubject,
    agentProfileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    agentProfileSlug: "support-agent",
    content: `${ownerSubject} leads the Titan migration.`,
    profileScope: "EPISODIC",
    sourceRunId: null,
    retentionUntil: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    version: 1,
    parentMemoryId: null,
    rootMemoryId: null,
    isLatest: true,
    supersededAt: null,
    supersededReason: null,
    forgottenAt: null,
    forgetReason: null,
    forgetBatchId: null,
  };
}

/**
 * Armed where the timing of an answer is the point. A mock that resolves inside
 * the same microtask queue as the keystroke that caused it models a local
 * variable rather than a control plane, and it hides what an operator on a real
 * link gets: a response landing *between* two keystrokes, re-rendering the
 * field under the caret.
 */
let recordFetchLatency: "immediate" | "macrotask" = "immediate";

const getAgentMemoryRecords = vi.fn(async (query: { ownerSubject?: string } = {}) => {
  if (recordFetchLatency === "macrotask") await new Promise((resolve) => setTimeout(resolve, 0));
  return { items: [recordFor(query.ownerSubject ?? "user:ada")] };
});

/** Echoes the owner back in the candidate text, so a mismatch is legible. */
const forgetMatchingAgentMemory = vi.fn(
  async (input: { ownerSubject: string; target: string; reason: string; dryRun: boolean }) => ({
    dryRun: input.dryRun,
    forgetBatchId: input.dryRun ? null : "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    candidates: [{
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      content: `${input.ownerSubject} leads the Titan migration.`,
      profileScope: "EPISODIC" as const,
      matched: true,
    }],
    matched: 1,
    forgotten: input.dryRun ? 0 : 1,
    truncated: false,
    capped: false,
  }),
);

const updateMemoryPolicy = vi.fn(async (_id: string, _input: Record<string, unknown>) => policy);

/** The irreversible one. Nothing stands between this call and the deletion. */
const purgeAgentMemory = vi.fn(async (_ownerSubject: string, _reason: string) => ({ forgotten: 1 }));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getMemoryPolicies: vi.fn(async () => ({ items: [policy] })),
    getAgentMemoryRecords,
    forgetMatchingAgentMemory,
    updateMemoryPolicy,
    purgeAgentMemory,
  };
});

const { MemoryView } = await import("./memory-view.js");
const props = { session, onOpenSettings: vi.fn(), onSessionExpired: vi.fn() };

beforeEach(() => {
  recordFetchLatency = "immediate";
  getAgentMemoryRecords.mockClear();
  forgetMatchingAgentMemory.mockClear();
  updateMemoryPolicy.mockClear();
  purgeAgentMemory.mockClear();
});
afterEach(cleanup);

describe("choosing whose memory is under review", () => {
  it("does not re-query the control plane for every character of a name", async () => {
    // The filter box used to be the fetch key itself, so an eight-character
    // name was eight `getAgentMemoryRecords` calls and eight `getMemoryPolicies`
    // calls — seven of each asking about people who do not exist, all of them
    // landing while the operator was still mid-word. Under a link that answers
    // a macrotask later, every one of those answers came back to re-render this
    // controlled input, which is what put a scrambled name into the requests
    // the panel below sends. Zero is the only count that removes that
    // possibility rather than narrowing the window it needs.
    recordFetchLatency = "macrotask";
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    // Count from a finished first load, or the initial fetch is scored as if
    // typing had caused it.
    await screen.findByText(/leads the Titan migration/i);
    getAgentMemoryRecords.mockClear();

    await user.type(await screen.findByPlaceholderText(/filter by person/i), "user:ada");

    expect(getAgentMemoryRecords).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^filter$/i }));

    // Re-read the box from the document instead of trusting a handle resolved
    // before all this: the name that leaves has to be the name still on screen.
    await waitFor(() => expect(getAgentMemoryRecords).toHaveBeenCalledTimes(1));
    expect(getAgentMemoryRecords.mock.calls[0]?.[0]).toMatchObject({ ownerSubject: "user:ada" });
    expect((screen.getByPlaceholderText(/filter by person/i) as HTMLInputElement).value).toBe("user:ada");
  });

  it("scopes the destructive controls to the person on screen, not to the half-typed box", async () => {
    // "Forget everything for this person" is irreversible and unconfirmed, and
    // it used to be aimed by whatever was in the box at the instant it was
    // clicked — a value the record list below had not been queried for yet.
    // Now both read the applied filter, so the button cannot name someone whose
    // records are not the ones being shown.
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    await screen.findByText(/leads the Titan migration/i);

    await user.type(await screen.findByPlaceholderText(/filter by person/i), "user:ada");

    expect(screen.queryByRole("button", { name: /forget everything for/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^filter$/i }));

    await waitFor(() => expect(getAgentMemoryRecords).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerSubject: "user:ada" }),
    ));
    expect(screen.getByRole("button", { name: /forget everything for/i })).toBeTruthy();
  });

  it("never purges a person the filter box is no longer showing", async () => {
    // Committing the box fixed the *first* half of this: the purge stopped being
    // aimed by half-typed text. It left the mirror image. Commit Ada, then retype
    // the box to Brix without pressing Filter, and the screen says Brix while the
    // button — labelled "this person", naming nobody — still purges Ada. There is
    // no confirmation dialog and the reason field is already filled, so it is one
    // click, irreversible, on someone the operator is not looking at.
    //
    // Tolerant of the cure, because more than one is defensible: hide the button,
    // disable it, or name the person on it. What is not negotiable is that no
    // purge leaves for an owner the box is not displaying.
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    await screen.findByText(/leads the Titan migration/i);

    const owner = await screen.findByPlaceholderText(/filter by person/i);
    await user.type(owner, "user:ada");
    await user.click(screen.getByRole("button", { name: /^filter$/i }));
    await user.type(screen.getByLabelText(/decision reason/i), " They asked us to.");
    await waitFor(() => expect(getAgentMemoryRecords).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerSubject: "user:ada" }),
    ));

    await user.clear(owner);
    await user.type(owner, "user:brix");

    const purge = screen.queryByRole("button", { name: /forget everything/i });
    if (purge && !(purge as HTMLButtonElement).disabled) await user.click(purge);

    const shown = (screen.getByPlaceholderText(/filter by person/i) as HTMLInputElement).value;
    expect(shown).toBe("user:brix");
    for (const [ownerSubject] of purgeAgentMemory.mock.calls) {
      expect(ownerSubject, "purged an owner the box was not showing").toBe(shown);
    }
  });
});

describe("forget by topic, after the operator changes their mind", () => {
  /**
   * Takes a preview for one person and hands back the filter box, which is the
   * control the operator then edits. The forget panel only exists once a person
   * is named, so every case starts here.
   */
  async function previewFor(user: ReturnType<typeof userEvent.setup>, ownerSubject: string) {
    const owner = await screen.findByPlaceholderText(/filter by person/i);
    await user.type(owner, ownerSubject);
    await user.click(screen.getByRole("button", { name: /^filter$/i }));
    await user.type(screen.getByLabelText(/decision reason/i), " They asked us to.");
    await user.type(await screen.findByPlaceholderText(/project titan/i), "Project Titan");
    await user.click(screen.getByRole("button", { name: /preview what matches/i }));
    await screen.findByRole("button", { name: /forget these 1/i });
    return owner;
  }

  it("withdraws the preview when the person under review changes", async () => {
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    const owner = await previewFor(user, "user:ada");

    await user.clear(owner);
    await user.type(owner, "user:brix");

    // Retyping the box is not yet a change of person: the records below are
    // still Ada's, so the confirmation above them still describes what it sits
    // on. Saying so here is the point — the box is a draft, and treating a
    // draft as the scope is what used to fire a query per character.
    expect(screen.getByRole("button", { name: /forget these 1/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^filter$/i }));

    // Committing it is. A confirmation that outlives the person it was computed
    // for is the defect itself: it sits above another person's records, still
    // offering to forget.
    expect(screen.queryByRole("button", { name: /forget these/i })).toBeNull();
  });

  it("never forgets memory for a person the preview never described", async () => {
    const user = userEvent.setup();
    render(<MemoryView {...props} />);
    const owner = await previewFor(user, "user:ada");

    await user.clear(owner);
    await user.type(owner, "user:brix");
    await user.click(screen.getByRole("button", { name: /^filter$/i }));

    // Deliberately tolerant of the cure — withdraw the stale preview, or commit
    // the owner it was taken for — because the invariant is about the request
    // that leaves, not about which of the two mechanisms stops it.
    const confirm = screen.queryByRole("button", { name: /forget these/i });
    if (confirm) await user.click(confirm);

    const committed = forgetMatchingAgentMemory.mock.calls
      .map(([input]) => input)
      .filter((input) => !input.dryRun);
    expect(committed.map((input) => input.ownerSubject)).not.toContain("user:brix");
  });
});

describe("saving a policy edit", () => {
  it("sends only the settings the update contract accepts", async () => {
    const user = userEvent.setup();
    render(<MemoryView {...props} />);

    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    // Guards the cure: a draft narrowed so hard the form empties would satisfy
    // the contract and quietly blank the operator's policy on save.
    expect(screen.getByLabelText(/^name$/i)).toHaveProperty("value", policy.displayName);

    await user.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() => expect(updateMemoryPolicy).toHaveBeenCalledTimes(1));
    const [id, body] = updateMemoryPolicy.mock.calls[0]!;
    expect(id).toBe(policy.id);
    expect(Object.keys(body).filter((key) => SERVER_OWNED_KEYS.includes(key))).toEqual([]);

    // The load-bearing assertion: the route parses this with the same `.strict()`
    // schema, so whatever it rejects here is a 400 and an error banner in
    // production. Reporting the message means the failure names the stray keys.
    const parsed = updateMemoryPolicySchema.safeParse(body);
    expect(parsed.success ? null : parsed.error.message).toBeNull();

    // ...and it still has to be the edit the operator made.
    expect(body).toMatchObject({
      expectedRevision: policy.revision,
      displayName: policy.displayName,
      description: policy.description,
      maximumCaptureMode: policy.maximumCaptureMode,
      retentionDays: policy.retentionDays,
      maximumItemsPerOwner: policy.maximumItemsPerOwner,
      recallLimit: policy.recallLimit,
      recallMinimumScore: policy.recallMinimumScore,
      knowledgeRecallLimit: policy.knowledgeRecallLimit,
      knowledgeMinimumScore: policy.knowledgeMinimumScore,
      distillCapture: policy.distillCapture,
    });
  });
});
