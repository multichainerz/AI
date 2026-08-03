import { z } from "zod";

export const PROMPT_PURPOSES = ["CHAT_SYSTEM"] as const;
export const PROMPT_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED"] as const;

export const promptPurposeSchema = z.enum(PROMPT_PURPOSES);
export const promptStatusSchema = z.enum(PROMPT_STATUSES);
export const promptIdentifierSchema = z.uuid();

const promptSlugSchema = z.string().trim().min(2).max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const promptVersionSchema = z.string().trim().min(1).max(120);
const promptContentSchema = z.string().trim().min(20).max(20_000)
  .refine((value) => !value.includes("\0"), "Prompt content cannot contain null characters.");

export const promptTemplateSchema = z.object({
  id: z.uuid(),
  slug: promptSlugSchema,
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(3).max(500),
  purpose: promptPurposeSchema,
  version: promptVersionSchema,
  status: promptStatusSchema,
  content: promptContentSchema,
  contentChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  activationEvaluationId: z.uuid().nullable(),
  firstActivatedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine(({ status, activationEvaluationId, firstActivatedAt }, context) => {
  if (status === "ACTIVE" && !activationEvaluationId) {
    context.addIssue({ code: "custom", path: ["activationEvaluationId"], message: "Active prompts require promoted evaluation evidence." });
  }
  if (status === "ACTIVE" && !firstActivatedAt) {
    context.addIssue({ code: "custom", path: ["firstActivatedAt"], message: "Active prompts require an activation timestamp." });
  }
});

export const promptTemplateListSchema = z.object({ items: z.array(promptTemplateSchema) });

export const createPromptTemplateSchema = z.object({
  slug: promptSlugSchema,
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(3).max(500),
  purpose: promptPurposeSchema,
  version: promptVersionSchema,
  content: promptContentSchema,
}).strict();

export const updatePromptTemplateSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().min(3).max(500).optional(),
  version: promptVersionSchema.optional(),
  content: promptContentSchema.optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export const changePromptTemplateStateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export type PromptPurpose = z.infer<typeof promptPurposeSchema>;
export type PromptStatus = z.infer<typeof promptStatusSchema>;
export type PromptTemplate = z.infer<typeof promptTemplateSchema>;
export type PromptTemplateList = z.infer<typeof promptTemplateListSchema>;
export type CreatePromptTemplate = z.infer<typeof createPromptTemplateSchema>;
export type UpdatePromptTemplate = z.infer<typeof updatePromptTemplateSchema>;
export type ChangePromptTemplateState = z.infer<typeof changePromptTemplateStateSchema>;
