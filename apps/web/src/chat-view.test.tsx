/**
 * @vitest-environment jsdom
 *
 * The pure helpers below need no DOM, but the two failure paths at the bottom
 * do: both are about what Chat shows an operator after a request fails, which
 * only a rendered view can answer.
 */
import type { AgentProfile, ChatConversation } from "@orcasynapse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
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
} as unknown as ChatConversation;

const profile = {
  id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  name: "Support agent",
  status: "ACTIVE",
  version: { displayName: "Support agent v1" },
  activeVersionConfiguration: { displayName: "Support agent v1" },
} as unknown as AgentProfile;

const mocks = vi.hoisted(() => ({
  getChatConversations: vi.fn(),
  submitChatMessage: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: mocks.getChatConversations,
    getChatConversation: vi.fn(async () => conversation),
    getAgentProfiles: vi.fn(async () => ({ items: [profile] })),
    submitChatMessage: mocks.submitChatMessage,
  };
});

// jsdom implements no layout, so the transcript's scroll-into-view is a no-op.
Element.prototype.scrollIntoView = () => undefined;

const { ChatView, createClientMessageId } = await import("./chat-view.js");

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
  mocks.getChatConversations.mockReset();
  mocks.getChatConversations.mockResolvedValue({ items: [{ ...conversation, messages: undefined }] });
  mocks.submitChatMessage.mockReset();
  props.onOpenAgents.mockReset();
  props.onOpenPlatform.mockReset();
  props.onSessionExpired.mockReset();
});
afterEach(cleanup);


describe("chat composer", () => {
  it("keeps the conversation header on the chat canvas", async () => {
    render(<ChatView {...props} />);

    const header = (await screen.findByLabelText("Conversation runtime")).closest("header");
    expect(header?.classList.contains("bg-bg")).toBe(true);
    expect(header?.classList.contains("bg-surface")).toBe(false);
    expect(header?.classList.contains("border-b")).toBe(false);
  });

  it("identifies the agent picker and turns missing setup into an action", async () => {
    mocks.getChatConversations.mockResolvedValueOnce({ items: [] });
    const user = userEvent.setup();
    const { container } = render(
      <ChatView
        {...props}
        administratorReadiness={{
          ready: false,
          title: "Connect an agent runtime",
          detail: "Choose and validate the agent execution route.",
          target: "Agents",
        }}
      />,
    );

    await screen.findByLabelText("Agent Profile");
    expect(container.querySelector("[data-agent-selector-icon]")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open agent setup: setup required" }));
    expect(props.onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it("presents the administrator identity as a compact session summary", async () => {
    render(<ChatView {...props} />);

    const summary = await screen.findByLabelText("Current session identity");
    expect(summary.textContent).toContain("Operator");
    expect(summary.textContent).toContain("Administrator preview");
    expect(summary.textContent).toContain("Support agent");
  });

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
