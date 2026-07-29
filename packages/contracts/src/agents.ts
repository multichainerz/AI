import { z } from "zod";
import { knowledgeSourceSchema } from "./memory.js";

export const AGENT_PROFILE_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED"] as const;
export const AGENT_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "CANCEL_REQUESTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "DENIED",
] as const;
export const AGENT_CAPABILITIES = ["knowledge:private:read"] as const;

export const agentProfileStatusSchema = z.enum(AGENT_PROFILE_STATUSES);
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export const agentCapabilitySchema = z.enum(AGENT_CAPABILITIES);

const agentSlugSchema = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const agentModelAliasSchema = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const agentVersionConfigurationSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  purpose: z.string().trim().min(3).max(500),
  instructions: z.string().trim().min(10).max(32_000),
  modelAlias: agentModelAliasSchema,
  // Phase 5 deliberately exposes no Hermes-native tools, so every run is a
  // single model turn. Multi-turn tool loops arrive with governed tooling.
  maxTurns: z.literal(1),
  timeoutSeconds: z.number().int().min(30).max(3_600),
  maxConcurrentRuns: z.number().int().min(1).max(20),
  allowPrivateKnowledge: z.boolean(),
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
  status: agentRunStatusSchema,
  input: z.string().max(32_000),
  output: z.string().nullable(),
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
export type AgentVersionConfiguration = z.infer<typeof agentVersionConfigurationSchema>;
export type CreateAgentProfile = z.infer<typeof createAgentProfileSchema>;
export type UpdateAgentProfile = z.infer<typeof updateAgentProfileSchema>;
export type AgentProfileVersion = z.infer<typeof agentProfileVersionSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProfileList = z.infer<typeof agentProfileListSchema>;
export type SubmitAgentRun = z.infer<typeof submitAgentRunSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type AgentRunList = z.infer<typeof agentRunListSchema>;
export type AgentRuntimeControl = z.infer<typeof agentRuntimeControlSchema>;
export type UpdateAgentRuntimeControl = z.infer<typeof updateAgentRuntimeControlSchema>;
export type AgentMetrics = z.infer<typeof agentMetricsSchema>;
export type AgentRunJobPayload = z.infer<typeof agentRunJobPayloadSchema>;
