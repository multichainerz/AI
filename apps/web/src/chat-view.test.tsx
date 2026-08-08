/**
 * @vitest-environment jsdom
 *
 * The pure helpers below need no DOM, but the two failure paths at the bottom
 * do: both are about what Chat shows an operator after a request fails, which
 * only a rendered view can answer.
 */
import type { AgentProfile, ChatConversation, DocumentList, DocumentSummary } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conversation = {
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
  knowledgeDocuments: [],
} as unknown as ChatConversation;

const profile = {
  id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  name: "Support agent",
  status: "ACTIVE",
  version: { displayName: "Support agent v1" },
  activeVersionConfiguration: { displayName: "Support agent v1" },
} as unknown as AgentProfile;

const mocks = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  submitChatMessage: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    getChatConversation: vi.fn(async () => conversation),
    getAgentProfiles: vi.fn(async () => ({ items: [profile] })),
    getDocuments: mocks.getDocuments,
    submitChatMessage: mocks.submitChatMessage,
  };
});

// jsdom implements no layout, so the transcript's scroll-into-view is a no-op.
Element.prototype.scrollIntoView = () => undefined;

const { OrcaSynapseApiError } = await import("./api.js");
const { ChatView, createClientMessageId, knowledgeScopeSummary, pinnableDocuments } = await import("./chat-view.js");

function summary(fileName: string, status: DocumentSummary["status"]): DocumentSummary {
  return { id: `${fileName}-id`, fileName, status, classification: "INTERNAL" } as DocumentSummary;
}

describe("pinnableDocuments", () => {
  it("offers only documents that are actually indexed", () => {
    const offered = pinnableDocuments([
      summary("ready.pdf", "READY"),
      summary("queued.pdf", "QUEUED"),
      summary("failed.pdf", "FAILED"),
    ]);

    expect(offered.map(({ fileName }) => fileName)).toEqual(["ready.pdf"]);
  });

  it("offers nothing when the library is empty or entirely unindexed", () => {
    expect(pinnableDocuments([])).toEqual([]);
    expect(pinnableDocuments([summary("queued.pdf", "QUEUED")])).toEqual([]);
  });
});

describe("knowledgeScopeSummary", () => {
  it("says retrieval is unrestricted when nothing is pinned", () => {
    // An unpinned conversation retrieves across everything the owner holds,
    // which is a materially different answer than a pinned one.
    expect(knowledgeScopeSummary(0)).toContain("every document you own");
  });

  it("names the restriction and agrees with itself on plurals", () => {
    expect(knowledgeScopeSummary(1)).toBe("Answers are restricted to 1 pinned document.");
    expect(knowledgeScopeSummary(3)).toBe("Answers are restricted to 3 pinned documents.");
  });
});

describe("createClientMessageId", () => {
  it("prefers the platform UUID when one is available", () => {
    expect(createClientMessageId({ randomUUID: () => "3f1d0f0c-0f6a-4a1f-9a0e-6f3f4d2c1b0a" }))
      .toBe("3f1d0f0c-0f6a-4a1f-9a0e-6f3f4d2c1b0a");
  });

  it("still produces a distinct id when no platform crypto exists", () => {
    const first = createClientMessageId(null);
    const second = createClientMessageId(null);

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });
});

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
  onSessionExpired: vi.fn(),
};

beforeEach(() => {
  mocks.getDocuments.mockReset();
  mocks.getDocuments.mockResolvedValue({ items: [] } as unknown as DocumentList);
  mocks.submitChatMessage.mockReset();
  props.onSessionExpired.mockReset();
});
afterEach(cleanup);

describe("chat knowledge picker failure", () => {
  it("does not present a failed load as an empty library", async () => {
    // "No indexed documents yet" over a load that never returned tells the
    // operator they have nothing indexed, and hides the real cause behind the
    // modal backdrop.
    mocks.getDocuments.mockRejectedValueOnce(new Error("The knowledge index is unreachable."));
    const user = userEvent.setup();
    render(<ChatView {...props} />);

    await user.click(await screen.findByRole("button", { name: /knowledge/i }));

    expect(await screen.findByText("The knowledge index is unreachable.")).toBeTruthy();
    expect(screen.queryByText("No indexed documents yet")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("treats a 401 on the document load as the expired session it is", async () => {
    // Every other failure path in Chat hands a 401 to the session handler; this
    // one printed it as an error message under a signed-out session.
    mocks.getDocuments.mockRejectedValueOnce(new OrcaSynapseApiError(401, "Session expired."));
    const user = userEvent.setup();
    render(<ChatView {...props} />);

    await user.click(await screen.findByRole("button", { name: /knowledge/i }));

    await waitFor(() => expect(props.onSessionExpired).toHaveBeenCalled());
  });
});

describe("chat composer", () => {
  it("keeps the message when the send fails, since nothing else can recover it", async () => {
    // The draft was cleared before the request. A failed submit creates no
    // assistant row, so Retry prompt has nothing to read back from - a long
    // message was simply gone.
    mocks.submitChatMessage.mockRejectedValueOnce(new Error("The Hermes route is unavailable."));
    const user = userEvent.setup();
    render(<ChatView {...props} />);

    const composer = await screen.findByLabelText("Chat message");
    // Pasted rather than typed. The claim is about what survives a failed send,
    // not about keystroke handling, and typing it drove fifty-four renders of
    // the largest component in the app — enough to blow the 5000 ms budget on a
    // loaded machine, for reasons that had nothing to do with what is asserted.
    await user.click(composer);
    await user.paste("Summarise the incident runbook for the on-call engineer");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("The Hermes route is unavailable.")).toBeTruthy();
    expect((screen.getByLabelText("Chat message") as HTMLTextAreaElement).value)
      .toBe("Summarise the incident runbook for the on-call engineer");
  });
});
