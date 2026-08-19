import { z } from "zod";
import { agentMetricsSchema } from "./agents.js";
import { chatMetricsSchema } from "./chat.js";
import { runtimeOperationsSnapshotSchema } from "./runtime-operations.js";
import { toolMetricsSchema } from "./tooling.js";

export const AI_OPS_COMPONENT_STATUSES = [
  "HEALTHY",
  "DEGRADED",
  "UNAVAILABLE",
  "NOT_VERIFIED",
  "NOT_CONFIGURED",
] as const;
export const aiOpsComponentStatusSchema = z.enum(AI_OPS_COMPONENT_STATUSES);

export const aiOpsWorkflowSchema = z.enum([
  "CHAT",
  "AGENTS",
  "TOOLS",
]);

export const aiOpsComponentSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  status: aiOpsComponentStatusSchema,
  summary: z.string().min(1).max(500),
  source: z.enum(["LIVE", "LAST_VERIFIED", "CONFIGURATION"]),
  /**
   * Whether this capability has to be configured for the platform to work.
   *
   * `NOT_CONFIGURED` alone cannot answer that, and reading it as a fault is
   * how the health badge became permanently DEGRADED: a deployment that never
   * schedules an unattended turn was told it was degraded for declining to use
   * a feature. Optional capabilities still report NOT_CONFIGURED rather than
   * HEALTHY -- nobody should be told their schedules are fine when there are
   * none -- they simply do not count against the plane.
   *
   * Defaulted so a component built before this field existed reads as
   * required, which is the conservative answer.
   */
  required: z.boolean().default(true),
  observedAt: z.iso.datetime().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  affectedWorkflows: z.array(aiOpsWorkflowSchema),
});

/*
 * Five layers, not six. `RETRIEVAL` was declared here and emitted by nothing --
 * `guardrailControls` in the AI-ops manager returns the other five and always
 * has -- because this product has no retrieval plane: there is no vector store,
 * no embedding model and no document library, by design. A layer the schema
 * admits and the deployment can never report is a claim about coverage that
 * nothing behind it can meet.
 */
export const guardrailLayerSchema = z.enum([
  "INPUT",
  "OUTPUT",
  "MODEL_ACCESS",
  "TOOL_USE",
  "DATA_EGRESS",
]);

export const guardrailControlSchema = z.object({
  layer: guardrailLayerSchema,
  label: z.string().min(1).max(120),
  status: z.enum(["ENFORCED", "PARTIAL", "NOT_VERIFIED"]),
  summary: z.string().min(1).max(500),
  evidence: z.string().min(1).max(500),
});

export const incidentSeveritySchema = z.enum(["WARNING", "CRITICAL"]);
export const incidentStatusSchema = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);

export const operationalIncidentSchema = z.object({
  id: z.uuid(),
  title: z.string().min(3).max(160),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  component: z.string().min(1).max(80),
  summary: z.string().min(3).max(1_000),
  owner: z.string().min(1).max(160).nullable(),
  automated: z.boolean(),
  detectedAt: z.iso.datetime(),
  lastObservedAt: z.iso.datetime(),
  acknowledgedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  resolutionNote: z.string().max(1_000).nullable(),
});
export const operationalIncidentIdentifierSchema = z.uuid();

export const operationalIncidentListSchema = z.object({
  items: z.array(operationalIncidentSchema),
});

export const createOperationalIncidentSchema = z.object({
  title: z.string().trim().min(3).max(160),
  severity: incidentSeveritySchema,
  component: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(3).max(1_000),
  owner: z.string().trim().min(1).max(160).nullable().default(null),
}).strict();

export const incidentDecisionSchema = z.object({
  note: z.string().trim().min(3).max(1_000),
  owner: z.string().trim().min(1).max(160).optional(),
}).strict();

export const PRODUCTION_READINESS_DOMAINS = [
  "SECURITY",
  "INFRASTRUCTURE",
  "RECOVERY",
  "OPERATIONS",
  "TRAINING",
  "BUSINESS",
] as const;
export const productionReadinessDomainSchema = z.enum(PRODUCTION_READINESS_DOMAINS);
export const productionReadinessControlStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "BLOCKED",
  "VERIFIED",
  "WAIVED",
]);
export const productionReadinessApprovalRoleSchema = z.enum([
  "SECURITY",
  "INFRASTRUCTURE",
  "PRODUCT",
  "BUSINESS",
]);
export const productionReadinessApprovalDecisionSchema = z.enum(["APPROVED", "REJECTED"]);

export const productionReadinessControlKeySchema = z.string().regex(/^[a-z][a-z0-9-]{2,79}$/);
export const productionReadinessControlSchema = z.object({
  key: productionReadinessControlKeySchema,
  title: z.string().min(3).max(160),
  domain: productionReadinessDomainSchema,
  description: z.string().min(3).max(1_000),
  status: productionReadinessControlStatusSchema,
  owner: z.string().min(1).max(160).nullable(),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(20),
  note: z.string().max(1_000).nullable(),
  lastUpdatedBy: z.string().min(1).max(160).nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});

export const updateProductionReadinessControlSchema = z.object({
  status: productionReadinessControlStatusSchema,
  owner: z.string().trim().min(1).max(160).nullable(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(20)
    .refine((items) => new Set(items).size === items.length, "Evidence references must be unique."),
  note: z.string().trim().min(3).max(1_000).nullable(),
  expectedRevision: z.number().int().nonnegative(),
}).strict().superRefine((input, context) => {
  if (input.status !== "NOT_STARTED" && input.owner === null) {
    context.addIssue({ code: "custom", path: ["owner"], message: "An owner is required after work starts." });
  }
  if (["BLOCKED", "VERIFIED", "WAIVED"].includes(input.status) && input.note === null) {
    context.addIssue({ code: "custom", path: ["note"], message: "A decision note is required for this status." });
  }
  if (["VERIFIED", "WAIVED"].includes(input.status) && input.evidenceRefs.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Verified and waived controls require retained evidence." });
  }
});

export const productionReadinessApprovalSchema = z.object({
  id: z.uuid(),
  role: productionReadinessApprovalRoleSchema,
  decision: productionReadinessApprovalDecisionSchema,
  authority: z.string().min(1).max(160),
  evidenceRef: z.string().min(1).max(500),
  reason: z.string().min(3).max(1_000),
  recordedBy: z.string().min(1).max(160),
  recordedAt: z.iso.datetime(),
  isCurrent: z.boolean(),
});

export const recordProductionReadinessApprovalSchema = z.object({
  role: productionReadinessApprovalRoleSchema,
  decision: productionReadinessApprovalDecisionSchema,
  authority: z.string().trim().min(1).max(160),
  evidenceRef: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(3).max(1_000),
}).strict();

export const productionReadinessSchema = z.object({
  generatedAt: z.iso.datetime(),
  status: z.enum(["NOT_READY", "READY", "REJECTED"]),
  controls: z.array(productionReadinessControlSchema),
  approvals: z.array(productionReadinessApprovalSchema),
  summary: z.object({
    totalControls: z.number().int().nonnegative(),
    verifiedControls: z.number().int().nonnegative(),
    waivedControls: z.number().int().nonnegative(),
    blockedControls: z.number().int().nonnegative(),
    requiredApprovals: z.number().int().positive(),
    approvedRoles: z.number().int().nonnegative(),
  }),
  blockers: z.array(z.string().min(1).max(240)),
});

export const aiOpsOverviewSchema = z.object({
  generatedAt: z.iso.datetime(),
  status: z.enum(["HEALTHY", "DEGRADED", "CRITICAL"]),
  components: z.array(aiOpsComponentSchema),
  runtime: runtimeOperationsSnapshotSchema.nullable(),
  metrics: z.object({
    chat: chatMetricsSchema.nullable(),
    agents: agentMetricsSchema.nullable(),
    tools: toolMetricsSchema.nullable(),
  }),
  guardrails: z.array(guardrailControlSchema),
  incidents: z.object({
    open: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
    items: z.array(operationalIncidentSchema),
  }),
});

export type AiOpsComponentStatus = z.infer<typeof aiOpsComponentStatusSchema>;
export type AiOpsWorkflow = z.infer<typeof aiOpsWorkflowSchema>;
export type AiOpsComponent = z.infer<typeof aiOpsComponentSchema>;
export type GuardrailControl = z.infer<typeof guardrailControlSchema>;
export type OperationalIncident = z.infer<typeof operationalIncidentSchema>;
export type OperationalIncidentList = z.infer<typeof operationalIncidentListSchema>;
export type CreateOperationalIncident = z.infer<typeof createOperationalIncidentSchema>;
export type IncidentDecision = z.infer<typeof incidentDecisionSchema>;
export type ProductionReadinessDomain = z.infer<typeof productionReadinessDomainSchema>;
export type ProductionReadinessControlStatus = z.infer<typeof productionReadinessControlStatusSchema>;
export type ProductionReadinessControl = z.infer<typeof productionReadinessControlSchema>;
export type UpdateProductionReadinessControl = z.infer<typeof updateProductionReadinessControlSchema>;
export type ProductionReadinessApproval = z.infer<typeof productionReadinessApprovalSchema>;
export type RecordProductionReadinessApproval = z.infer<typeof recordProductionReadinessApprovalSchema>;
export type ProductionReadiness = z.infer<typeof productionReadinessSchema>;
export type AiOpsOverview = z.infer<typeof aiOpsOverviewSchema>;
