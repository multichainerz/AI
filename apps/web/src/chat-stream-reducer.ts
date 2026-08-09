import type { ChatMessage, ChatStreamEvent, ChatConversation } from "@orcasynapse/contracts";

/**
 * The state transition for one streamed run event, as a pure function.
 *
 * It lived inside a `setActive` closure in `chat-view.tsx`, which meant the
 * only way to exercise it was to mount the whole chat view against a mocked
 * API and drive it through a real subscription. Nothing did, so the single
 * piece of logic that turns a Hermes run into what an operator reads had no
 * test at all — while the transcript fixtures that were supposed to stand in
 * for it described two event types the contract has never contained.
 *
 * Pulling it out is not a refactor for tidiness. Every part of the chat
 * rebuild lands here — a hydrate frame on reconnect, tool-call correlation,
 * folding the cursor-ordered stream into ordered blocks — and each of those is
 * a change to how a turn is reconstructed from events that may arrive late,
 * twice, or not at all. That deserves to be checkable in isolation.
 *
 * Contract: returns `conversation` unchanged (by identity) when the event does
 * not apply to it, so a caller can use the result directly as React state
 * without a redundant render.
 */
export function emptyMessage(
  conversationId: string,
  id: string,
  role: "USER" | "ASSISTANT",
  content: string,
  status: ChatMessage["status"],
  createdAt: string,
): ChatMessage {
  return {
    id,
    conversationId,
    role,
    status,
    content,
    modelAlias: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    latencyMs: null,
    firstTokenLatencyMs: null,
    finishReason: null,
    errorCode: null,
    agentRunId: null,
    runStatus: null,
    lastEventCursor: null,
    runtimeEvents: [],
    approvals: [],
    sources: [],
    feedback: null,
    createdAt,
    completedAt: null,
  };
}

export function applyStreamEventToConversation(
  conversation: ChatConversation | null,
  event: ChatStreamEvent,
  /*
   * Injected rather than read from the clock, because a placeholder message is
   * only ever created here and its timestamp is the one field a test cannot
   * predict. The caller passes `new Date().toISOString()`.
   */
  now: string,
): ChatConversation | null {
  if (!conversation || conversation.id !== event.conversationId) return conversation;

  if (event.type === "started") {
    if (conversation.messages.some(({ id }) => id === event.messageId)) {
      return {
        ...conversation,
        messages: conversation.messages.map((message) => message.id === event.messageId
          ? {
              ...message,
              agentRunId: event.runId,
              runStatus: message.runStatus ?? "QUEUED",
              lastEventCursor: event.cursor ?? message.lastEventCursor,
            }
          : message),
      };
    }
    return {
      ...conversation,
      messages: [
        ...conversation.messages,
        {
          ...emptyMessage(conversation.id, event.messageId, "ASSISTANT", "", "PENDING", now),
          agentRunId: event.runId,
          runStatus: "QUEUED",
          lastEventCursor: event.cursor,
        },
      ],
    };
  }

  if (event.type === "state") {
    return {
      ...conversation,
      messages: conversation.messages.map((message) => message.id === event.messageId
        ? { ...message, runStatus: event.status, lastEventCursor: event.cursor ?? message.lastEventCursor }
        : message),
    };
  }

  if (event.type === "activity") {
    return {
      ...conversation,
      messages: conversation.messages.map((message) => message.id === event.messageId
        ? {
            ...message,
            lastEventCursor: event.cursor ?? message.lastEventCursor,
            // Deduplicated by event id, because a reconnect resumes from the
            // last cursor the client saw and the server may replay the frame
            // that carried it.
            runtimeEvents: message.runtimeEvents.some(({ id }) => id === event.eventId)
              ? message.runtimeEvents
              : [...message.runtimeEvents, {
                  id: event.eventId,
                  cursor: event.cursor!,
                  type: event.activity,
                  summary: event.summary,
                  preview: event.preview,
                  status: event.status,
                  errorCode: event.errorCode,
                  toolName: event.toolName,
                  toolCallKey: event.toolCallKey,
                  text: event.text,
                  contentOffset: event.contentOffset,
                  childSessionId: event.childSessionId,
                  approvalId: event.approvalId,
                  durationMs: event.durationMs,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  reasoningTokens: event.reasoningTokens,
                  costUsd: event.costUsd,
                  occurredAt: event.occurredAt,
                }],
          }
        : message),
    };
  }

  if (event.type === "approval") {
    return {
      ...conversation,
      messages: conversation.messages.map((message) => message.id === event.messageId
        ? {
            ...message,
            runStatus: "WAITING_FOR_APPROVAL",
            lastEventCursor: event.cursor ?? message.lastEventCursor,
            // Replaced rather than appended: a decision arrives as the same
            // approval id with a new status, and two rows for one request
            // would offer the operator a second, already-resolved decision.
            approvals: [
              ...message.approvals.filter(({ id }) => id !== event.approval.id),
              event.approval,
            ],
          }
        : message),
    };
  }

  if (event.type === "delta") {
    return {
      ...conversation,
      messages: conversation.messages.map((message) => message.id === event.messageId
        ? { ...message, content: message.content + event.delta, lastEventCursor: event.cursor ?? message.lastEventCursor }
        : message),
    };
  }

  if (event.type === "completed") {
    return {
      ...conversation,
      messages: conversation.messages.map((message) => message.id === event.messageId ? event.message : message),
    };
  }

  return {
    ...conversation,
    messages: conversation.messages.map((message) => message.id === event.messageId
      ? {
          ...message,
          status: event.type === "cancelled" ? "CANCELLED" : "FAILED",
          runStatus: event.type === "cancelled" ? "CANCELLED" : "FAILED",
          lastEventCursor: event.cursor ?? message.lastEventCursor,
          errorCode: event.type === "failed" ? event.errorCode : "INFERENCE_CANCELLED",
        }
      : message),
  };
}
