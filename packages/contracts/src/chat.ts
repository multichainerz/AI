import { z } from "zod";
import {
  agentRunApprovalSchema,
  agentRunStatusSchema,
} from "./agents.js";

export const CHAT_CONVERSATION_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export const CHAT_MESSAGE_ROLES = ["USER", "ASSISTANT"] as const;
export const CHAT_MESSAGE_STATUSES = [
  "PENDING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const chatConversationStatusSchema = z.enum(CHAT_CONVERSATION_STATUSES);
export const chatMessageRoleSchema = z.enum(CHAT_MESSAGE_ROLES);
export const chatMessageStatusSchema = z.enum(CHAT_MESSAGE_STATUSES);
export const chatFeedbackRatingSchema = z.enum(["HELPFUL", "NOT_HELPFUL"]);

export const chatRuntimeEventSchema = z.object({
  id: z.uuid(),
  cursor: z.string().regex(/^\d+$/),
  type: z.string().min(1).max(80),
  summary: z.string().max(1_000).nullable(),
  preview: z.string().max(1_000).nullable(),
  status: z.string().max(80).nullable(),
  errorCode: z.string().max(80).nullable(),
  toolName: z.string().max(160).nullable(),
  // Shared by every event of one tool call, so a reader can group them into a
  // single step. Null on events that are not part of a tool call.
  toolCallKey: z.string().max(200).nullable(),
  // Longer prose than `summary` holds: reasoning text, a tool's output.
  text: z.string().max(20_000).nullable(),
  // Characters of the answer already streamed when this event occurred, so the
  // timeline can interleave it with the text rather than append it after.
  contentOffset: z.number().int().nonnegative().nullable(),
  childSessionId: z.string().max(255).nullable(),
  approvalId: z.uuid().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  occurredAt: z.iso.datetime(),
});

export const chatFeedbackSchema = z.object({
  rating: chatFeedbackRatingSchema,
  comment: z.string().max(1_000).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const chatMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: chatMessageRoleSchema,
  status: chatMessageStatusSchema,
  content: z.string(),
  modelAlias: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  firstTokenLatencyMs: z.number().int().nonnegative().nullable(),
  finishReason: z.string().nullable(),
  errorCode: z.string().nullable(),
  agentRunId: z.uuid().nullable(),
  runStatus: agentRunStatusSchema.nullable(),
  lastEventCursor: z.string().regex(/^\d+$/).nullable(),
  runtimeEvents: z.array(chatRuntimeEventSchema).max(500),
  approvals: z.array(agentRunApprovalSchema).max(20),
  feedback: chatFeedbackSchema.nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const chatConversationSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(160),
  modelAlias: z.string().min(1).max(200),
  profileId: z.uuid().nullable(),
  profileName: z.string().min(1).max(120).nullable(),
  status: chatConversationStatusSchema,
  messageCount: z.number().int().nonnegative(),
  lastMessagePreview: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime().nullable(),
});

export const chatConversationSchema = chatConversationSummarySchema.extend({
  messages: z.array(chatMessageSchema),
});

export const chatConversationListSchema = z.object({
  items: z.array(chatConversationSummarySchema),
});

export const createChatConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    modelAlias: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
      .optional(),
    profileId: z.uuid().optional(),
  })
  .strict();

export const updateChatConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    status: chatConversationStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one conversation field must be provided.",
  });

export const sendChatMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(128_000),
  })
  .strict();

export const chatMessageSubmissionSchema = z.object({
  conversationId: z.uuid(),
  userMessage: chatMessageSchema,
  assistantMessage: chatMessageSchema,
});

export const forkChatConversationSchema = z.object({
  throughMessageId: z.uuid().optional(),
}).strict();

/**
 * The cadence bounds, matched by `ChatSchedule_intervalSeconds_check`.
 *
 * Five minutes rather than the thirty seconds `ConnectionMonitoringControl`
 * allows, because these are not probes: every fire is a model call charged to
 * the deployment, and a five-minute floor is already 288 runs a day. A week is
 * the ceiling because past it an operator is describing a calendar rather than
 * a cadence, and this is not a calendar.
 */
export const CHAT_SCHEDULE_MIN_INTERVAL_SECONDS = 300;
export const CHAT_SCHEDULE_MAX_INTERVAL_SECONDS = 604_800;

/**
 * What a scheduled turn last did, reported where the operator is looking.
 *
 * `SKIPPED` and `DISABLED` are not the same outcome and must not render as one.
 * A rate-limited fire is skipped and will be retried on the next tick; a
 * guardrail block or an archived conversation disables the schedule, because
 * repeating it would refuse identically forever.
 */
export const CHAT_SCHEDULE_OUTCOMES = ["OK", "SKIPPED", "DISABLED"] as const;
export const chatScheduleOutcomeSchema = z.enum(CHAT_SCHEDULE_OUTCOMES);

export const chatScheduleSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  prompt: z.string().min(1).max(128_000),
  intervalSeconds: z.number().int(),
  nextRunAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  lastOutcome: chatScheduleOutcomeSchema.nullable(),
  lastDetail: z.string().max(500).nullable(),
  enabled: z.boolean(),
  createdBySubject: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const chatScheduleListSchema = z.object({
  items: z.array(chatScheduleSchema),
});

/*
 * The prompt is bounded here by the same 32,000 characters `sendChatMessage`
 * uses, and again by the active policy's own ceiling when the schedule is
 * written. Checking the policy at write time as well as at fire time is what
 * lets an operator learn about a refusal while they are looking at the form,
 * rather than silently every morning.
 */
export const createChatScheduleSchema = z
  .object({
    prompt: z.string().trim().min(1).max(128_000),
    intervalSeconds: z.number().int()
      .min(CHAT_SCHEDULE_MIN_INTERVAL_SECONDS)
      .max(CHAT_SCHEDULE_MAX_INTERVAL_SECONDS),
    // Absent means "one interval from now". An explicit time is what an
    // operator reaches for when the first run should land at a particular hour.
    startAt: z.iso.datetime().optional(),
  })
  .strict();

export const updateChatScheduleSchema = z
  .object({
    prompt: z.string().trim().min(1).max(128_000).optional(),
    intervalSeconds: z.number().int()
      .min(CHAT_SCHEDULE_MIN_INTERVAL_SECONDS)
      .max(CHAT_SCHEDULE_MAX_INTERVAL_SECONDS)
      .optional(),
    enabled: z.boolean().optional(),
    /*
     * The revision the caller believes it is editing.
     *
     * `ChatSchedule.revision` was stored and returned from the moment the table
     * existed, and nothing ever compared it -- so the field advertised a
     * conflict check the product did not perform, and two operators editing one
     * schedule silently took turns overwriting each other. Optional rather than
     * required so an existing client is not broken by adding it; supplied, it is
     * enforced, which is the same bargain `approveReleaseTargetSchema` strikes
     * one package over.
     */
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one schedule field must be provided.",
  });

export const setChatFeedbackSchema = z
  .object({
    rating: chatFeedbackRatingSchema,
    comment: z.string().trim().min(1).max(1_000).nullable().optional(),
  })
  .strict();

export const chatMetricsSchema = z.object({
  windowStartedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  conversations: z.number().int().nonnegative(),
  responses: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  averageLatencyMs: z.number().int().nonnegative().nullable(),
  failureRate: z.number().min(0).max(1),
  feedback: z.object({
    helpful: z.number().int().nonnegative(),
    notHelpful: z.number().int().nonnegative(),
  }),
});

const chatStreamBaseSchema = z.object({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  cursor: z.string().regex(/^\d+$/).nullable(),
});

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  chatStreamBaseSchema.extend({ type: z.literal("started"), runId: z.uuid() }),
  chatStreamBaseSchema.extend({ type: z.literal("state"), runId: z.uuid(), status: agentRunStatusSchema }),
  chatStreamBaseSchema.extend({
    type: z.literal("activity"),
    runId: z.uuid(),
    eventId: z.uuid(),
    activity: z.string().min(1).max(80),
    summary: z.string().max(1_000).nullable(),
    preview: z.string().max(1_000).nullable(),
    status: z.string().max(80).nullable(),
    errorCode: z.string().max(80).nullable(),
    toolName: z.string().max(160).nullable(),
    // Carried live as well as on reload: a tool card that gained a key only
    // after a refresh would regroup itself under the reader.
    toolCallKey: z.string().max(200).nullable(),
    text: z.string().max(20_000).nullable(),
    contentOffset: z.number().int().nonnegative().nullable(),
    childSessionId: z.string().max(255).nullable(),
    approvalId: z.uuid().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    occurredAt: z.iso.datetime(),
  }),
  chatStreamBaseSchema.extend({
    type: z.literal("approval"),
    runId: z.uuid(),
    approval: agentRunApprovalSchema,
  }),
  chatStreamBaseSchema.extend({ type: z.literal("delta"), delta: z.string().min(1) }),
  chatStreamBaseSchema.extend({ type: z.literal("completed"), message: chatMessageSchema }),
  chatStreamBaseSchema.extend({
    type: z.literal("failed"),
    error: z.string().min(1).max(500),
    errorCode: z.string().min(1).max(80),
  }),
  chatStreamBaseSchema.extend({ type: z.literal("cancelled") }),
  /*
   * The transport gave out, not the run. Distinct from `failed`, which is the
   * run itself reporting an error code: here the run may still be going, and
   * the honest thing to tell a reader is that the connection stopped and can
   * be resumed from the cursor they already hold -- not that their answer
   * failed. It was the one frame written raw, past the validation every other
   * frame goes through, and hand-parsed at the other end.
   */
  chatStreamBaseSchema.extend({
    type: z.literal("stream_error"),
    error: z.string().min(1).max(500),
  }),
]);

export type ChatConversationStatus = z.infer<typeof chatConversationStatusSchema>;
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;
export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;
export type ChatFeedbackRating = z.infer<typeof chatFeedbackRatingSchema>;
export type ChatRuntimeEvent = z.infer<typeof chatRuntimeEventSchema>;
export type ChatFeedback = z.infer<typeof chatFeedbackSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatConversationSummary = z.infer<typeof chatConversationSummarySchema>;
export type ChatConversation = z.infer<typeof chatConversationSchema>;
export type ChatConversationList = z.infer<typeof chatConversationListSchema>;
export type CreateChatConversation = z.infer<typeof createChatConversationSchema>;
export type UpdateChatConversation = z.infer<typeof updateChatConversationSchema>;
export type SendChatMessage = z.infer<typeof sendChatMessageSchema>;
export type SetChatFeedback = z.infer<typeof setChatFeedbackSchema>;
export type ChatMessageSubmission = z.infer<typeof chatMessageSubmissionSchema>;
export type ForkChatConversation = z.infer<typeof forkChatConversationSchema>;
export type ChatMetrics = z.infer<typeof chatMetricsSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type ChatScheduleOutcome = z.infer<typeof chatScheduleOutcomeSchema>;
export type ChatSchedule = z.infer<typeof chatScheduleSchema>;
export type ChatScheduleList = z.infer<typeof chatScheduleListSchema>;
export type CreateChatSchedule = z.infer<typeof createChatScheduleSchema>;
export type UpdateChatSchedule = z.infer<typeof updateChatScheduleSchema>;
