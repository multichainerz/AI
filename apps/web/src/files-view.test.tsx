/**
 * @vitest-environment jsdom
 *
 * The Files view renders exactly what the division-scoped list route returns
 * -- tenancy is enforced on the server and asserted in the API suite -- so
 * what this covers is the honesty of the rendering: a NODE-storage file must
 * not offer a download it cannot serve, a failed load must not read as an
 * empty library, and the download link must be a plain navigation to the
 * content route rather than anything scripted.
 */
import type { ChatArtifactList } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const artifact = (over: Record<string, unknown>) => ({
  id: "0b54a1de-6f0f-4b7e-9a94-1c2d3e4f5a6b",
  runId: "c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f",
  conversationId: "8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  messageId: null,
  nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
  origin: "AGENT",
  divisionId: null,
  name: "findings.md",
  path: "out/findings.md",
  mediaType: "text/markdown",
  sizeBytes: 2_048,
  sha256: "a".repeat(64),
  storage: "INLINE",
  conversationTitle: "Release review",
  profileName: "Support analyst",
  observedAt: "2026-08-19T09:00:00.000Z",
  createdAt: "2026-08-19T09:00:01.000Z",
  ...over,
});

const list: ChatArtifactList = {
  items: [
    artifact({}),
    artifact({
      id: "1c65b2ef-7a1a-4c8f-8ba5-2d3e4f5a6b7c",
      name: "export.zip", path: "export.zip", mediaType: "application/zip",
      sizeBytes: 48 * 1024 * 1024, storage: "NODE", conversationTitle: "Data pull",
    }),
    artifact({
      id: "2d76c3fa-8b2b-4d9a-9cb6-3e4f5a6b7c8d",
      runId: null, nodeId: null, origin: "UPLOADED",
      name: "notes.txt", path: "notes.txt", mediaType: "text/plain",
      sizeBytes: 512, conversationTitle: "Release review", profileName: null,
    }),
  ],
} as ChatArtifactList;

const getChatArtifacts = vi.fn(async () => list);

vi.mock("./api.js", async (load) => ({
  ...(await load<typeof import("./api.js")>()),
  getChatArtifacts,
}));

const { FilesView } = await import("./files-view.js");
const { OrcaSynapseApiError } = await import("./api.js");

afterEach(() => {
  cleanup();
  getChatArtifacts.mockClear();
});

async function view() {
  const onSessionExpired = vi.fn();
  render(<FilesView onSessionExpired={onSessionExpired} />);
  await waitFor(() => screen.getByText("findings.md"));
  return onSessionExpired;
}

describe("files view", () => {
  it("renders each file with its origin, and downloads via a plain navigation", async () => {
    await view();
    const rows = within(screen.getByLabelText("Files"));

    expect(rows.getByText("findings.md")).toBeTruthy();
    // Twice: the agent file and the upload both belong to this conversation.
    expect(rows.getAllByText("Release review")).toHaveLength(2);
    expect(rows.getByText("2.0 KB")).toBeTruthy();

    const download = rows.getAllByRole("link", { name: "Download" })
      .find((link) => link.getAttribute("download") === "findings.md") as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/v1/chat/artifacts/0b54a1de-6f0f-4b7e-9a94-1c2d3e4f5a6b/content");
  });

  it("says a node-resident file is on its node instead of offering a dead download", async () => {
    await view();
    const rows = within(screen.getByLabelText("Files"));

    expect(rows.getByText("On node")).toBeTruthy();
    // Two inline files download; the node-resident one is the row that must not.
    expect(rows.getAllByRole("link", { name: "Download" })).toHaveLength(2);
    expect(rows.getByText("48.0 MB")).toBeTruthy();
  });

  it("filters by name or conversation without asking the server again", async () => {
    await view();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Search files"), "release");
    expect(screen.getByText("findings.md")).toBeTruthy();
    expect(screen.queryByText("export.zip")).toBeNull();
    expect(getChatArtifacts).toHaveBeenCalledTimes(1);

    await user.clear(screen.getByLabelText("Search files"));
    await user.type(screen.getByLabelText("Search files"), "no such file");
    expect(screen.getByText("Nothing matches")).toBeTruthy();
  });

  it("labels provenance on every row and narrows by it without a server round trip", async () => {
    await view();
    const user = userEvent.setup();
    const rows = () => within(screen.getByLabelText("Files"));

    // Words, not colour: Uploaded and Agent are stated on the row.
    expect(rows().getByText("Uploaded")).toBeTruthy();
    expect(rows().getAllByText("Agent")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Uploaded" }));
    expect(rows().getByText("notes.txt")).toBeTruthy();
    expect(screen.queryByText("findings.md")).toBeNull();
    expect(getChatArtifacts).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(rows().getByText("findings.md")).toBeTruthy();
  });

  it("treats 401 as expiry and 403 as a refusal that leaves the session", async () => {
    getChatArtifacts.mockRejectedValueOnce(new OrcaSynapseApiError(401, "unsigned"));
    const expiredOn401 = vi.fn();
    render(<FilesView onSessionExpired={expiredOn401} />);
    await waitFor(() => expect(expiredOn401).toHaveBeenCalled());

    cleanup();
    getChatArtifacts.mockRejectedValueOnce(new OrcaSynapseApiError(403, "The administrator session does not grant 'chat:use'."));
    const expiredOn403 = vi.fn();
    render(<FilesView onSessionExpired={expiredOn403} />);
    await waitFor(() => screen.getByText(/does not grant/));
    expect(expiredOn403).not.toHaveBeenCalled();
    expect(screen.queryByText("No files yet")).toBeNull();
  });

  it("renders a failed load as a failure, never as an empty library", async () => {
    getChatArtifacts.mockRejectedValueOnce(new Error("the artifact service is unreachable"));
    render(<FilesView onSessionExpired={vi.fn()} />);

    await waitFor(() => screen.getByText(/artifact service is unreachable/));
    expect(screen.queryByText("No files yet")).toBeNull();
  });
});
