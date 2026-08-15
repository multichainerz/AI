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
import type { AgentProfile, ChatConversation } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const mocks = vi.hoisted(() => ({ submitChatMessage: vi.fn() }));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    getChatConversation: vi.fn(async () => conversation),
    getAgentProfiles: vi.fn(async () => ({ items: [profile] })),
    submitChatMessage: mocks.submitChatMessage,
  };
});

// jsdom implements no layout, so the transcript's scroll-into-view is a no-op.
Element.prototype.scrollIntoView = () => undefined;

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

beforeEach(() => {
  mocks.submitChatMessage.mockReset();
  mocks.submitChatMessage.mockRejectedValue(new Error("The Hermes route is unavailable."));
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
