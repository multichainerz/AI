import { z } from "zod";
import { adminRoleSchema } from "./admin.js";

export const TOOL_RISKS = ["READ_ONLY", "CONSEQUENTIAL"] as const;
export const TOOL_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export const TOOL_CALL_STATUSES = [
  "REQUESTED",
  "APPROVAL_PENDING",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "DENIED",
  "CANCELLED",
] as const;
export const TOOL_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"] as const;
export const TOOL_RESOURCE_SCOPES = ["OWNER_ONLY"] as const;

export const toolRiskSchema = z.enum(TOOL_RISKS);
export const toolStatusSchema = z.enum(TOOL_STATUSES);
export const toolCallStatusSchema = z.enum(TOOL_CALL_STATUSES);
export const toolApprovalStatusSchema = z.enum(TOOL_APPROVAL_STATUSES);
export const toolResourceScopeSchema = z.enum(TOOL_RESOURCE_SCOPES);
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const governedToolSchema = z.object({
  id: z.uuid(),
  slug: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
  displayName: z.string().min(2).max(120),
  description: z.string().min(3).max(1_000),
  risk: toolRiskSchema,
  status: toolStatusSchema,
  handlerKey: z.string().min(2).max(120),
  inputSchema: jsonObjectSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const governedToolListSchema = z.object({ items: z.array(governedToolSchema) });
export const updateToolStatusSchema = z.object({ status: toolStatusSchema }).strict();

export const toolGrantSchema = z.object({
  id: z.uuid(),
  profileId: z.uuid(),
  profileSlug: z.string().min(2).max(64),
  profileVersionId: z.uuid(),
  profileVersion: z.number().int().positive(),
  toolId: z.uuid(),
  toolSlug: z.string().min(3).max(80),
  toolName: z.string().min(2).max(120),
  enabled: z.boolean(),
  allowedGroups: z.array(z.string().trim().min(1).max(200)).max(50),
  allowedAdminRoles: z.array(adminRoleSchema).max(4),
  resourceScope: toolResourceScopeSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const toolGrantListSchema = z.object({ items: z.array(toolGrantSchema) });

export const upsertToolGrantSchema = z.object({
  profileVersionId: z.uuid(),
  toolId: z.uuid(),
  enabled: z.boolean().default(true),
  allowedGroups: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  allowedAdminRoles: z.array(adminRoleSchema).max(4).default([]),
  resourceScope: z.literal("OWNER_ONLY"),
}).strict().refine((value) => value.allowedGroups.length > 0 || value.allowedAdminRoles.length > 0, {
  message: "At least one exact enterprise group or administrator role is required.",
});

export const gatewayCredentialSchema = z.object({
  id: z.uuid(),
  name: z.string().min(2).max(120),
  tokenPrefix: z.string().min(8).max(32),
  enabled: z.boolean(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const gatewayCredentialListSchema = z.object({ items: z.array(gatewayCredentialSchema) });
export const issueGatewayCredentialSchema = z.object({ name: z.string().trim().min(2).max(120) }).strict();
export const issuedGatewayCredentialSchema = gatewayCredentialSchema.extend({
  token: z.string().regex(/^aihub_mcp_[A-Za-z0-9_-]{43}$/),
});

export const toolCallSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  profileSlug: z.string().min(2).max(64),
  profileVersion: z.number().int().positive(),
  toolSlug: z.string().min(3).max(80),
  toolName: z.string().min(2).max(120),
  risk: toolRiskSchema,
  status: toolCallStatusSchema,
  requestId: z.uuid(),
  arguments: jsonObjectSchema,
  result: jsonObjectSchema.nullable(),
  errorCode: z.string().max(80).nullable(),
  errorMessage: z.string().max(500).nullable(),
  requestedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const toolCallListSchema = z.object({ items: z.array(toolCallSchema) });

export const toolApprovalSchema = z.object({
  id: z.uuid(),
  callId: z.uuid(),
  runId: z.uuid(),
  profileSlug: z.string().min(2).max(64),
  toolSlug: z.string().min(3).max(80),
  toolName: z.string().min(2).max(120),
  requestedBySubject: z.string().min(1).max(200),
  arguments: jsonObjectSchema,
  status: toolApprovalStatusSchema,
  expiresAt: z.iso.datetime(),
  decisionReason: z.string().max(1_000).nullable(),
  decisionBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const toolApprovalListSchema = z.object({ items: z.array(toolApprovalSchema) });
export const decideToolApprovalSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(3).max(1_000),
}).strict();

export const toolRuntimeControlSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  approvalTtlMinutes: z.number().int().min(5).max(1_440),
  updatedAt: z.iso.datetime(),
  updatedBy: z.uuid().nullable(),
});

export const updateToolRuntimeControlSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(500),
  approvalTtlMinutes: z.number().int().min(5).max(1_440),
}).strict();

export const toolMetricsSchema = z.object({
  generatedAt: z.iso.datetime(),
  activeTools: z.number().int().nonnegative(),
  activeGrants: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  executingCalls: z.number().int().nonnegative(),
  openActionDispatches: z.number().int().nonnegative(),
  failedActionDispatches: z.number().int().nonnegative(),
  completedCalls: z.number().int().nonnegative(),
  deniedCalls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
});

export type ToolRisk = z.infer<typeof toolRiskSchema>;
export type ToolStatus = z.infer<typeof toolStatusSchema>;
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;
export type ToolApprovalStatus = z.infer<typeof toolApprovalStatusSchema>;
export type ToolResourceScope = z.infer<typeof toolResourceScopeSchema>;
export type GovernedTool = z.infer<typeof governedToolSchema>;
export type GovernedToolList = z.infer<typeof governedToolListSchema>;
export type ToolGrant = z.infer<typeof toolGrantSchema>;
export type ToolGrantList = z.infer<typeof toolGrantListSchema>;
export type UpsertToolGrant = z.infer<typeof upsertToolGrantSchema>;
export type GatewayCredential = z.infer<typeof gatewayCredentialSchema>;
export type GatewayCredentialList = z.infer<typeof gatewayCredentialListSchema>;
export type IssueGatewayCredential = z.infer<typeof issueGatewayCredentialSchema>;
export type IssuedGatewayCredential = z.infer<typeof issuedGatewayCredentialSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolCallList = z.infer<typeof toolCallListSchema>;
export type ToolApproval = z.infer<typeof toolApprovalSchema>;
export type ToolApprovalList = z.infer<typeof toolApprovalListSchema>;
export type DecideToolApproval = z.infer<typeof decideToolApprovalSchema>;
export type ToolRuntimeControl = z.infer<typeof toolRuntimeControlSchema>;
export type UpdateToolRuntimeControl = z.infer<typeof updateToolRuntimeControlSchema>;
export type ToolMetrics = z.infer<typeof toolMetricsSchema>;
