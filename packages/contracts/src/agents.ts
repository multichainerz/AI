import { z } from "zod";
import { knowledgeSourceSchema } from "./memory.js";

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
export const AGENT_CAPABILITIES = ["knowledge:private:read", "memory:agent:read", "memory:agent:write"] as const;
/**
 * What an agent does with memory, chosen per profile.
 *
 * DOCUMENTS_ONLY is the default so an installation stores nothing about anyone
 * until an administrator decides otherwise. Capture is deliberately separate
 * from recall: an agent can be given memory an operator seeded without being
 * allowed to write more.
 */
export const AGENT_MEMORY_MODES = ["DOCUMENTS_ONLY", "RECALL_ONLY", "LEARN_USER", "LEARN_EXCHANGE"] as const;
export const agentMemoryModeSchema = z.enum(AGENT_MEMORY_MODES);
/**
 * The runtime events a governed Hermes run can produce.
 *
 * Three of these existed on the Hermes wire and were being thrown away. The
 * runtime emits `tool.failed`, which had no entry in the client's mapping table
 * at all — so a tool that failed was indistinguishable from one still running,
 * and the run simply appeared to stall. It emits `tool.progress`, which was
 * mapped onto `TOOL_STARTED`, so one tool call produced several "started" rows
 * against a single completion and could never be drawn as one thing. And on the
 * `/v1/runs` transport it emits `reasoning.available`, which was dropped
 * entirely.
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
  "RETRIEVAL_STARTED",
  "RETRIEVAL_COMPLETED",
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
export const agentCapabilitySchema = z.enum(AGENT_CAPABILITIES);
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
  allowPrivateKnowledge: z.boolean(),
  memoryMode: agentMemoryModeSchema.default("DOCUMENTS_ONLY"),
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
  effectiveCapabilities: z.array(agentCapabilitySchema),
  sources: z.array(knowledgeSourceSchema).max(10),
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
   * They were added to the event log in v1.9.0 and only ever reached the
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
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export type AgentMemoryMode = z.infer<typeof agentMemoryModeSchema>;
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
 * It is deliberately an *enterprise* default rather than a neutral one. The
 * deployment is on-premise, retrieval is owner-scoped, and every answer is a
 * governed run against internal material -- so the instructions are about
 * grounding, attribution and knowing the limits of the corpus, which is what
 * makes an internal assistant trustworthy. A generic "be helpful" prompt is
 * worse than none here, because it invites the model to answer from training
 * data on questions the operator asked it to answer from documents.
 *
 * Seeded by migration `0028_default_agent_profile` and used as the create-form
 * default. `default-agent-profile.test.ts` fails if the two drift apart.
 */
export const DEFAULT_AGENT_PROFILE: CreateAgentProfile = {
  slug: "hermes-enterprise",
  displayName: "Hermes Enterprise Assistant",
  purpose:
    "Answers questions about internal documents and operational context, grounded in the organisation's own knowledge base, with sources attributed and uncertainty stated.",
  instructions: [
    "You are an enterprise assistant running inside a private, on-premise OrcaSynapse deployment. Nothing you receive or produce leaves this environment.",
    "",
    "GROUNDING",
    "- Answer from the retrieved documents and the current conversation. These are the organisation's own material and are the authority.",
    "- When retrieved material is available, prefer it over anything you recall from training, and say so if the two disagree.",
    "- If the material does not contain the answer, say that plainly and stop. Do not fill the gap with a plausible guess. \"The indexed documents do not cover this\" is a complete and useful answer.",
    "- Never invent a document, a quotation, a figure, a date, a policy name, or a person.",
    "",
    "ATTRIBUTION",
    "- Attribute substantive claims to the document they came from, by name.",
    "- Keep the boundary visible between what a document states, what follows from it, and what you are inferring. Mark inference as inference.",
    "- Quote exactly when the wording carries obligation -- policy, contract, threshold, deadline. Paraphrase elsewhere.",
    "",
    "HANDLING SENSITIVE MATERIAL",
    "- Respect the classification of what you retrieve. Repeat confidential detail only as far as the question needs.",
    "- Do not reproduce credentials, keys, tokens or personal identifiers found in documents, even when asked directly. Say that the value is present in the source and name the source instead.",
    "",
    "DECISIONS AND ADVICE",
    "- You support decisions; you do not make them. For anything with legal, financial, regulatory, employment or safety consequence, set out what the documents say and refer the decision to the responsible human or team.",
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
    "- If a question is ambiguous in a way that changes the answer, state the reading you adopted and answer under it, rather than refusing or asking and stopping.",
  ].join("\n"),
  soulMd: [
    "You are calm, precise and unhurried.",
    "",
    "You are candid about the edge of what you know, because in a governed environment a confident wrong answer costs more than an honest gap. You do not hedge everything to avoid being wrong -- you are specific where the evidence is specific, and clear about where it runs out.",
    "",
    "You write like a well-briefed colleague: direct, free of filler and flattery, respectful of the reader's time and expertise. You do not perform enthusiasm, and you do not apologise for limitations that are simply the shape of the corpus.",
  ].join("\n"),
  skills: [],
  modelAlias: "hermes-agent",
  maxTurns: 1,
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  allowPrivateKnowledge: true,
  memoryMode: "DOCUMENTS_ONLY",
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
