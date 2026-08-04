/**
 * @vitest-environment jsdom
 *
 * The first interaction test in the dashboard. Every other view test renders to
 * static markup, which cannot reach a control that only appears after an async
 * load - which is exactly how the chat knowledge control went unverified.
 */
import type { ChatConversation, DocumentList } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conversation = (knowledgeDocuments: ChatConversation["knowledgeDocuments"] = []): ChatConversation => ({
  id: "8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  title: "Runbook questions",
  modelAlias: "hermes-agent",
  profileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  profileName: "Support agent",
  status: "ACTIVE",
  messageCount: 0,
  lastMessagePreview: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastMessageAt: null,
  messages: [],
  knowledgeDocuments,
} as ChatConversation);

const documents = {
  items: [
    { id: "doc-ready", fileName: "runbook.pdf", classification: "INTERNAL", status: "READY" },
    { id: "doc-queued", fileName: "draft.docx", classification: "INTERNAL", status: "QUEUED" },
  ],
} as unknown as DocumentList;

const attachChatDocument = vi.fn(async () =>
  conversation([{ id: "doc-ready", fileName: "runbook.pdf", classification: "INTERNAL", status: "READY" }] as never));
const detachChatDocument = vi.fn(async () => conversation());

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation(), messages: undefined }] })),
    getChatConversation: vi.fn(async () => conversation()),
    getAgentProfiles: vi.fn(async () => ({ items: [] })),
    getDocuments: vi.fn(async () => documents),
    attachChatDocument,
    detachChatDocument,
  };
});

// jsdom implements no layout, so the transcript's scroll-into-view is a no-op here.
Element.prototype.scrollIntoView = () => undefined;

const { ChatView } = await import("./chat-view.js");

const props = {
  unlocked: true,
  identityMode: "ADMINISTRATOR_PREVIEW" as const,
  displayName: "Operator",
  administratorReadiness: null,
  oidcConfigured: false,
  onSignIn: vi.fn(),
  onConfigure: vi.fn(),
  onOpenAgents: vi.fn(),
  onOpenPlatform: vi.fn(),
  onUnauthorized: vi.fn(),
};

beforeEach(() => { attachChatDocument.mockClear(); detachChatDocument.mockClear(); });
afterEach(cleanup);

describe("chat knowledge control", () => {
  it("opens the picker and offers only indexed documents", async () => {
    const user = userEvent.setup();
    render(<ChatView {...props} />);

    await user.click(await screen.findByRole("button", { name: /knowledge/i }));

    expect(await screen.findByText("runbook.pdf")).toBeDefined();
    // A queued document has no embedded chunks; pinning it would retrieve nothing.
    expect(screen.queryByText("draft.docx")).toBeNull();
  });

  it("pins a document through the attach endpoint", async () => {
    const user = userEvent.setup();
    render(<ChatView {...props} />);
    await user.click(await screen.findByRole("button", { name: /knowledge/i }));

    await user.click(await screen.findByRole("checkbox"));

    await waitFor(() => expect(attachChatDocument).toHaveBeenCalledWith(
      "8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "doc-ready",
    ));
    expect(detachChatDocument).not.toHaveBeenCalled();
  });

  it("states that an unpinned conversation may draw on everything", async () => {
    const user = userEvent.setup();
    render(<ChatView {...props} />);

    await user.click(await screen.findByRole("button", { name: /knowledge/i }));

    expect(await screen.findByText(/every document you own/i)).toBeDefined();
  });
});
