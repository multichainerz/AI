/**
 * @vitest-environment jsdom
 *
 * What Chat does when the stream will not come back.
 *
 * Every non-401 failure incremented a counter, wrote `Connection interrupted ·
 * retrying (N)` into the activity line and went round again — forever, while
 * the message stayed PENDING. Not every failure is transient: the chat manager
 * throws "The Hermes run is no longer available" when a message points at an
 * `AgentRun` that has been deleted, and that answer is the same on every
 * attempt. `setError` was never called on this path, so a run that could never
 * resume showed a small grey line and nothing else, every five seconds, until
 * the tab was closed.
 */
import type { AgentProfile, ChatConversation } from "@orcasynapse/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const message = (over: Record<string, unknown>) => ({
  id: String(over.id),
  role: "ASSISTANT",
  content: "",
  status: "COMPLETED",
  createdAt: "2026-08-07T09:14:00.000Z",
  modelAlias: "hermes-agent",
  totalTokens: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  latencyMs: null,
  firstTokenLatencyMs: null,
  finishReason: null,
  errorCode: null,
  agentRunId: null,
  runStatus: null,
  lastEventCursor: null,
  approvals: [],
  runtimeEvents: [],
  feedback: null,
  ...over,
});

const conversation = {
  id: "8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  title: "Runbook questions",
  modelAlias: "hermes-agent",
  profileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  profileName: "Support agent",
  status: "ACTIVE",
  messageCount: 2,
  lastMessagePreview: "Run it.",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T09:15:00.000Z",
  lastMessageAt: "2026-08-07T09:15:00.000Z",
  messages: [
    message({ id: "m1", role: "USER", content: "Run it.", status: "COMPLETED" }),
    // The row the stream is following: PENDING, with a run to follow.
    message({
      id: "m2",
      status: "PENDING",
      agentRunId: "814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd",
      runStatus: "RUNNING",
    }),
  ],
} as unknown as ChatConversation;

const profile = {
  id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  name: "Support agent",
  status: "ACTIVE",
  version: { displayName: "Support agent v1" },
  activeVersionConfiguration: { displayName: "Support agent v1" },
} as unknown as AgentProfile;

const mocks = vi.hoisted(() => ({
  streamChatEvents: vi.fn(),
  getChatConversation: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    // The message stays PENDING on every refetch, which is what a deleted
    // `AgentRun` looks like from here: the server has no news, and no news is
    // not a reason to stop asking — but a bounded number of reasons is.
    getChatConversation: mocks.getChatConversation,
    getAgentProfiles: vi.fn(async () => ({ items: [profile] })),
    getModelDeployments: vi.fn(async () => ({ items: [] })),
    streamChatEvents: mocks.streamChatEvents,
  };
});

// jsdom implements no layout, so the transcript's scroll-into-view is a no-op.
Element.prototype.scrollIntoView = () => undefined;

const { ChatView, STREAM_RECONNECT_LIMIT } = await import("./chat-view.js");

/**
 * One reconnect round of virtual time.
 *
 * Advancing once for the whole sequence does not work: a round's backoff timer
 * is only scheduled after the failure it is backing off from has been awaited,
 * and the awaits in between run as real macrotasks. So each round needs its own
 * advance, past the five-second cap the backoff tops out at.
 */
const reconnectRound = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
};

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

beforeEach(() => {
  mocks.streamChatEvents.mockReset();
  mocks.streamChatEvents.mockRejectedValue(new Error("The Hermes run is no longer available."));
  mocks.getChatConversation.mockReset();
  mocks.getChatConversation.mockResolvedValue(conversation);
});
afterEach(cleanup);

describe("the chat reconnect loop", () => {
  it("gives up on a failure that will not clear, and says so", async () => {
    vi.useFakeTimers();
    try {
      render(<ChatView {...props} />);
      // Generous: twice the bound, so an unbounded loop is measured rather than
      // assumed, and the count below is what says where it actually stopped.
      for (let round = 0; round < STREAM_RECONNECT_LIMIT * 2 + 4; round += 1) {
        if (screen.queryByText(/Lost contact with this Hermes run/)) break;
        await reconnectRound();
      }

      // A bound that is genuinely a bound: tens of seconds, not an afternoon.
      expect(STREAM_RECONNECT_LIMIT).toBeLessThanOrEqual(8);
      expect(mocks.streamChatEvents.mock.calls.length).toBe(STREAM_RECONNECT_LIMIT);

      // A grey activity line is not an error surface. The reason the run cannot
      // resume is the server's own, and it belongs on screen.
      expect(screen.getByText(/Lost contact with this Hermes run/)).toBeTruthy();
      expect(screen.getByText(/The Hermes run is no longer available\./)).toBeTruthy();
      expect(screen.queryByText(/Connection interrupted/)).toBeNull();

      // And it is genuinely stopped, not merely slower.
      await reconnectRound();
      await reconnectRound();
      expect(mocks.streamChatEvents.mock.calls.length).toBe(STREAM_RECONNECT_LIMIT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying when the recovery refetch fails alongside the stream", async () => {
    /*
     * The two calls are same-origin fetches issued back to back, so a two-second
     * network drop takes both — the ordinary case, not an exotic one. A failed
     * refetch yields no conversation and therefore no pending message, and the
     * loop used to read that as "the run finished" and return, on the very first
     * attempt: no error, no retry, and no dependency changed, so nothing ever
     * started it again. The transcript sat on "reconnecting" for a run that was
     * still going, Stop unmounted because `working` had gone false, and a new
     * message was refused 409 until the pending row went stale an hour later.
     * Reopening the conversation did not help, because the effect keys on the
     * pending message's id and that had not changed.
     *
     * The refetch failing must therefore be indistinguishable from the stream
     * failing: keep going, and give up only through the bound above.
     */
    vi.useFakeTimers();
    try {
      // Only the *recovery* refetches fail. The initial load has to succeed or
      // the component never opens a stream and the test proves nothing.
      mocks.getChatConversation.mockImplementation(async () => {
        if (mocks.streamChatEvents.mock.calls.length === 0) return conversation;
        throw new Error("Failed to fetch");
      });
      render(<ChatView {...props} />);
      for (let round = 0; round < STREAM_RECONNECT_LIMIT * 2 + 4; round += 1) {
        if (screen.queryByText(/Lost contact with this Hermes run/)) break;
        await reconnectRound();
      }

      // Retried to the bound rather than abandoning the run on attempt one.
      expect(mocks.streamChatEvents.mock.calls.length).toBe(STREAM_RECONNECT_LIMIT);
      expect(screen.getByText(/Lost contact with this Hermes run/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
