/**
 * @vitest-environment jsdom
 *
 * Chat's four overlays were bare divs carrying `role="dialog"` and nothing else:
 * no `aria-modal`, no focus trap, no Escape, no scroll lock. A keyboard user
 * could tab out of a modal into the transcript behind it while a
 * screen reader kept describing the page as if nothing had opened. These cases
 * hold the replacement shut, along with the conversation menu that had no way
 * to dismiss it at all.
 */
import type { ChatConversation } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const conversation: ChatConversation = {
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
} as ChatConversation;

const deleteChatConversation = vi.fn(async () => undefined);

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    getChatConversation: vi.fn(async () => conversation),
    getAgentProfiles: vi.fn(async () => ({ items: [] })),
    deleteChatConversation,
  };
});

// jsdom implements no layout, so the transcript's scroll-into-view is a no-op.
Element.prototype.scrollIntoView = () => undefined;

const { ChatView } = await import("./chat-view.js");

const props = {
  unlocked: true,
  displayName: "Operator",
  administratorReadiness: null,
  onSignIn: vi.fn(),
  onConfigure: vi.fn(),
  onOpenAgents: vi.fn(),
  onOpenPlatform: vi.fn(),
  onSessionExpired: vi.fn(),
};

beforeEach(() => { deleteChatConversation.mockClear(); });
afterEach(cleanup);

describe("chat overlays", () => {
  it("groups the conversation rail under a date heading", async () => {
    /*
     * A flat list of forty titles gives a reader nothing to navigate by. The
     * grouping function is tested on its own; this is the wiring, which is the
     * part that can silently render nothing -- `groupConversationsByDate`
     * returning correct buckets that no JSX consumes would leave every other
     * test in this file green.
     *
     * This fixture has `lastMessageAt: null`, so it lands in the bucket for a
     * conversation that was created but never sent to.
     */
    render(<ChatView {...props} />);

    const heading = await screen.findByRole("heading", { name: "No messages" });
    // Level 3: the sr-only h1 in this rail is the outside-click target, and a
    // second level-1 heading would make that ambiguous.
    expect(heading.tagName).toBe("H3");
    expect(await screen.findByRole("button", { name: /Runbook questions/ })).toBeTruthy();
    const create = screen.getByRole("button", { name: "New conversation" });
    expect(create.textContent?.trim()).toBe("New conversation");
    expect(create.className).toContain("bg-accent-fill");
    expect(create.className).not.toContain("justify-between");
  });

  it("keeps Tab inside the open dialog", async () => {
    // The failure this replaces was silent: focus simply walked out of the
    // panel and into the conversation behind it.
    const user = userEvent.setup();
    render(<ChatView {...props} />);
    await user.click(await screen.findByRole("button", { name: /more/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");

    for (let press = 0; press < 6; press += 1) await user.tab();

    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("asks before deleting, and Keep leaves the conversation alone", async () => {
    const user = userEvent.setup();
    render(<ChatView {...props} />);
    await user.click(await screen.findByRole("button", { name: /more/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Audit evidence remains/)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Keep" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deleteChatConversation).not.toHaveBeenCalled();
  });
});

describe("conversation menu", () => {
  it("closes on Escape rather than staying open over the transcript", async () => {
    // Archive and Delete live in this menu, so one left open is one click from
    // an action nobody meant to take.
    const user = userEvent.setup();
    render(<ChatView {...props} />);
    await user.click(await screen.findByRole("button", { name: /more/i }));
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes when the pointer goes anywhere else", async () => {
    const user = userEvent.setup();
    render(<ChatView {...props} />);
    await user.click(await screen.findByRole("button", { name: /more/i }));

    await user.click(screen.getByRole("heading", { level: 1 }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("chat locked screen", () => {
  /*
   * The two-state version of this case is gone with federated sign-in: there is
   * no longer a deployment in which Chat is locked *and* signing in is
   * impossible, because a person an administrator created can always sign in.
   * What remains worth pinning is that the locked screen offers both doors --
   * the one the visitor can use and the one that leads to whoever can help.
   */
  it("offers sign-in and a route to the administrator", async () => {
    const onSignIn = vi.fn();
    const user = userEvent.setup();
    render(<ChatView {...props} unlocked={false} onSignIn={onSignIn} />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalled();
    // The person who cannot sign in is usually not the person who can fix it.
    expect(screen.getByRole("button", { name: "Administrator setup" })).toBeTruthy();
  });
});
