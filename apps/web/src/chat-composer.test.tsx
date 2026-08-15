/**
 * @vitest-environment jsdom
 *
 * The composer treated as a control in its own right.
 *
 * `chat-view.test.tsx` covers what the view does with a message once it has
 * one. This file covers the box the message is typed into: that it sizes itself
 * to the draft, that focus is a property of the whole surface rather than a
 * ring drawn around the textarea inside it, that it stays quiet about length
 * until length matters, and that the two keystrokes everyone has in muscle
 * memory still mean what they meant.
 *
 * Several claims below are half in the stylesheet: an attribute the CSS reads,
 * a class a rule is keyed on. Asserting only the markup would leave a test that
 * passes with the rule deleted and the composer visibly broken, so each of
 * those reads `styles.css` for the other half — the same split `ui/tokens.test.ts`
 * covers for colour.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentProfile, ChatConversation, ModelDeployment } from "@orcasynapse/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/**
 * A conversation whose last answer measured a prompt.
 *
 * That measurement is the readout's only number, and it belongs to the turn
 * that already finished — which is the whole reason the label has to say so.
 */
const measured = (inputTokens: number) => ({
  ...conversation,
  messages: [{
    id: "3d4e5f60-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    role: "ASSISTANT",
    content: "Done.",
    status: "COMPLETED",
    createdAt: "2026-08-01T00:00:00.000Z",
    modelAlias: "hermes-agent",
    totalTokens: inputTokens + 12,
    inputTokens,
    outputTokens: 12,
    reasoningTokens: null,
    latencyMs: 1_000,
    firstTokenLatencyMs: 200,
    finishReason: "STOP",
    errorCode: null,
    agentRunId: null,
    runStatus: null,
    lastEventCursor: null,
    approvals: [],
    runtimeEvents: [],
    feedback: null,
  }],
} as unknown as ChatConversation);

const deployment = (contextWindowTokens: number) => ({
  id: "0f6a3b1c-4d5e-4f60-9a1b-2c3d4e5f6071",
  modelAlias: "hermes-agent",
  status: "ACTIVE",
  contextWindowTokens,
} as unknown as ModelDeployment);

const mocks = vi.hoisted(() => ({
  submitChatMessage: vi.fn(),
  cancelChatRun: vi.fn(),
  getChatConversation: vi.fn(),
  getModelDeployments: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    getChatConversation: mocks.getChatConversation,
    getAgentProfiles: vi.fn(async () => ({ items: [profile] })),
    getModelDeployments: mocks.getModelDeployments,
    submitChatMessage: mocks.submitChatMessage,
    cancelChatRun: mocks.cancelChatRun,
  };
});

// jsdom implements no layout, so the transcript's scroll-into-view is a no-op.
Element.prototype.scrollIntoView = () => undefined;

const { OrcaSynapseApiError } = await import("./api.js");
const { ChatView } = await import("./chat-view.js");

// `import.meta.url` is not a file URL under the jsdom environment, so the
// stylesheet is read from the package root Vitest already runs in.
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

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

async function composer(): Promise<HTMLTextAreaElement> {
  render(<ChatView {...props} />);
  return await screen.findByLabelText("Chat message") as HTMLTextAreaElement;
}

/** A submit that never settles, which is the whole of the `submitting` window. */
const neverSettles = () => new Promise<never>(() => undefined);

beforeEach(() => {
  mocks.submitChatMessage.mockReset();
  mocks.submitChatMessage.mockRejectedValue(new Error("The Hermes route is unavailable."));
  mocks.cancelChatRun.mockReset();
  mocks.cancelChatRun.mockResolvedValue(conversation);
  mocks.getChatConversation.mockReset();
  mocks.getChatConversation.mockResolvedValue(conversation);
  // `models:read` is an administrator scope. The empty catalogue is what an
  // employee identity actually gets, and it is the default here so the cases
  // that care about the context readout can say which of the two they mean.
  mocks.getModelDeployments.mockReset();
  mocks.getModelDeployments.mockResolvedValue({ items: [] });
});
afterEach(cleanup);

describe("the chat composer", () => {
  it("sizes itself to the draft rather than handing back a scrollbar", async () => {
    const field = await composer();
    const user = userEvent.setup();
    await user.click(field);
    await user.paste("First line\nSecond line");

    /*
     * A textarea cannot size itself, and the usual fix writes a measured pixel
     * height into `element.style` — which is precisely the inline style the
     * production CSP refuses. The box is instead a grid holding the textarea and
     * a hidden copy of the same text; the copy is what has a natural height, and
     * it reads the draft out of this attribute.
     */
    const box = field.closest("[data-composer-value]");
    expect(box?.getAttribute("data-composer-value")).toBe("First line\nSecond line");
    // The attribute measures nothing on its own.
    expect(styles).toContain("content: attr(data-composer-value)");
    // The drag handle is what the old box offered instead, and it is the tell
    // that nothing is sizing this automatically.
    expect(field.className).toContain("resize-none");
    expect(field.className).not.toContain("resize-y");
  });

  it("treats focus as a property of the whole surface", async () => {
    const field = await composer();
    const form = field.closest("form");

    expect(form?.classList.contains("chat-composer")).toBe(true);
    // The global `textarea:focus-visible` outline would otherwise draw a second,
    // harder ring inside the one the container already shows.
    expect(field.className).toContain("focus-visible:outline-none");

    // Anchored to the start of a line, so the theme-scoped
    // `[data-theme="light"] .chat-composer:focus-within` further down cannot
    // stand in for the rule both themes rely on.
    const focused = /(?:^|\n)\.chat-composer:focus-within\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(focused, "the composer states no focused appearance").not.toBe("");
    expect(focused).toContain("box-shadow");
    expect(focused).toContain("--accent-rgb");
  });

  it("says nothing about length until the draft is near the cap", async () => {
    const field = await composer();

    fireEvent.change(field, { target: { value: "Short enough that a counter is only noise" } });
    expect(screen.queryByText(/32,000/)).toBeNull();
    expect(screen.queryByText(/left$/)).toBeNull();

    // The last thousand characters of a 32,000-character cap.
    fireEvent.change(field, { target: { value: "x".repeat(31_000) } });
    const remaining = screen.getByLabelText("1,000 characters left before the message limit");
    expect(remaining.textContent).toContain("1,000 left");
    expect(remaining.className).toContain("text-warn");
  });

  it("keeps Enter as send and Shift + Enter as a new line", async () => {
    const field = await composer();
    const user = userEvent.setup();
    await user.click(field);
    await user.paste("Line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(mocks.submitChatMessage).not.toHaveBeenCalled();
    expect(field.value).toBe("Line one\n");

    await user.paste("Line two");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(mocks.submitChatMessage).toHaveBeenCalledTimes(1));
    expect(mocks.submitChatMessage.mock.calls[0]?.[1]).toBe("Line one\nLine two");
  });

  it("lets an IME candidate be confirmed without sending the half-converted draft", async () => {
    /*
     * Enter is how a Japanese, Chinese or Korean reader accepts the candidate
     * the IME is offering, and it arrives as a keydown like any other. With no
     * composition guard every candidate confirmation sent the message — the
     * draft leaving mid-conversion, several times per sentence.
     *
     * jsdom runs no IME, so the two readings a browser gives are dispatched
     * directly: `isComposing` on the native event, which is what Chromium and
     * Firefox set, and the legacy `keyCode === 229`, which is what Safari and
     * older Chromium report while a composition is open.
     */
    const field = await composer();
    const user = userEvent.setup();
    await user.click(field);
    await user.paste("にほんご");

    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });

    expect(mocks.submitChatMessage).not.toHaveBeenCalled();
    expect(field.value).toBe("にほんご");

    // The same key once the candidate has been accepted still sends.
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mocks.submitChatMessage).toHaveBeenCalledTimes(1));
  });

  it("stays typable for the whole turn and offers a way to stop it", async () => {
    /*
     * Two failures in one window. `disabled` was `working || !chatReady`, so
     * the box went dead the instant Enter was pressed: a disabled control loses
     * focus, and every turn ended with the caret gone. And between `submitting`
     * turning true and the stream setting `busy`, Send was rendered-but-dead
     * while Stop was not rendered at all — a submitted run with no cancel.
     *
     * jsdom does not blur a control when it is disabled, so `disabled` is the
     * assertion carrying the focus claim here; the paste after it is what
     * proves the box still takes text.
     */
    mocks.submitChatMessage.mockReset();
    mocks.submitChatMessage.mockImplementation(neverSettles);
    const field = await composer();
    const user = userEvent.setup();
    await user.click(field);
    await user.paste("Summarise the incident runbook");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(mocks.submitChatMessage).toHaveBeenCalledTimes(1));
    const live = screen.getByLabelText("Chat message") as HTMLTextAreaElement;
    expect(live.disabled).toBe(false);
    expect(document.activeElement).toBe(live);
    await user.paste("and the escalation path");
    expect(live.value).toBe("and the escalation path");

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(mocks.cancelChatRun).toHaveBeenCalledTimes(1));
  });

  it("sends once when two submits land in the same tick", async () => {
    /*
     * `working` is read from state, so two submits dispatched before React
     * commits both read it as false. The second reached the server, came back
     * 409, and its catch restored the draft — leaving the message sent *and*
     * back in the composer. A ref is the only guard that closes in the same
     * tick it is set.
     */
    mocks.submitChatMessage.mockReset();
    mocks.submitChatMessage.mockImplementation(neverSettles);
    const field = await composer();
    const user = userEvent.setup();
    await user.click(field);
    await user.paste("Only once");
    const form = field.closest("form") as HTMLFormElement;

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.submitChatMessage).toHaveBeenCalledTimes(1);
  });

  it("recedes when setup is incomplete instead of dimming the reason", async () => {
    render(
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
    const field = await screen.findByLabelText("Chat message") as HTMLTextAreaElement;
    const form = field.closest("form");

    expect(field.disabled).toBe(true);
    /*
     * The placeholder is the only thing on screen that says why the box is
     * dead, and a container `opacity` veils it along with everything else:
     * measured in a browser at 60% it came to 2.6:1 against its own backdrop,
     * against the 4.5:1 the palette is built to clear. Off is stated in tokens
     * instead — the surface drops to the page colour and the shell casts
     * nothing, so the composer recedes without taking its own words with it.
     */
    expect(form?.className).not.toMatch(/(^|\s)opacity-/);
    expect(form?.classList.contains("bg-bg")).toBe(true);
    expect(form?.classList.contains("is-off")).toBe(true);
    expect(styles).toMatch(/\.chat-composer\.is-off\s*\{/);
  });

  it("reports the prompt it measured, overshoot and all", async () => {
    /*
     * `Math.min(100, …)` turned an overshoot into exactly "100%", which reads
     * as a window that is genuinely full — and the number it hid is the one
     * that says the *configured* window is stale. 5,000 against a configured
     * 4,096 is 122%, and 122% is the fact.
     */
    mocks.getChatConversation.mockResolvedValue(measured(5_000));
    mocks.getModelDeployments.mockResolvedValue({ items: [deployment(4_096)] });
    render(<ChatView {...props} />);

    const readout = await screen.findByLabelText("Context usage 122%");
    expect(readout.textContent).toContain("122%");
    // And it is the previous turn's prompt, which the bare word "Context" let
    // a reader take for the state of the box they are typing into.
    expect(readout.textContent).toContain("last turn");
    expect(readout.getAttribute("title")).toContain("5,000 of 4,096 tokens");
    expect(readout.getAttribute("title")).toContain("out of date");
  });

  it("separates a window size nobody may read from one nobody has", async () => {
    /*
     * `getModelDeployments` needs `models:read`, an administrator scope, so an
     * employee identity 401s into the empty catalogue every single time. "The
     * configured context window is not available" reported that authorization
     * result as missing data — and it is the only state most people ever saw.
     */
    mocks.getChatConversation.mockResolvedValue(measured(902));
    mocks.getModelDeployments.mockRejectedValue(new OrcaSynapseApiError(401, "Administrator scope models:read is required."));
    render(<ChatView {...props} identityMode="ENTERPRISE" />);

    const readout = await screen.findByLabelText(/^Context usage 902 tokens; the context window size needs administrator access$/);
    expect(readout.getAttribute("title")).toMatch(/administrator/i);
    expect(readout.getAttribute("title")).not.toContain("not available");
  });

  it("keeps its accessible names and ships no inline style attribute", async () => {
    const field = await composer();
    const form = field.closest("form");

    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    // `style-src 'self'` has no 'unsafe-inline'; a style attribute here is
    // dropped in the built image and nowhere else.
    expect(form?.querySelectorAll("[style]")).toHaveLength(0);
    expect(form?.outerHTML ?? "").not.toMatch(/\sstyle="/);
  });
});
