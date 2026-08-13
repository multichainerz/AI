// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdministratorSession, HermesCorpusMutation } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getHermesCorpusOverview: vi.fn(),
  getHermesCorpusEntries: vi.fn(),
  getHermesCorpusMutations: vi.fn(),
  getHermesCorpusRevisions: vi.fn(),
  createHermesCorpusMutation: vi.fn(),
  decideHermesCorpusMutation: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { CorpusView } = await import("./corpus-view.js");
const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const ENTRY_ID = "af6cfed8-297e-46e2-8bb7-66e45a18ecbb";
const NOW = "2026-08-14T00:00:00.000Z";
const HASH = "a".repeat(64);
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "admin", role: "PLATFORM_ADMIN",
  scopes: ["corpus:metadata:read", "corpus:content:read", "corpus:write", "corpus:approve", "corpus:delete"],
  createdAt: NOW, idleExpiresAt: "2026-08-14T00:15:00.000Z", absoluteExpiresAt: "2026-08-14T08:00:00.000Z",
};

const pending: HermesCorpusMutation = {
  id: "3075b357-97ea-4f36-8cda-7ecf00665291", nodeId: NODE_ID, operation: "SKILL_DELETE",
  path: "skills/research/SKILL.md", expectedHash: HASH, content: null, oldText: null,
  reason: "Remove retired skill.", status: "PENDING_APPROVAL", requestedBy: "b58588b8-537a-4671-9777-f52e3f2ed16a",
  requestedBySubject: "security-admin", approvedBy: null, approvedBySubject: null,
  beforeHash: HASH, afterHash: null, error: null,
  idempotencyKey: "11a84d43-3b7d-462f-b63d-091425af4cbc", requestedAt: NOW,
  approvedAt: null, dispatchedAt: null, completedAt: null,
};

function setupApi() {
  api.getHermesCorpusOverview.mockResolvedValue({ nodes: [{
    nodeId: NODE_ID, nodeSlug: "vm2", nodeDisplayName: "Hermes VM2", available: true, writable: true,
    entryCount: 1, totalBytes: 26, rootHash: HASH, lastSyncedAt: NOW, stale: false,
  }] });
  api.getHermesCorpusEntries.mockResolvedValue({ items: [{
    id: ENTRY_ID, nodeId: NODE_ID, path: "memories/MEMORY.md", kind: "MEMORY", mediaType: "text/markdown",
    sizeBytes: 26, sha256: HASH, content: "Keep responses concise.", structuredEntries: ["Keep responses concise."],
    readOnly: false, revision: 2, observedAt: NOW, deletedAt: null,
  }] });
  api.getHermesCorpusMutations.mockResolvedValue({ items: [pending] });
  api.getHermesCorpusRevisions.mockResolvedValue({ items: [] });
  api.createHermesCorpusMutation.mockResolvedValue({ ...pending, operation: "MEMORY_ADD", path: "memories/MEMORY.md", status: "QUEUED" });
  api.decideHermesCorpusMutation.mockResolvedValue({ ...pending, status: "QUEUED" });
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("CorpusView", () => {
  it("keeps corpus content behind administrator access", () => {
    render(<CorpusView session={null} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Hermes corpus" })).toBeTruthy();
    expect(screen.getByText(/administrator session is required/i)).toBeTruthy();
  });

  it("presents the signed mirror, native memory entries, revisions, and approvals together", async () => {
    setupApi();
    render(<CorpusView session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("Keep responses concise.")).toBeTruthy();
    expect(screen.getByText("Hermes VM2")).toBeTruthy();
    expect(screen.getByText("SKILL DELETE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.decideHermesCorpusMutation).toHaveBeenCalledWith(pending.id, expect.objectContaining({ decision: "APPROVE" })));
  });

  it("honors metadata-only corpus access without fetching concealed content or mutations", async () => {
    setupApi();
    const metadataSession: AdministratorSession = {
      ...session,
      role: "OPERATIONS_ADMIN",
      scopes: ["corpus:metadata:read"],
    };
    render(<CorpusView session={metadataSession} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("Metadata-only access")).toBeTruthy();
    expect(api.getHermesCorpusEntries).toHaveBeenCalledWith(expect.objectContaining({ includeContent: false }));
    expect(api.getHermesCorpusRevisions).toHaveBeenCalledWith(ENTRY_ID, false);
    expect(api.getHermesCorpusMutations).not.toHaveBeenCalled();
    expect(screen.queryByText("Keep responses concise.")).toBeNull();
  });

  it("lets the requester withdraw a destructive change without self-approving it", async () => {
    setupApi();
    api.getHermesCorpusMutations.mockResolvedValue({ items: [{ ...pending, requestedBySubject: session.subject }] });
    render(<CorpusView session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

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
    render(<CorpusView session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
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
    render(<CorpusView session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByText("Keep responses concise.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const callsBeforeRefresh = api.getHermesCorpusEntries.mock.calls.length;
    api.getHermesCorpusEntries.mockResolvedValue({ items: [{
      id: ENTRY_ID, nodeId: NODE_ID, path: "memories/MEMORY.md", kind: "MEMORY", mediaType: "text/markdown",
      sizeBytes: 31, sha256: "b".repeat(64), content: "A newer memory appeared.", structuredEntries: ["A newer memory appeared."],
      readOnly: false, revision: 3, observedAt: NOW, deletedAt: null,
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

  it("can initialize native memory files before the first snapshot contains them", async () => {
    setupApi();
    api.getHermesCorpusEntries.mockResolvedValue({ items: [] });
    render(<CorpusView session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("No corpus files")).toBeTruthy();
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
