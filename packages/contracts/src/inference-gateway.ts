import { z } from "zod";

const extensionObjectSchema = z.record(z.string(), z.unknown());
const messageContentSchema = z.union([z.string().max(120_000), z.null()]);

export const inferenceGatewayMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: messageContentSchema.optional(),
  name: z.string().min(1).max(120).optional(),
  tool_call_id: z.string().min(1).max(500).optional(),
  tool_calls: z.array(extensionObjectSchema).max(128).optional(),
}).strict();

export const inferenceGatewayChatRequestSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  messages: z.array(inferenceGatewayMessageSchema).min(1).max(200),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().min(1).max(131_072).optional(),
  max_completion_tokens: z.number().int().min(1).max(131_072).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string().max(500), z.array(z.string().max(500)).max(16)]).optional(),
  tools: z.array(extensionObjectSchema).max(128).optional(),
  tool_choice: z.union([z.string().max(120), extensionObjectSchema]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: extensionObjectSchema.optional(),
  chat_template_kwargs: extensionObjectSchema.optional(),
}).strict().refine(
  (value) => value.max_tokens === undefined || value.max_completion_tokens === undefined,
  { message: "Use either max_tokens or max_completion_tokens, not both." },
);

export type InferenceGatewayChatRequest = z.infer<typeof inferenceGatewayChatRequestSchema>;
