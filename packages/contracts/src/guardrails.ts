import { z } from "zod";

export const GUARDRAIL_POLICY_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED"] as const;
export const guardrailPolicyStatusSchema = z.enum(GUARDRAIL_POLICY_STATUSES);
export const guardrailPolicyIdentifierSchema = z.uuid();

const policySlugSchema = z.string().trim().min(2).max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const guardrailPolicySchema = z.object({
  id: z.uuid(),
  slug: policySlugSchema,
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(3).max(500),
  version: z.string().trim().min(1).max(120),
  status: guardrailPolicyStatusSchema,
  maxInputCharacters: z.number().int().min(256).max(32_000),
  maxOutputCharacters: z.number().int().min(1_024).max(1_000_000),
  blockControlCharacters: z.boolean(),
  blockCredentialPatterns: z.boolean(),
  firstActivatedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine(({ status, firstActivatedAt }, context) => {
  if (status === "ACTIVE" && !firstActivatedAt) {
    context.addIssue({ code: "custom", path: ["firstActivatedAt"], message: "Active policies require an activation timestamp." });
  }
});

export const guardrailPolicyListSchema = z.object({ items: z.array(guardrailPolicySchema) });

export const createGuardrailPolicySchema = z.object({
  slug: policySlugSchema,
  displayName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(3).max(500),
  version: z.string().trim().min(1).max(120),
  maxInputCharacters: z.number().int().min(256).max(32_000),
  maxOutputCharacters: z.number().int().min(1_024).max(1_000_000),
  blockControlCharacters: z.boolean(),
  blockCredentialPatterns: z.boolean(),
}).strict();

export const updateGuardrailPolicySchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().min(3).max(500).optional(),
  version: z.string().trim().min(1).max(120).optional(),
  maxInputCharacters: z.number().int().min(256).max(32_000).optional(),
  maxOutputCharacters: z.number().int().min(1_024).max(1_000_000).optional(),
  blockControlCharacters: z.boolean().optional(),
  blockCredentialPatterns: z.boolean().optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export const changeGuardrailPolicyStateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export type GuardrailPolicyStatus = z.infer<typeof guardrailPolicyStatusSchema>;
export type GuardrailPolicy = z.infer<typeof guardrailPolicySchema>;
export type GuardrailPolicyList = z.infer<typeof guardrailPolicyListSchema>;
export type CreateGuardrailPolicy = z.infer<typeof createGuardrailPolicySchema>;
export type UpdateGuardrailPolicy = z.infer<typeof updateGuardrailPolicySchema>;
export type ChangeGuardrailPolicyState = z.infer<typeof changeGuardrailPolicyStateSchema>;
