import { z } from "zod";
import { knowledgeSourceSchema } from "./memory.js";

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
  latencyMs: z.number().int().nonnegative().nullable(),
  finishReason: z.string().nullable(),
  errorCode: z.string().nullable(),
  sources: z.array(knowledgeSourceSchema).max(10),
  feedback: chatFeedbackSchema.nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const chatConversationSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(160),
  modelAlias: z.string().min(1).max(200),
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
    content: z.string().trim().min(1).max(32_000),
  })
  .strict();

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
});

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  chatStreamBaseSchema.extend({ type: z.literal("started") }),
  chatStreamBaseSchema.extend({ type: z.literal("delta"), delta: z.string().min(1) }),
  chatStreamBaseSchema.extend({ type: z.literal("completed"), message: chatMessageSchema }),
  chatStreamBaseSchema.extend({
    type: z.literal("failed"),
    error: z.string().min(1).max(500),
    errorCode: z.string().min(1).max(80),
  }),
  chatStreamBaseSchema.extend({ type: z.literal("cancelled") }),
]);

export type ChatConversationStatus = z.infer<typeof chatConversationStatusSchema>;
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;
export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;
export type ChatFeedbackRating = z.infer<typeof chatFeedbackRatingSchema>;
export type ChatFeedback = z.infer<typeof chatFeedbackSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatConversationSummary = z.infer<typeof chatConversationSummarySchema>;
export type ChatConversation = z.infer<typeof chatConversationSchema>;
export type ChatConversationList = z.infer<typeof chatConversationListSchema>;
export type CreateChatConversation = z.infer<typeof createChatConversationSchema>;
export type UpdateChatConversation = z.infer<typeof updateChatConversationSchema>;
export type SendChatMessage = z.infer<typeof sendChatMessageSchema>;
export type SetChatFeedback = z.infer<typeof setChatFeedbackSchema>;
export type ChatMetrics = z.infer<typeof chatMetricsSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
