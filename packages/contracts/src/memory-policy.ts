import { z } from "zod";
import { agentMemoryModeSchema } from "./agents.js";

export const MEMORY_POLICY_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED"] as const;
export const memoryPolicyStatusSchema = z.enum(MEMORY_POLICY_STATUSES);

const policySlugSchema = z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * The installation-wide ceiling on what any agent may store.
 *
 * A profile chooses its own mode, but never exceeds this. Setting the ceiling
 * to RECALL_ONLY stops every agent capturing without editing a single profile,
 * which is what an operator needs when the answer to "stop storing things about
 * people" has to take effect now.
 */
export const memoryPolicySettingsSchema = z.object({
  maximumCaptureMode: agentMemoryModeSchema,
  /** Days a captured item survives. Null keeps it until someone deletes it. */
  retentionDays: z.number().int().min(1).max(3_650).nullable(),
  maximumItemsPerOwner: z.number().int().min(10).max(10_000),
  recallLimit: z.number().int().min(1).max(20),
  recallMinimumScore: z.number().min(0).max(1),
  /**
   * Document retrieval, governed here rather than hardcoded in the worker.
   *
   * These were constants (`limit: 18, minimumScore: 0.35`) while the memory
   * equivalents above were administrable — so an operator could tune what an
   * agent remembers but not what it retrieves. The floor matters: a question
   * phrased unlike the source text can score just over it, or just under, and
   * only the operator knows which documents their people actually ask about.
   */
  knowledgeRecallLimit: z.number().int().min(1).max(50),
  knowledgeMinimumScore: z.number().min(0).max(1),
  /**
   * Extract durable facts from a turn instead of storing the turn itself.
   *
   * Storing raw turns does not produce memory. On the pilot it produced 21 rows
   * of questions, greetings, and the model describing itself — content that
   * then scored highest on recall, because a new question resembles an old one.
   * With this on, a second model call is made after the answer is delivered and
   * only what it extracts is stored, which is usually nothing.
   */
  distillCapture: z.boolean(),
});

export const memoryPolicySchema = memoryPolicySettingsSchema.extend({
  id: z.uuid(),
  slug: policySlugSchema,
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(3).max(500),
  status: memoryPolicyStatusSchema,
  revision: z.number().int().positive(),
  firstActivatedAt: z.iso.datetime().nullable(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const memoryPolicyListSchema = z.object({ items: z.array(memoryPolicySchema) });

export const createMemoryPolicySchema = memoryPolicySettingsSchema.extend({
  slug: policySlugSchema,
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(3).max(500),
}).strict();

export const updateMemoryPolicySchema = memoryPolicySettingsSchema.partial().extend({
  displayName: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().min(3).max(500).optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export const changeMemoryPolicyStateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
}).strict();

/** One stored memory, as an administrator or its owner sees it. */
/**
 * How long a fact stays useful, which decides whether it is always present.
 *
 * STATIC and DYNAMIC facts are injected with every prompt without a search;
 * EPISODIC facts are only ever reached by similarity. The split exists because
 * semantic search cannot retrieve a fact that resembles no question — a
 * language preference has nothing in common, vector-wise, with "what should I
 * prepare for the event?", so it would never surface however the floor is tuned.
 */
export const MEMORY_PROFILE_SCOPES = ["STATIC", "DYNAMIC", "EPISODIC"] as const;
export const memoryProfileScopeSchema = z.enum(MEMORY_PROFILE_SCOPES);

export const agentMemoryRecordSchema = z.object({
  id: z.uuid(),
  ownerSubject: z.string().min(1).max(200),
  agentProfileId: z.uuid(),
  agentProfileSlug: z.string().min(1).max(64),
  content: z.string(),
  profileScope: memoryProfileScopeSchema,
  sourceRunId: z.uuid().nullable(),
  retentionUntil: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const agentMemoryRecordListSchema = z.object({
  items: z.array(agentMemoryRecordSchema),
});

export const agentMemoryQuerySchema = z.object({
  ownerSubject: z.string().trim().min(1).max(200).optional(),
  agentProfileId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const deleteAgentMemorySchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const purgeAgentMemorySchema = z.object({
  ownerSubject: z.string().trim().min(1).max(200),
  agentProfileId: z.uuid().optional(),
  reason: z.string().trim().min(3).max(500),
}).strict();

/**
 * "Forget everything about Project Titan", bounded.
 *
 * The target is natural language because that is the shape the request arrives
 * in; a person asks about a topic, not about row ids. Every field after it
 * exists to keep a semantic bulk delete safe to offer: `dryRun` shows the
 * decision before anything changes, and `maximumForget` stops a model that
 * decided everything matches from emptying the store.
 */
export const forgetMatchingAgentMemorySchema = z.object({
  ownerSubject: z.string().trim().min(1).max(200),
  agentProfileId: z.uuid().optional(),
  target: z.string().trim().min(2).max(300),
  reason: z.string().trim().min(3).max(300),
  /** Default true: the safe call is the one made by accident. */
  dryRun: z.boolean().default(true),
  maximumForget: z.number().int().min(1).max(200).default(25),
}).strict();

export const forgetMatchCandidateSchema = z.object({
  id: z.uuid(),
  content: z.string(),
  profileScope: memoryProfileScopeSchema,
  matched: z.boolean(),
});

export const forgetMatchingResultSchema = z.object({
  dryRun: z.boolean(),
  /** Null on a dry run: no batch exists until something is written. */
  forgetBatchId: z.uuid().nullable(),
  candidates: z.array(forgetMatchCandidateSchema),
  matched: z.number().int().min(0),
  forgotten: z.number().int().min(0),
  /** True when more of the owner's memory existed than one decision could read. */
  truncated: z.boolean(),
  /** Set when the cap stopped the operation short of every match. */
  capped: z.boolean(),
});

export type MemoryPolicyStatus = z.infer<typeof memoryPolicyStatusSchema>;
export type MemoryPolicySettings = z.infer<typeof memoryPolicySettingsSchema>;
export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;
export type MemoryPolicyList = z.infer<typeof memoryPolicyListSchema>;
export type CreateMemoryPolicy = z.infer<typeof createMemoryPolicySchema>;
export type UpdateMemoryPolicy = z.infer<typeof updateMemoryPolicySchema>;
export type ChangeMemoryPolicyState = z.infer<typeof changeMemoryPolicyStateSchema>;
export type MemoryProfileScope = z.infer<typeof memoryProfileScopeSchema>;
export type AgentMemoryRecord = z.infer<typeof agentMemoryRecordSchema>;
export type AgentMemoryRecordList = z.infer<typeof agentMemoryRecordListSchema>;
export type AgentMemoryQuery = z.infer<typeof agentMemoryQuerySchema>;
export type DeleteAgentMemory = z.infer<typeof deleteAgentMemorySchema>;
export type PurgeAgentMemory = z.infer<typeof purgeAgentMemorySchema>;
export type ForgetMatchingAgentMemory = z.infer<typeof forgetMatchingAgentMemorySchema>;
export type ForgetMatchCandidate = z.infer<typeof forgetMatchCandidateSchema>;
export type ForgetMatchingResult = z.infer<typeof forgetMatchingResultSchema>;

/**
 * The effective mode for a run: a profile can be narrower than the policy but
 * never wider. Ordering is by how much each mode stores, so "minimum" is the
 * safest of the two.
 */
const CAPTURE_RANK = { DOCUMENTS_ONLY: 0, RECALL_ONLY: 1, LEARN_USER: 2, LEARN_EXCHANGE: 3 } as const;

export function effectiveMemoryMode(
  profileMode: z.infer<typeof agentMemoryModeSchema>,
  policyCeiling: z.infer<typeof agentMemoryModeSchema> | null,
): z.infer<typeof agentMemoryModeSchema> {
  if (!policyCeiling) return profileMode;
  return CAPTURE_RANK[profileMode] <= CAPTURE_RANK[policyCeiling] ? profileMode : policyCeiling;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicySettings = {
  maximumCaptureMode: "LEARN_EXCHANGE",
  retentionDays: 365,
  maximumItemsPerOwner: 500,
  recallLimit: 6,
  recallMinimumScore: 0.4,
  // The values the worker used as constants, so behaviour is unchanged until
  // an administrator decides otherwise.
  knowledgeRecallLimit: 18,
  knowledgeMinimumScore: 0.35,
  // On by default: a profile only reaches capture by opting into a LEARN mode,
  // and the raw-turn behaviour it replaces is measurably not memory.
  distillCapture: true,
};
