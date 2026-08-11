/**
 * @vitest-environment jsdom
 *
 * The thread's scrolling behaviour, wired.
 *
 * `shouldStickToBottom` is tested as a pure function because jsdom reports
 * every scroll metric as zero. That leaves exactly the part this file covers:
 * that a real element is listened to, that leaving the bottom offers the way
 * back, and that the way back is not floating over an open dialog. All three
 * fail silently -- the transcript simply stops following, or never offers to
 * return -- and no other test in the suite would notice.
 */
import type { ChatConversation } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THREAD_MEASURE } from "./chat/measure.js";

const conversation = {
  id: "8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  title: "Runbook questions",
  modelAlias: "qwen3.6-27b",
  profileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  profileName: "Support agent",
  status: "ACTIVE",
  messageCount: 1,
  // Deliberately not the message body: the rail renders a preview, and one that
  // matched would make every query below ambiguous.
  lastMessagePreview: "Promotion checks",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T09:15:00.000Z",
  lastMessageAt: "2026-08-07T09:15:00.000Z",
  messages: [{
    id: "m1",
    role: "ASSISTANT",
    content: "Promote when the three checks pass.",
    status: "COMPLETED",
    createdAt: "2026-08-07T09:14:00.000Z",
    modelAlias: "qwen3.6-27b",
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    latencyMs: null,
    firstTokenLatencyMs: null,
    finishReason: "STOP",
    errorCode: null,
    agentRunId: null,
    approvals: [],
    runtimeEvents: [],
    feedback: null,
  }],
} as unknown as ChatConversation;

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    getChatConversation: vi.fn(async () => conversation),
    getAgentProfiles: vi.fn(async () => ({ items: [] })),
  };
});

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
  onSessionExpired: vi.fn(),
};

async function thread() {
  render(<ChatView {...props} />);
  const answer = await screen.findByText("Promote when the three checks pass.");
  const scroller = answer.closest("div.overflow-y-auto");
  if (!scroller) throw new Error("The transcript is not inside a scrolling element.");
  return scroller as HTMLElement;
}

/**
 * A transcript taller than its viewport, scrolled `fromBottom` pixels up.
 *
 * jsdom performs no layout, so every scroll metric reads zero and the element
 * always looks pinned. Defining them is the only way to exercise the branch a
 * reader actually hits.
 */
function scrollUpBy(scroller: HTMLElement, fromBottom: number) {
  for (const [metric, value] of [["scrollHeight", 4_000], ["clientHeight", 800]] as const) {
    Object.defineProperty(scroller, metric, { value, configurable: true, writable: true });
  }
  Object.defineProperty(scroller, "scrollTop", {
    value: 4_000 - 800 - fromBottom,
    configurable: true,
    writable: true,
  });
  fireEvent.scroll(scroller);
}

afterEach(cleanup);

describe("chat thread layout", () => {
  it("reads the whole transcript in one measured column", async () => {
    // Four widths decided where a line ended before this -- 940 on the answer,
    // 720 on the empty state, 600 on the bubble, 940 on the composer -- so the
    // eye had to re-find the left edge on every turn.
    const scroller = await thread();

    expect(scroller.children).toHaveLength(1);
    expect(scroller.firstElementChild?.className).toBe(THREAD_MEASURE);
  });

  it("does not read the growing transcript back on every delta", async () => {
    /*
     * `aria-live` on the scroller announced the entire thread each time a token
     * landed, several times a second. The live status beside the pending turn
     * carries it now, and says it once per change.
     */
    const scroller = await thread();

    expect(scroller.hasAttribute("aria-live")).toBe(false);
  });

  it("offers the way back only once the reader has left the bottom", async () => {
    /*
     * Stopping the transcript following is half a fix: a reader who scrolled up
     * during a live run then has to hunt for the bottom of something that is
     * still growing.
     */
    const scroller = await thread();
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    scrollUpBy(scroller, 900);

    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("goes to the bottom when asked, and stops offering", async () => {
    const user = userEvent.setup();
    const scroller = await thread();
    scrollUpBy(scroller, 900);

    await user.click(await screen.findByRole("button", { name: "Jump to latest" }));

    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull());
  });

  it("keeps the way back off the screen while a dialog owns it", async () => {
    // A dialog takes the whole screen; a control floating on its backdrop is
    // one the reader can see, cannot reach, and did not ask for.
    const user = userEvent.setup();
    const scroller = await thread();
    scrollUpBy(scroller, 900);
    await screen.findByRole("button", { name: "Jump to latest" });

    await user.click(screen.getByRole("button", { name: /more/i }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("puts every dialog after the transcript it covers", async () => {
    /*
     * They used to sit between the header and the thread. A modal rendered
     * before the content it overlays is a modal whose stacking depends on the
     * z-index of everything after it, and whose reading order announces it
     * before the conversation it interrupted.
     */
    const user = userEvent.setup();
    const scroller = await thread();

    await user.click(screen.getByRole("button", { name: /more/i }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");

    expect(scroller.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
