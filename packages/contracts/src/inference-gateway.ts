import { z } from "zod";

const extensionObjectSchema = z.record(z.string(), z.unknown());

/**
 * One entry of a content-parts array — the form both OpenAI and OpenRouter
 * treat as canonical for anything beyond plain text. Text parts are fully
 * typed because the guardrail layer rewrites them; every other part kind
 * (image_url, input_audio, file, and whatever ships next) travels as a
 * bounded extension object the way tool definitions always have, with the
 * route's own bodyLimit as the real size ceiling.
 */
/*
 * 400k, matching the reasoning-trace bound below, and chosen from the policy
 * ceilings rather than invented: an operator may allow 128k characters of
 * typed input and 256k of output, and every one of those messages comes back
 * through this schema when Hermes replays the transcript. A cap below the
 * ceilings the policy itself grants would poison a conversation on echo with
 * a schema error the guardrail screen never mentioned.
 */
const textContentPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(400_000),
  cache_control: extensionObjectSchema.optional(),
}).strict();
const opaqueContentPartSchema = z.object({ type: z.string().min(1).max(40) })
  .catchall(z.unknown())
  .refine((part) => part.type !== "text", "Text parts must carry a bounded text field.");
export const inferenceGatewayContentPartSchema = z.union([textContentPartSchema, opaqueContentPartSchema]);

const messageContentSchema = z.union([
  z.string().max(400_000),
  z.null(),
  z.array(inferenceGatewayContentPartSchema).max(64),
]);

export const inferenceGatewayMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: messageContentSchema.optional(),
  name: z.string().min(1).max(120).optional(),
  tool_call_id: z.string().min(1).max(500).optional(),
  tool_calls: z.array(extensionObjectSchema).max(128).optional(),
  /*
   * What a reasoning model attaches to its assistant messages, accepted
   * because history round-trips: Hermes stores the assistant turn exactly as
   * the model returned it and echoes it in the next request, so the second
   * turn of every conversation against a reasoning model carried a field the
   * first turn's strict allowlist had never seen — and failed with a version-
   * skew message that pointed at the wrong cause. Accepted here, and STRIPPED
   * by the gateway route before forwarding: reasoning-model APIs reject their
   * own reasoning coming back, so tolerating it inbound and never sending it
   * upstream is the one behavior that works on both sides.
   */
  reasoning_content: z.union([z.string().max(400_000), z.null()]).optional(),
  /** The same trace under OpenRouter's field name. Same tolerance, same strip. */
  reasoning: z.union([z.string().max(400_000), z.null()]).optional(),
  /*
   * The rest of what a served assistant message can carry, accepted for the
   * same reason as the reasoning trace: Hermes echoes history exactly as the
   * model returned it, so anything a response can hold will eventually appear
   * in a request. `refusal`, `annotations`, `audio` and `images` are
   * server-generated and stripped before forwarding; `reasoning_details` is
   * OpenRouter's own round-trip contract — their docs ask clients to echo it
   * to preserve reasoning across turns — and no other upstream produces it,
   * so it is forwarded intact.
   */
  refusal: z.union([z.string().max(120_000), z.null()]).optional(),
  annotations: z.array(extensionObjectSchema).max(64).optional(),
  reasoning_details: z.array(extensionObjectSchema).max(64).optional(),
  audio: z.union([extensionObjectSchema, z.null()]).optional(),
  images: z.array(extensionObjectSchema).max(16).optional(),
}).strict();

export const inferenceGatewayChatRequestSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  /*
   * 1,000, not 200: an agentic session spends two or more messages per tool
   * call, and a long governed run against a generous maxTurns genuinely
   * approaches the old cap. The byte ceiling stays the route's bodyLimit.
   */
  messages: z.array(inferenceGatewayMessageSchema).min(1).max(1_000),
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
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  response_format: extensionObjectSchema.optional(),
  chat_template_kwargs: extensionObjectSchema.optional(),
  // The sampling surface both APIs accept beyond the OpenAI core. Bounded and
  // forwarded; a compact server that rejects one is handled by the gateway's
  // rejected-hint retry rather than by refusing every caller up front.
  top_k: z.number().int().min(0).max(2_048).optional(),
  min_p: z.number().min(0).max(1).optional(),
  top_a: z.number().min(0).max(1).optional(),
  repetition_penalty: z.number().min(0).max(4).optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  logit_bias: z.record(z.string().max(20), z.number().min(-100).max(100)).optional(),
  n: z.number().int().min(1).max(8).optional(),
  /** OpenRouter's structured replacement for reasoning_effort. */
  reasoning: z.object({
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    max_tokens: z.number().int().min(1).max(131_072).optional(),
    exclude: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }).strict().optional(),
  /** OpenRouter usage accounting; `include: true` is how cost reaches usage. */
  usage: z.object({ include: z.boolean() }).strict().optional(),
  /*
   * Deliberately refused, as policy rather than omission:
   *   - provider, models, route, plugins, transforms — routing belongs to the
   *     operator's pinned model route; accepting these would let a runtime
   *     fight the pin.
   *   - user, store, metadata, session_id, trace, service_tier — telemetry
   *     identity is the gateway's; it stamps its own `user` per connection.
   *   - modalities, audio, web_search_options, prediction — capabilities this
   *     product has not governed yet; admit them when a surface exists that
   *     audits what they do.
   */
}).strict().refine(
  (value) => value.max_tokens === undefined || value.max_completion_tokens === undefined,
  { message: "Use either max_tokens or max_completion_tokens, not both." },
);

export type InferenceGatewayChatRequest = z.infer<typeof inferenceGatewayChatRequestSchema>;
