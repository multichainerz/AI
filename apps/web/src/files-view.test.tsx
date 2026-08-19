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
  ],
} as ChatArtifactList;

const getChatArtifacts = vi.fn(async () => list);

vi.mock("./api.js", async (load) => ({
  ...(await load<typeof import("./api.js")>()),
  getChatArtifacts,
}));

const { FilesView } = await import("./files-view.js");

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
    const rows = within(screen.getByLabelText("Agent-produced files"));

    expect(rows.getByText("findings.md")).toBeTruthy();
    expect(rows.getByText("Release review")).toBeTruthy();
    expect(rows.getByText("2.0 KB")).toBeTruthy();

    const download = rows.getByRole("link", { name: "Download" }) as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/v1/chat/artifacts/0b54a1de-6f0f-4b7e-9a94-1c2d3e4f5a6b/content");
    expect(download.getAttribute("download")).toBe("findings.md");
  });

  it("says a node-resident file is on its node instead of offering a dead download", async () => {
    await view();
    const rows = within(screen.getByLabelText("Agent-produced files"));

    expect(rows.getByText("On node")).toBeTruthy();
    expect(rows.getAllByRole("link", { name: "Download" })).toHaveLength(1);
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

  it("renders a failed load as a failure, never as an empty library", async () => {
    getChatArtifacts.mockRejectedValueOnce(new Error("the artifact service is unreachable"));
    render(<FilesView onSessionExpired={vi.fn()} />);

    await waitFor(() => screen.getByText(/artifact service is unreachable/));
    expect(screen.queryByText("No files yet")).toBeNull();
  });
});
