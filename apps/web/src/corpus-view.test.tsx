// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AdministratorSession, HermesCorpusEntry, HermesCorpusMutation, HermesCorpusStatus,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getHermesCorpusOverview: vi.fn(),
  getHermesCorpusEntries: vi.fn(),
  getHermesCorpusMutations: vi.fn(),
  getHermesCorpusRevisions: vi.fn(),
  createHermesCorpusMutation: vi.fn(),
  decideHermesCorpusMutation: vi.fn(),
  /*
   * The division-memory panel below the Memory tab reads these two. They were
   * absent from this mock, so the panel reached the real module and rendered
   * its error branch -- which draws the same empty panel as a deployment with
   * no notes, so nothing looked wrong and its controls were never covered.
   */
  getScopedMemory: vi.fn(),
  getDivisions: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { CorpusView } = await import("./corpus-view.js");
const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const ENTRY_ID = "af6cfed8-297e-46e2-8bb7-66e45a18ecbb";
const SKILL_ENTRY_ID = "5c1a0f2f-1a4c-4d0a-9a1f-8c4f4a2c0e11";
const NOW = "2026-08-14T00:00:00.000Z";
const HASH = "a".repeat(64);
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "admin", role: "PLATFORM_ADMIN",
  scopes: ["corpus:metadata:read", "corpus:content:read", "corpus:write", "corpus:approve", "corpus:delete"],
  createdAt: NOW, idleExpiresAt: "2026-08-14T00:15:00.000Z", absoluteExpiresAt: "2026-08-14T08:00:00.000Z",
};

const memoryEntry: HermesCorpusEntry = {
  id: ENTRY_ID, nodeId: NODE_ID, path: "memories/MEMORY.md", kind: "MEMORY", mediaType: "text/markdown",
  sizeBytes: 26, sha256: HASH, content: "Keep responses concise.", structuredEntries: ["Keep responses concise."],
  readOnly: false, revision: 2, observedAt: NOW, deletedAt: null,
};

const skillEntry: HermesCorpusEntry = {
  id: SKILL_ENTRY_ID, nodeId: NODE_ID, path: "skills/research/SKILL.md", kind: "SKILL", mediaType: "text/markdown",
  sizeBytes: 44, sha256: "c".repeat(64), content: "# Research\n\nBounded instructions.", structuredEntries: null,
  readOnly: false, revision: 1, observedAt: NOW, deletedAt: null,
};

/** A destructive memory change: two-person approval, on the Memory tab. */
const pending: HermesCorpusMutation = {
  id: "3075b357-97ea-4f36-8cda-7ecf00665291", nodeId: NODE_ID, operation: "MEMORY_REMOVE",
  path: "memories/MEMORY.md", expectedHash: HASH, content: null, oldText: "Keep responses concise.",
  reason: "Retire a stale memory.", status: "PENDING_APPROVAL", requestedBy: "b58588b8-537a-4671-9777-f52e3f2ed16a",
  requestedBySubject: "security-admin", approvedBy: null, approvedBySubject: null,
  beforeHash: HASH, afterHash: null, error: null,
  idempotencyKey: "11a84d43-3b7d-462f-b63d-091425af4cbc", requestedAt: NOW,
  approvedAt: null, dispatchedAt: null, completedAt: null,
};

/** The same thing on the other side of the split. */
const pendingSkill: HermesCorpusMutation = {
  ...pending,
  id: "8d2a8c6c-6a4a-4a9d-9f1e-4e6a0f5b2f31", operation: "SKILL_DELETE",
  path: "skills/research/SKILL.md", oldText: null, reason: "Remove retired skill.",
};

/** Reads fine for every role on this screen: `corpus:content:read` covers it. */
const scopedMemoryEntry = {
  id: "1c9f2a5b-2d3e-4f5a-8b6c-7d8e9f0a1b2c",
  content: "Finance closes the books on the fifth working day.",
  divisionId: "d1", divisionName: "Finance", runId: null, createdAt: NOW,
};

function setupApi(over: { node?: Partial<HermesCorpusStatus> } = {}) {
  api.getScopedMemory.mockResolvedValue({ items: [scopedMemoryEntry], total: 1 });
  api.getDivisions.mockResolvedValue({ items: [] });
  api.getHermesCorpusOverview.mockResolvedValue({ nodes: [{
    nodeId: NODE_ID, nodeSlug: "vm2", nodeDisplayName: "Hermes VM2", available: true, writable: true,
    entryCount: 2, totalBytes: 70, rootHash: HASH, lastSyncedAt: NOW, stale: false,
    ...over.node,
  }] });
  api.getHermesCorpusEntries.mockResolvedValue({ items: [memoryEntry, skillEntry] });
  api.getHermesCorpusMutations.mockResolvedValue({ items: [pending, pendingSkill] });
  api.getHermesCorpusRevisions.mockResolvedValue({ items: [] });
  api.createHermesCorpusMutation.mockResolvedValue({ ...pending, operation: "MEMORY_ADD", path: "memories/MEMORY.md", status: "QUEUED" });
  api.decideHermesCorpusMutation.mockResolvedValue({ ...pending, status: "QUEUED" });
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("CorpusView", () => {
  it("fills the workspace instead of growing the page past the viewport", async () => {
    /*
     * The previous layout stacked a page header, four metric tiles, a filter
     * card, a 590px work grid, and then skill-sets or division-memory under
     * that — so a desktop that already had room for the work still scrolled
     * the document. The workspace is now a column that takes the remaining
     * viewport; change control sits beside the title and search dock; the
     * file list and detail fill what is left. jsdom cannot measure that, so
     * this locks the classes the CSS lock and the flex fill both depend on.
     */
    for (const scope of ["SKILLS", "MEMORY"] as const) {
      setupApi();
      const { container } = render(<CorpusView scope={scope} session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
      await screen.findByRole("heading", { name: scope === "SKILLS" ? "Hermes Skills" : "Hermes Memory" });
      const workspace = container.querySelector(".corpus-workspace");
      expect(workspace?.className).toMatch(/\bflex\b/);
      expect(workspace?.className).toMatch(/\bh-full\b/);
      expect(workspace?.className).toMatch(/\bmin-h-0\b/);
      expect(workspace?.className).not.toMatch(/min-h-\[590px\]/);
      expect(workspace?.querySelector(".corpus-chrome")?.className).toContain("lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]");
      expect(workspace?.querySelector(".corpus-work")?.className).toContain("lg:grid-cols-[260px_minmax(0,1fr)]");
      expect(workspace?.querySelector(".corpus-work")?.className).not.toContain("300px");
      cleanup();
      vi.clearAllMocks();
    }
  });

  it("keeps corpus content behind administrator access on both tabs", () => {
    render(<CorpusView scope="MEMORY" session={null} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Hermes Memory" })).toBeTruthy();
    expect(screen.getByText(/administrator session is required/i)).toBeTruthy();
    cleanup();

    render(<CorpusView scope="SKILLS" session={null} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Hermes Skills" })).toBeTruthy();
  });

  it("presents the signed mirror, native memory entries, revisions, and approvals together", async () => {
    setupApi();
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("Keep responses concise.")).toBeTruthy();
    expect(screen.getByText("Hermes VM2")).toBeTruthy();
    expect(screen.getByText("MEMORY REMOVE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.decideHermesCorpusMutation).toHaveBeenCalledWith(pending.id, expect.objectContaining({ decision: "APPROVE" })));
  });

  it("shows each tab only the files its kind owns", async () => {
    /*
     * The corpus contract already distinguishes these: the VM2 reconciler
     * classifies `memories/MEMORY.md` and `memories/USER.md` as MEMORY and
     * everything else in the mirror as one of the four skill kinds. The split
     * is therefore a real one over real data, not two labels on one list --
     * and this is the assertion that keeps it that way.
     */
    // The path shows up in the row, the detail heading and the change-request
    // card, so presence is `findAllByText`; absence stays an exact zero.
    setupApi();
    render(<CorpusView scope="SKILLS" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect((await screen.findAllByText("skills/research/SKILL.md")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("memories/MEMORY.md")).toHaveLength(0);
    cleanup();
    vi.clearAllMocks();

    setupApi();
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect((await screen.findAllByText("memories/MEMORY.md")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("skills/research/SKILL.md")).toHaveLength(0);
    // Memory is one kind, so the mirror is asked for one kind rather than
    // being asked for everything and filtered on arrival.
    expect(api.getHermesCorpusEntries).toHaveBeenCalledWith(expect.objectContaining({ kind: "MEMORY" }));
  });

  it("shows each tab only the change requests it could have made", async () => {
    setupApi();
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByText("MEMORY REMOVE")).toBeTruthy();
    expect(screen.queryByText("SKILL DELETE")).toBeNull();
    cleanup();
    vi.clearAllMocks();

    setupApi();
    render(<CorpusView scope="SKILLS" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByText("SKILL DELETE")).toBeTruthy();
    expect(screen.queryByText("MEMORY REMOVE")).toBeNull();
  });

  it("offers each tab only the writes its file kind supports", async () => {
    setupApi();
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Add agent memory" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add user profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New skill" })).toBeNull();
    cleanup();
    vi.clearAllMocks();

    setupApi();
    render(<CorpusView scope="SKILLS" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "New skill" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add agent memory" })).toBeNull();
  });

  it("withholds New skill from a node that cannot accept one", async () => {
    /*
     * `writable` is "advertised the corpus capability and is neither REVOKED
     * nor SUSPENDED", and `createMutation` answers those two with a 409. Every
     * other write here already carries the gate; New skill did not, so on a
     * pre-corpus-sync-v1 node the operator got the control, authored a whole
     * SKILL.md, and lost the draft to "This node has not advertised corpus
     * synchronization support" -- on the screen already telling them to run
     * the installer with --repair.
     */
    setupApi({ node: { available: false, writable: false } });
    render(<CorpusView scope="SKILLS" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    // The panel that would carry the control, and the warning that explains
    // its absence, are both on screen -- so the absence below is a judgement
    // about the button rather than about a screen that never rendered.
    expect(await screen.findByText("Skill files")).toBeTruthy();
    expect(screen.getByText(/predates corpus-sync-v1/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New skill" })).toBeNull();
  });

  it("draws a file row at content height rather than inside a single-line control", async () => {
    /*
     * Each row is three stacked lines -- filename, full path, kind and
     * revision -- and `Button` defaults to `h-9 px-4` over a base of
     * `inline-flex items-center justify-center`. That is 36px of height for
     * three lines, laid out side by side rather than stacked. jsdom computes
     * no layout, so this asserts the contract the two sibling components
     * already keep: `agent-run-ledger.tsx` and `agents-view.tsx` both carry
     * `size="auto"` and a single-column grid, and both carry a comment saying
     * why. Asserting the classes is the honest test; asserting a height here
     * would measure nothing.
     */
    for (const scope of ["MEMORY", "SKILLS"] as const) {
      setupApi();
      render(<CorpusView scope={scope} session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
      const path = scope === "MEMORY" ? "memories/MEMORY.md" : "skills/research/SKILL.md";
      const row = await screen.findByRole("button", { name: new RegExp(path.replace(/[/.]/g, "\\$&")) });
      expect(row.className).toContain("h-auto");
      expect(row.className).not.toContain("h-9");
      // The base sets `justify-center`, which centres an implicit track on its
      // own widest line; an explicit single column is what keeps the three
      // lines left-aligned under one another.
      expect(row.className).toContain("grid-cols-1");
      cleanup();
      vi.clearAllMocks();
    }
  });

  it("honors metadata-only corpus access without fetching concealed content or mutations", async () => {
    setupApi();
    const metadataSession: AdministratorSession = {
      ...session,
      role: "OPERATIONS_ADMIN",
      scopes: ["corpus:metadata:read"],
    };
    render(<CorpusView scope="MEMORY" session={metadataSession} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("Metadata-only access")).toBeTruthy();
    expect(api.getHermesCorpusEntries).toHaveBeenCalledWith(expect.objectContaining({ includeContent: false }));
    /*
     * Awaited, not read. The revisions fetch is a second effect rather than
     * part of the render that put "Metadata-only access" on screen: it fires
     * when `selected` first becomes an entry, in the passive effect of that
     * same commit. `findByText` resolves off the DOM mutation and React
     * flushes passive effects after it, so measured at the instant the text
     * appears this mock had been called zero times in 10 of 10 runs. What
     * used to carry the synchronous read was the drain Testing Library runs
     * after `waitFor`: its 0ms timer and the scheduler's `setImmediate` sit
     * in different event-loop phases, so an idle loop reaches the effect
     * first and a loaded one reaches the timer first. That coin landed wrong
     * in 2 of 20 full-suite runs, reporting "Number of calls: 0".
     */
    await waitFor(() => expect(api.getHermesCorpusRevisions).toHaveBeenCalledWith(ENTRY_ID, false));
    expect(api.getHermesCorpusMutations).not.toHaveBeenCalled();
    expect(screen.queryByText("Keep responses concise.")).toBeNull();
  });

  it("lets the requester withdraw a destructive change without self-approving it", async () => {
    setupApi();
    api.getHermesCorpusMutations.mockResolvedValue({ items: [{ ...pending, requestedBySubject: session.subject }] });
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText(/different administrator must approve/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(api.decideHermesCorpusMutation).toHaveBeenCalledWith(
      pending.id,
      expect.objectContaining({ decision: "REJECT" }),
    ));
  });

  it("queues an append through the conflict-safe mutation API", async () => {
    setupApi();
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByText("Keep responses concise.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "Prefer cited operational evidence." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit change" }));
    await waitFor(() => expect(api.createHermesCorpusMutation).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: NODE_ID, operation: "MEMORY_ADD", path: "memories/MEMORY.md",
      expectedHash: null, content: "Prefer cited operational evidence.",
    })));
  });

  it("keeps the dialog's observed hash stable across background refreshes", async () => {
    setupApi();
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByText("Keep responses concise.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const callsBeforeRefresh = api.getHermesCorpusEntries.mock.calls.length;
    api.getHermesCorpusEntries.mockResolvedValue({ items: [{
      ...memoryEntry, sizeBytes: 31, sha256: "b".repeat(64),
      content: "A newer memory appeared.", structuredEntries: ["A newer memory appeared."], revision: 3,
    }] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.getHermesCorpusEntries.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));

    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "Updated from the reviewed draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit change" }));
    await waitFor(() => expect(api.createHermesCorpusMutation).toHaveBeenCalledWith(expect.objectContaining({
      operation: "MEMORY_REPLACE",
      expectedHash: HASH,
      oldText: "Keep responses concise.",
    })));
  });

  /*
   * The division-memory panel beside the title, which is the same store the
   * `recall` tool reads. Its two controls answer to `corpus:write` and
   * `corpus:delete`; the panel took neither scope and drew both unconditionally
   * while the sibling panel eight lines above it in `corpus-view.tsx` is gated
   * on `canWrite`. An AUDITOR holds `corpus:content:read` and neither of the
   * other two, so every note read fine and every button 403'd.
   */
  describe("division memory", () => {
    /** The real AUDITOR slice of `ROLE_SCOPES`, copied rather than derived. */
    const auditor: AdministratorSession = {
      ...session, role: "AUDITOR", scopes: ["corpus:metadata:read", "corpus:content:read"],
    };

    it("withholds the controls a reading role cannot use", async () => {
      setupApi();
      render(<CorpusView scope="MEMORY" session={auditor} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

      // The panel is populated, so the absences below are judgements about the
      // controls rather than about an unrendered panel.
      expect(await screen.findByText("Finance closes the books on the fifth working day.")).toBeTruthy();
      expect(screen.getByText("Division memory")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    });

    it("offers both to a role that holds the scopes behind them", async () => {
      setupApi();
      render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

      expect(await screen.findByText("Finance closes the books on the fifth working day.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add note" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    });

    it("does not claim nothing is remembered when the read failed", async () => {
      // "Nothing remembered yet" is a claim about the division's knowledge. A
      // refused or failed read supports no such claim, and on this screen of
      // all screens -- the one an operator opens to find out what an agent
      // knows -- an unearned empty state is the worst possible answer.
      setupApi();
      api.getScopedMemory.mockRejectedValue(new Error("Division memory is unavailable."));
      render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

      expect(await screen.findByText("Division memory is unavailable.")).toBeTruthy();
      expect(screen.queryByText("Nothing remembered yet")).toBeNull();
    });
  });

  it("says the change-request panel is a slice rather than the history", async () => {
    /*
     * Twenty rows under a heading that says only "Recent requests" reads as
     * everything that has been asked of this node. The twenty-first row is a
     * pending approval that no longer exists as far as this screen is
     * concerned, on a panel whose whole job is two-person review.
     */
    setupApi();
    api.getHermesCorpusMutations.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, index) => ({ ...pending, id: `m${index}` })),
    });
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("Showing the 20 most recent of 25 loaded.")).toBeTruthy();
    expect(screen.getAllByText("MEMORY REMOVE")).toHaveLength(20);
  });

  it("can initialize native memory files before the first snapshot contains them", async () => {
    setupApi();
    api.getHermesCorpusEntries.mockResolvedValue({ items: [] });
    render(<CorpusView scope="MEMORY" session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("No memory files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add user profile" }));
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "The operator prefers concise answers." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit change" }));

    await waitFor(() => expect(api.createHermesCorpusMutation).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: NODE_ID,
      operation: "MEMORY_ADD",
      path: "memories/USER.md",
      expectedHash: null,
      content: "The operator prefers concise answers.",
    })));
  });
});
