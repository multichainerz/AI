/**
 * The streaming reducer, driven through every frame the contract can send.
 *
 * Before this file, the path from a Hermes run event to what an operator reads
 * had no test of any kind. The two transcript fixtures that looked like they
 * covered it asserted on event types — `TOOL_CALLED`, `SUBAGENT_FINISHED` —
 * that have never existed in `AGENT_RUN_EVENT_TYPES`, and only compiled
 * because the fixture was cast through `unknown`. So the tests agreed with the
 * component about a vocabulary neither shared with the contract.
 *
 * The cases below are the ones a rewrite silently breaks: a frame for another
 * conversation, a replayed frame after reconnect, an approval decided after it
 * was requested, and a terminal frame that has to win over whatever partial
 * text was on screen.
 */
import {
  AGENT_RUN_EVENT_TYPES,
  chatStreamEventSchema,
  type ChatConversation,
  type ChatMessage,
  type ChatStreamEvent,
} from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { applyStreamEventToConversation, emptyMessage } from "./chat-stream-reducer.js";

const CONVERSATION = "6f1e8a3c-2b4d-4e6f-8a0b-1c2d3e4f5a6b";
const OTHER_CONVERSATION = "7a2f9b4d-3c5e-4f70-9b1c-2d3e4f5a6b7c";
const MESSAGE = "1f2e3d4c-5b6a-4978-8867-564534231201";
const RUN = "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b";
const EVENT = "8b3c0d5e-4f61-4a72-8c3d-4e5f6a7b8c9d";
const NOW = "2026-08-09T00:00:00.000Z";

function conversation(messages: ChatMessage[]): ChatConversation {
  return {
    id: CONVERSATION,
    profileId: "2c4d6e80-1a3b-4c5d-8e9f-0a1b2c3d4e5f",
    profileName: "Support agent",
    title: "Governed conversation",
    status: "ACTIVE",
    createdAt: NOW,
    lastMessageAt: NOW,
    messages,
  } as ChatConversation;
}

const pending = () => ({
  ...emptyMessage(CONVERSATION, MESSAGE, "ASSISTANT", "", "PENDING", NOW),
  agentRunId: RUN,
  runStatus: "RUNNING" as const,
});

/**
 * Every frame is validated against the contract before it reaches the reducer.
 * A test that invents a shape the server cannot send proves nothing, which is
 * exactly how the previous fixtures came to describe two imaginary event types.
 */
function frame(event: unknown): ChatStreamEvent {
  return chatStreamEventSchema.parse(event);
}

const activityFrame = (overrides: Record<string, unknown> = {}) => frame({
  type: "activity",
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  cursor: "4",
  runId: RUN,
  eventId: EVENT,
  activity: "TOOL_STARTED",
  summary: null,
  preview: null,
  status: null,
  errorCode: null,
  toolName: "system.status",
  toolCallKey: "system.status#1",
  text: null,
  contentOffset: 0,
  childSessionId: null,
  approvalId: null,
  durationMs: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  costUsd: null,
  occurredAt: NOW,
  ...overrides,
});

describe("streamed run events", () => {
  it("ignores a frame addressed to a different conversation, by identity", () => {
    // Two conversations can stream at once if an operator switches mid-run.
    // Returning a new object here would re-render the visible thread with the
    // other one's content.
    const before = conversation([pending()]);
    const after = applyStreamEventToConversation(
      before,
      frame({ type: "delta", conversationId: OTHER_CONVERSATION, messageId: MESSAGE, cursor: "2", delta: "x" }),
      NOW,
    );
    expect(after).toBe(before);
  });

  it("creates the assistant placeholder when `started` arrives before the message exists", () => {
    const after = applyStreamEventToConversation(
      conversation([]),
      frame({ type: "started", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "1", runId: RUN }),
      NOW,
    );
    expect(after?.messages).toHaveLength(1);
    expect(after?.messages[0]).toMatchObject({ id: MESSAGE, role: "ASSISTANT", runStatus: "QUEUED", agentRunId: RUN });
  });

  it("adopts an existing message on `started` rather than duplicating the turn", () => {
    // Reconnect replays `started`. Appending again would show the operator two
    // answers to one question.
    const after = applyStreamEventToConversation(
      conversation([pending()]),
      frame({ type: "started", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "1", runId: RUN }),
      NOW,
    );
    expect(after?.messages).toHaveLength(1);
    // The live status survives: the run is further along than QUEUED.
    expect(after?.messages[0]?.runStatus).toBe("RUNNING");
  });

  it("appends delta text and advances the cursor", () => {
    const first = applyStreamEventToConversation(
      conversation([pending()]),
      frame({ type: "delta", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "2", delta: "Hello" }),
      NOW,
    );
    const second = applyStreamEventToConversation(
      first,
      frame({ type: "delta", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "3", delta: " world" }),
      NOW,
    );
    expect(second?.messages[0]?.content).toBe("Hello world");
    expect(second?.messages[0]?.lastEventCursor).toBe("3");
  });

  it("records an activity event once, however many times the frame is replayed", () => {
    // Resume is `cursor > last seen`, so the frame carrying that cursor comes
    // back. Twice in the timeline is two tool calls to anyone reading it.
    const once = applyStreamEventToConversation(conversation([pending()]), activityFrame(), NOW);
    const twice = applyStreamEventToConversation(once, activityFrame(), NOW);
    expect(twice?.messages[0]?.runtimeEvents).toHaveLength(1);
    expect(twice?.messages[0]?.runtimeEvents[0]).toMatchObject({ type: "TOOL_STARTED", toolName: "system.status" });
  });

  it("replaces an approval when it is decided instead of listing it twice", () => {
    const request = {
      id: "9c4d1e6f-5a72-4b83-9d4e-5f6a7b8c9d0e",
      runId: RUN,
      status: "PENDING" as const,
      command: "rg --files packages/",
      summary: "List files under packages/",
      // The contract already carries the two things the current UI never draws:
      // the decision set, and an expiry the operator is racing.
      choices: ["ALLOW_ONCE", "DENY"] as const,
      requestedAt: NOW,
      expiresAt: "2026-08-09T00:05:00.000Z",
      decidedAt: null,
      decision: null,
    };
    const requested = applyStreamEventToConversation(
      conversation([pending()]),
      frame({ type: "approval", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "5", runId: RUN, approval: request }),
      NOW,
    );
    expect(requested?.messages[0]?.runStatus).toBe("WAITING_FOR_APPROVAL");

    const decided = applyStreamEventToConversation(
      requested,
      frame({
        type: "approval", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "6", runId: RUN,
        approval: { ...request, status: "APPROVED", decidedAt: NOW, decision: "ALLOW_ONCE" },
      }),
      NOW,
    );
    // Two rows would offer a second decision on a request already resolved.
    expect(decided?.messages[0]?.approvals).toHaveLength(1);
    expect(decided?.messages[0]?.approvals[0]?.status).toBe("APPROVED");
  });

  it("lets the completed message win over the streamed partial text", () => {
    const streaming = applyStreamEventToConversation(
      conversation([pending()]),
      frame({ type: "delta", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "2", delta: "partial draf" }),
      NOW,
    );
    const final: ChatMessage = {
      ...emptyMessage(CONVERSATION, MESSAGE, "ASSISTANT", "The reconciled answer.", "COMPLETED", NOW),
      completedAt: NOW,
      runStatus: "COMPLETED",
    };
    const done = applyStreamEventToConversation(
      streaming,
      frame({ type: "completed", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "9", message: final }),
      NOW,
    );
    // Hermes reconciles its own output at the end; a coalesced delta that lost
    // the race must not survive into the record.
    expect(done?.messages[0]?.content).toBe("The reconciled answer.");
    expect(done?.messages[0]?.status).toBe("COMPLETED");
  });

  it("marks a failed turn with the error code the frame carried", () => {
    const after = applyStreamEventToConversation(
      conversation([pending()]),
      frame({ type: "failed", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "7", error: "Upstream refused the request.", errorCode: "INFERENCE_UNAVAILABLE" }),
      NOW,
    );
    expect(after?.messages[0]).toMatchObject({ status: "FAILED", runStatus: "FAILED", errorCode: "INFERENCE_UNAVAILABLE" });
  });

  it("marks a cancelled turn as cancelled, not as a failure", () => {
    // Stop is an operator decision. Reporting it as a failure invites someone
    // to go looking for a fault that is not there.
    const after = applyStreamEventToConversation(
      conversation([pending()]),
      frame({ type: "cancelled", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "8" }),
      NOW,
    );
    expect(after?.messages[0]).toMatchObject({ status: "CANCELLED", runStatus: "CANCELLED", errorCode: "INFERENCE_CANCELLED" });
  });

  it("survives a full run in cursor order and keeps every frame's contribution", () => {
    const script: ChatStreamEvent[] = [
      frame({ type: "started", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "1", runId: RUN }),
      frame({ type: "state", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "2", runId: RUN, status: "RUNNING" }),
      activityFrame({ cursor: "3" }),
      frame({ type: "delta", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "4", delta: "Based on " }),
      frame({ type: "delta", conversationId: CONVERSATION, messageId: MESSAGE, cursor: "5", delta: "your sources" }),
    ];
    const result = script.reduce<ChatConversation | null>(
      (state, event) => applyStreamEventToConversation(state, event, NOW),
      conversation([]),
    );
    expect(result?.messages[0]?.content).toBe("Based on your sources");
    expect(result?.messages[0]?.runStatus).toBe("RUNNING");
    expect(result?.messages[0]?.runtimeEvents).toHaveLength(1);
    expect(result?.messages[0]?.lastEventCursor).toBe("5");
  });

  it("names the activity vocabulary the contract actually defines", () => {
    // The guard the old fixtures needed. `TOOL_CALLED` and `SUBAGENT_FINISHED`
    // were asserted on for months and are not members; anything the UI branches
    // on has to come from this list.
    expect(AGENT_RUN_EVENT_TYPES).toContain("TOOL_STARTED");
    expect(AGENT_RUN_EVENT_TYPES).toContain("SUBAGENT_COMPLETED");
    expect(AGENT_RUN_EVENT_TYPES).not.toContain("TOOL_CALLED" as never);
    expect(AGENT_RUN_EVENT_TYPES).not.toContain("SUBAGENT_FINISHED" as never);
  });
});
