import { z } from "zod";
import { connectionStatusSchema, environmentSchema, serviceKindSchema } from "./connections.js";

export const MODEL_WORKLOADS = ["CHAT", "AGENT"] as const;
export const MODEL_DEPLOYMENT_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED"] as const;
export const MODEL_INPUT_MODALITIES = ["text", "image", "audio", "file"] as const;

export const modelWorkloadSchema = z.enum(MODEL_WORKLOADS);
export const modelDeploymentStatusSchema = z.enum(MODEL_DEPLOYMENT_STATUSES);
export const modelInputModalitySchema = z.enum(MODEL_INPUT_MODALITIES);
export const modelDeploymentIdentifierSchema = z.uuid();

const modelSlugSchema = z.string().trim().min(2).max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const modelAliasSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

const modelLimitsSchema = z.object({
  contextWindowTokens: z.number().int().min(1_024).max(4_194_304),
  maxOutputTokens: z.number().int().min(64).max(131_072),
  maxConcurrentRequests: z.number().int().min(1).max(1_024),
}).refine(({ contextWindowTokens, maxOutputTokens }) => maxOutputTokens <= contextWindowTokens, {
  message: "Maximum output tokens cannot exceed the context window.",
  path: ["maxOutputTokens"],
});

export const modelConnectionSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1).max(120),
  kind: serviceKindSchema,
  environment: environmentSchema,
  enabled: z.boolean(),
  status: connectionStatusSchema,
});

export const modelDeploymentSchema = z.object({
  id: z.uuid(),
  slug: modelSlugSchema,
  displayName: z.string().trim().min(2).max(120),
  modelAlias: modelAliasSchema,
  workload: modelWorkloadSchema,
  status: modelDeploymentStatusSchema,
  connection: modelConnectionSummarySchema,
  version: z.string().trim().min(1).max(120),
  license: z.string().trim().min(1).max(160).nullable(),
  contextWindowTokens: z.number().int().min(1_024).max(4_194_304),
  maxOutputTokens: z.number().int().min(64).max(131_072),
  maxConcurrentRequests: z.number().int().min(1).max(1_024),
  isDefault: z.boolean(),
  firstActivatedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  observedContextWindowTokens: z.number().int().positive().nullable().default(null),
  observedMaxOutputTokens: z.number().int().positive().nullable().default(null),
  inputModalities: z.array(modelInputModalitySchema).default([]),
  missingFromUpstream: z.boolean().default(false),
  lastSeenAt: z.iso.datetime().nullable().default(null),
}).superRefine(({ status, isDefault, firstActivatedAt }, context) => {
  if (status === "ACTIVE" && !firstActivatedAt) {
    context.addIssue({ code: "custom", path: ["firstActivatedAt"], message: "Active model routes require an activation timestamp." });
  }
  if (isDefault && status !== "ACTIVE") {
    context.addIssue({ code: "custom", path: ["isDefault"], message: "Only an active model route can be the workload default." });
  }
});

export const modelDeploymentListSchema = z.object({ items: z.array(modelDeploymentSchema) });

export const createModelDeploymentSchema = z.object({
  slug: modelSlugSchema,
  displayName: z.string().trim().min(2).max(120),
  modelAlias: modelAliasSchema,
  workload: modelWorkloadSchema,
  connectionId: z.uuid(),
  version: z.string().trim().min(1).max(120),
  license: z.string().trim().min(1).max(160).nullable().default(null),
  contextWindowTokens: modelLimitsSchema.shape.contextWindowTokens,
  maxOutputTokens: modelLimitsSchema.shape.maxOutputTokens,
  maxConcurrentRequests: modelLimitsSchema.shape.maxConcurrentRequests,
}).strict().superRefine((input, context) => {
  if (input.maxOutputTokens > input.contextWindowTokens) {
    context.addIssue({ code: "custom", path: ["maxOutputTokens"], message: "Maximum output tokens cannot exceed the context window." });
  }
});

export const updateModelDeploymentSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  modelAlias: modelAliasSchema.optional(),
  connectionId: z.uuid().optional(),
  version: z.string().trim().min(1).max(120).optional(),
  license: z.string().trim().min(1).max(160).nullable().optional(),
  contextWindowTokens: modelLimitsSchema.shape.contextWindowTokens.optional(),
  maxOutputTokens: modelLimitsSchema.shape.maxOutputTokens.optional(),
  maxConcurrentRequests: modelLimitsSchema.shape.maxConcurrentRequests.optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export const changeModelDeploymentStateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
  makeDefault: z.boolean().default(false),
}).strict();

export const modelObservationSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  alias: modelAliasSchema,
  displayName: z.string().trim().min(1).max(300).nullable(),
  observedContextWindowTokens: z.number().int().positive().nullable(),
  observedMaxOutputTokens: z.number().int().positive().nullable(),
  inputModalities: z.array(modelInputModalitySchema),
  ownedBy: z.string().trim().min(1).max(200).nullable(),
  lastSeenAt: z.iso.datetime(),
  missingFromUpstream: z.boolean(),
  admittedWorkloads: z.array(modelWorkloadSchema),
});

export const modelObservationListSchema = z.object({
  connectionId: z.uuid(),
  refreshedAt: z.iso.datetime().nullable(),
  items: z.array(modelObservationSchema),
});

export const modelRefreshResultSchema = z.object({
  connectionId: z.uuid(),
  refreshedAt: z.iso.datetime(),
  upserted: z.number().int().nonnegative(),
  vanished: z.number().int().nonnegative(),
  items: z.array(modelObservationSchema),
  backfill: modelDeploymentSchema.nullable(),
});

export type ModelWorkload = z.infer<typeof modelWorkloadSchema>;
export type ModelDeploymentStatus = z.infer<typeof modelDeploymentStatusSchema>;
export type ModelInputModality = z.infer<typeof modelInputModalitySchema>;
export type ModelDeployment = z.infer<typeof modelDeploymentSchema>;
export type ModelDeploymentList = z.infer<typeof modelDeploymentListSchema>;
export type CreateModelDeployment = z.infer<typeof createModelDeploymentSchema>;
export type UpdateModelDeployment = z.infer<typeof updateModelDeploymentSchema>;
export type ChangeModelDeploymentState = z.infer<typeof changeModelDeploymentStateSchema>;
export type ModelObservation = z.infer<typeof modelObservationSchema>;
export type ModelObservationList = z.infer<typeof modelObservationListSchema>;
export type ModelRefreshResult = z.infer<typeof modelRefreshResultSchema>;
