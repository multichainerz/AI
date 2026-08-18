/**
 * @vitest-environment jsdom
 *
 * The dialog's scroll lock, which was the one inline-style write left in the
 * application.
 *
 * Be precise about what was wrong with it: `document.body.style.overflow` is a
 * per-property CSSOM write, and no browser's `style-src` blocks one, so this
 * never failed at runtime and never would have. What it did was put
 * `style="overflow: hidden"` on `<body>` in a codebase whose own rule is that
 * nothing ships an inline style — and it did so where the enforcement could not
 * see it. `scripts/test-csp-closure.sh` greps the bundle for
 * `setAttribute("style")`, which a property write is not, and every runtime
 * assertion in the suite reads `document.body.innerHTML`, which by definition
 * cannot contain `<body>`'s own attributes.
 *
 * Hence the assertion below: `document.body.getAttribute("style")`, the one
 * place the old write was visible from.
 */
import type { ChatConversation } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
} as ChatConversation;

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    getChatConversation: vi.fn(async () => conversation),
    getAgentProfiles: vi.fn(async () => ({ items: [] })),
    getModelDeployments: vi.fn(async () => ({ items: [] })),
    deleteChatConversation: vi.fn(async () => undefined),
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

afterEach(() => {
  cleanup();
  document.body.removeAttribute("style");
  document.body.className = "";
});

describe("the dialog scroll lock", () => {
  it("locks the page with a class and leaves no style attribute on the body", async () => {
    const user = userEvent.setup();
    render(<ChatView {...props} />);
    await user.click(await screen.findByRole("button", { name: /more/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");

    expect(document.body.classList.contains("overflow-hidden")).toBe(true);
    expect(document.body.getAttribute("style")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Keep" }));

    // And the page scrolls again afterwards, which is the half of the old
    // save-and-restore that actually had to be preserved.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.classList.contains("overflow-hidden")).toBe(false);
    expect(document.body.getAttribute("style")).toBeNull();
  });
});
