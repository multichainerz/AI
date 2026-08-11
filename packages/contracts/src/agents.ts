import { z } from "zod";

export const AGENT_PROFILE_STATUSES = ["DRAFT", "STANDBY", "ACTIVE", "SUSPENDED"] as const;
export const AGENT_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "CANCEL_REQUESTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "DENIED",
] as const;
/**
 * The runtime events a governed Hermes run can produce.
 *
 * The control plane stores a bounded projection of Hermes-native session
 * events. Tool lifecycle and reported-reasoning events remain distinct so the
 * audit timeline does not mischaracterize progress as a new invocation.
 *
 * `REASONING_REPORTED` is named for what it is rather than for what a chat UI
 * would like it to be. Verified against upstream at the pinned commit: that
 * event's text is derived from the assistant's own visible output with
 * reasoning tags stripped and truncated — it is *not* the provider's reasoning
 * field, which reaches only Hermes' internal JSON-RPC gateway. Calling it
 * `THINKING` would licence a UI that replays the answer back at the reader and
 * captions it as the model's private thought.
 *
 * Stored in a `varchar(80)`, not a database enum, so widening this list needs
 * no migration — and readers must tolerate a value they do not recognise,
 * because an older dashboard can meet a newer worker.
 */
export const AGENT_RUN_EVENT_TYPES = [
  "RUN_STARTED",
  "MESSAGE_DELTA",
  "TOOL_STARTED",
  "TOOL_PROGRESS",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "REASONING_REPORTED",
  "SUBAGENT_STARTED",
  "SUBAGENT_COMPLETED",
  "APPROVAL_REQUIRED",
  /*
   * Reported by Hermes, and only ever advisory.
   *
   * Hermes announces its own view of a run ending, but it says so on its event
   * stream while OrcaSynapse has not finalised anything yet: the message row is
   * still PENDING and the answer is not stored. These are timeline entries, not
   * the end of a turn -- see RUN_ENDED below for the difference.
   */
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_CANCELLED",
  /*
   * The marker, written by whoever finalises the run, inside the same
   * transaction that flips `AgentRun.status`.
   *
   * A subscriber ends its stream on this and on nothing else. That is what
   * makes "the run ended" a fact in the log rather than something a reader has
   * to learn from a second query it cannot order against the first -- and
   * everything before the marker is, by construction, already delivered.
   *
   * It is deliberately one name rather than one per outcome, and deliberately
   * a name Hermes has no mapping for: `AGENT_RUN_EVENT_TYPES` has to hold both
   * what the runtime reports and what the control plane concludes, and a marker
   * a runtime can also emit is a marker that ends turns early. Which outcome it
   * was lives in the row's `status`.
   */
  "RUN_ENDED",
] as const;

/**
 * The one event type that ends a subscriber's stream.
 *
 * Guarded by a test asserting no Hermes event name maps to it. If that ever
 * becomes false, a runtime could end a turn before the answer is stored.
 */
export const AGENT_RUN_ENDED_EVENT_TYPE = "RUN_ENDED";

/** Whether `type` is the marker, and so ends a subscriber's stream. */
export function isAgentRunEndedEventType(type: string): boolean {
  return type === AGENT_RUN_ENDED_EVENT_TYPE;
}
export const AGENT_RUN_APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "CANCELLED",
] as const;

export const agentProfileStatusSchema = z.enum(AGENT_PROFILE_STATUSES);
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export const agentRunEventTypeSchema = z.enum(AGENT_RUN_EVENT_TYPES);
export const agentRunApprovalStatusSchema = z.enum(AGENT_RUN_APPROVAL_STATUSES);

const agentSlugSchema = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const agentModelAliasSchema = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/);

export const agentSkillReferenceSchema = z.object({
  name: agentSlugSchema,
  version: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  digest: sha256Schema,
}).strict();

export const agentVersionConfigurationSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  purpose: z.string().trim().min(3).max(500),
  instructions: z.string().trim().min(10).max(32_000),
  soulMd: z.string().trim().min(10).max(32_000),
  skills: z.array(agentSkillReferenceSchema).max(20),
  modelAlias: agentModelAliasSchema,
  // A boundary OrcaSynapse declares about its own profiles, not one it imposes
  // on the runtime: the run submission carries no turn field and Hermes exposes
  // no turn control, so this refuses profiles that ask for more rather than
  // limiting what the runtime does. What actually keeps a run single-step is
  // that no toolset is admitted (`RuntimeToolsetAdmission`).
  maxTurns: z.literal(1),
  timeoutSeconds: z.number().int().min(30).max(3_600),
  maxConcurrentRuns: z.number().int().min(1).max(20),
  safeMode: z.literal(true),
}).strict();

export const createAgentProfileSchema = agentVersionConfigurationSchema.extend({
  slug: agentSlugSchema,
});

export const updateAgentProfileSchema = agentVersionConfigurationSchema.partial().strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one agent configuration field must be provided.",
  });

export const agentProfileVersionSchema = agentVersionConfigurationSchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  createdBy: z.uuid().nullable(),
  distributionDigest: sha256Schema,
});

export const agentProfileSchema = z.object({
  id: z.uuid(),
  slug: agentSlugSchema,
  status: agentProfileStatusSchema,
  currentVersion: z.number().int().positive(),
  activeVersion: z.number().int().positive().nullable(),
  // Administrators edit the latest immutable revision while runs always use
  // the explicitly activated revision. Keeping both prevents the console from
  // presenting an unactivated draft as the live runtime configuration.
  activeVersionConfiguration: agentProfileVersionSchema.nullable(),
  version: agentProfileVersionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentProfileListSchema = z.object({ items: z.array(agentProfileSchema) });

export const submitAgentRunSchema = z.object({
  profileId: z.uuid(),
  input: z.string().trim().min(1).max(32_000),
}).strict();

export const agentRunSchema = z.object({
  id: z.uuid(),
  profileId: z.uuid(),
  profileSlug: agentSlugSchema,
  profileName: z.string().min(1).max(120),
  profileVersion: z.number().int().positive(),
  profileDistributionDigest: sha256Schema.nullable(),
  status: agentRunStatusSchema,
  input: z.string().max(32_000),
  output: z.string().nullable(),
  partialOutput: z.string(),
  modelAlias: z.string().max(200).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  finishReason: z.string().max(120).nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentRunListSchema = z.object({ items: z.array(agentRunSchema) });

export const agentRunEventSchema = z.object({
  id: z.uuid(),
  cursor: z.string().regex(/^\d+$/),
  runId: z.uuid(),
  type: agentRunEventTypeSchema,
  delta: z.string().nullable(),
  preview: z.string().max(1000).nullable(),
  errorCode: z.string().max(80).nullable(),
  approvalId: z.uuid().nullable(),
  summary: z.string().max(1000).nullable(),
  status: z.string().max(80).nullable(),
  toolName: z.string().max(160).nullable(),
  /*
   * The three fields that make a run legible, matching `chat.ts`.
   *
   * They were added to the event log in ai-v1.93.0 and only ever reached the
   * chat contract, so two schemas described one table differently and the run
   * detail screen could not group a tool call's events the way chat does --
   * every reader of this table needs the same vocabulary or the grouping has to
   * be reinvented per surface.
   */
  toolCallKey: z.string().max(200).nullable(),
  text: z.string().nullable(),
  contentOffset: z.number().int().nonnegative().nullable(),
  childSessionId: z.string().max(255).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  occurredAt: z.iso.datetime(),
});

export const agentRunEventListSchema = z.object({ items: z.array(agentRunEventSchema).max(500) });

export const agentRunApprovalSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  status: agentRunApprovalStatusSchema,
  command: z.string().max(1000).nullable(),
  summary: z.string().max(1000).nullable(),
  choices: z.array(z.enum(["ALLOW_ONCE", "DENY"])).max(2),
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  decision: z.enum(["ALLOW_ONCE", "DENY"]).nullable(),
});

export const decideAgentRunApprovalSchema = z.object({
  decision: z.enum(["ALLOW_ONCE", "DENY"]),
}).strict();

export const agentRuntimeControlSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.uuid().nullable(),
});

export const updateAgentRuntimeControlSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const agentMetricsSchema = z.object({
  generatedAt: z.iso.datetime(),
  profiles: z.number().int().nonnegative(),
  activeProfiles: z.number().int().nonnegative(),
  queuedRuns: z.number().int().nonnegative(),
  runningRuns: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
});

export const agentRunJobPayloadSchema = z.object({ runId: z.uuid() }).strict();

export type AgentProfileStatus = z.infer<typeof agentProfileStatusSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentRunEventType = z.infer<typeof agentRunEventTypeSchema>;
export type AgentRunApprovalStatus = z.infer<typeof agentRunApprovalStatusSchema>;
export type AgentVersionConfiguration = z.infer<typeof agentVersionConfigurationSchema>;
export type AgentSkillReference = z.infer<typeof agentSkillReferenceSchema>;
export type CreateAgentProfile = z.infer<typeof createAgentProfileSchema>;

/**
 * The profile every OrcaSynapse deployment starts with.
 *
 * A fresh install had no profile at all, so Chat opened on "Setup required" and
 * a Create Agent Profile button: the product's central screen was unusable
 * until an operator wrote a system prompt from a blank box. This is that prompt,
 * written once and well.
 *
 * It is deliberately a capable but bounded general assistant. Hermes owns the
 * native transcript and its MEMORY.md / USER.md lifecycle; OrcaSynapse owns
 * policy, orchestration, and the sanitized operational ledger.
 */
export const DEFAULT_AGENT_PROFILE: CreateAgentProfile = {
  slug: "hermes-enterprise",
  displayName: "Hermes Enterprise Assistant",
  purpose:
    "Helps operators reason, plan, and act through a private Hermes session with explicit limits and honest uncertainty.",
  instructions: [
    "You are an enterprise assistant running inside a private, on-premise OrcaSynapse deployment. Nothing you receive or produce leaves this environment.",
    "",
    "ACCURACY",
    "- Answer from the current Hermes session and information you genuinely know. Never invent a quotation, figure, date, policy, or person.",
    "- State uncertainty plainly. Separate observed facts, remembered context, assumptions, and inference.",
    "- Use Hermes native memory only when it helps continuity. Never claim that memory is private to one session: MEMORY.md and USER.md belong to the active Hermes profile.",
    "",
    "DECISIONS AND ADVICE",
    "- You support decisions; you do not make them. For legal, financial, regulatory, employment, or safety consequences, refer the decision to the responsible human or team.",
    "- Do not present yourself as a lawyer, accountant, auditor or clinician, and do not give advice that only they should give.",
    "",
    "FORM",
    "- Lead with the answer, then the support for it. An operator reading only the first two lines should already have the point.",
    "- Be concise and specific. Prefer concrete figures, names and dates over general description.",
    "- Use a short list when enumerating, a table when comparing across the same dimensions, and prose otherwise. Do not impose structure on a one-sentence answer.",
    "- Match the language of the question.",
    "",
    "LIMITS",
    "- If a request falls outside what this deployment permits, say so directly and explain what you can do instead. Do not speculate about how a restriction might be worked around.",
    "- If a question is ambiguous in a way that changes the answer, state the reading you adopted and answer under it.",
  ].join("\n"),
  soulMd: [
    "You are calm, precise and unhurried.",
    "",
    "You are candid about the edge of what you know, because in a governed environment a confident wrong answer costs more than an honest gap. You are specific where the evidence is specific and clear about where it runs out.",
    "",
    "You write like a well-briefed colleague: direct, free of filler and flattery, and respectful of the reader's time and expertise.",
  ].join("\n"),
  skills: [],
  modelAlias: "hermes-agent",
  maxTurns: 1,
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  safeMode: true,
};
export type UpdateAgentProfile = z.infer<typeof updateAgentProfileSchema>;
export type AgentProfileVersion = z.infer<typeof agentProfileVersionSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProfileList = z.infer<typeof agentProfileListSchema>;
export type SubmitAgentRun = z.infer<typeof submitAgentRunSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type AgentRunList = z.infer<typeof agentRunListSchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
export type AgentRunEventList = z.infer<typeof agentRunEventListSchema>;
export type AgentRunApproval = z.infer<typeof agentRunApprovalSchema>;
export type DecideAgentRunApproval = z.infer<typeof decideAgentRunApprovalSchema>;
export type AgentRuntimeControl = z.infer<typeof agentRuntimeControlSchema>;
export type UpdateAgentRuntimeControl = z.infer<typeof updateAgentRuntimeControlSchema>;
export type AgentMetrics = z.infer<typeof agentMetricsSchema>;
export type AgentRunJobPayload = z.infer<typeof agentRunJobPayloadSchema>;

/**
 * What the enrolled Hermes runtime can do, as it reports itself.
 *
 * Discovery only. Reading this never enables anything: the managed runtime
 * policy decides what is on, and `enabledToolsets` exists so an operator can
 * see that boundary rather than infer it from an empty screen.
 */
export const hermesToolsetSchema = z.object({
  name: z.string().min(1).max(120),
  label: z.string().max(200).nullable(),
  enabled: z.boolean(),
  toolCount: z.number().int().nonnegative(),
});

export const hermesSkillSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(600).nullable(),
  category: z.string().max(120).nullable(),
});

export const hermesRuntimeCatalogueSchema = z.object({
  toolsets: z.array(hermesToolsetSchema),
  skills: z.array(hermesSkillSchema),
  enabledToolsets: z.number().int().nonnegative(),
});

export type HermesToolset = z.infer<typeof hermesToolsetSchema>;
export type HermesSkill = z.infer<typeof hermesSkillSchema>;
export type HermesRuntimeCatalogue = z.infer<typeof hermesRuntimeCatalogueSchema>;
