import {
  SERVICE_KINDS,
  evaluationCategoryResultSchema,
  evaluationCategorySchema,
  type AiOpsComponent,
  type AiOpsOverview,
  type AiOpsWorkflow,
  type CompleteEvaluationRun,
  type CreateEvaluationRun,
  type CreateOperationalIncident,
  type EvaluationCategory,
  type EvaluationRun,
  type EvaluationRunList,
  type GuardrailControl,
  type IncidentDecision,
  type OperationalIncident,
  type OperationalIncidentList,
  type PromoteEvaluationRun,
  type ProductionReadiness,
  type ProductionReadinessApproval,
  type ProductionReadinessControl,
  type RecordProductionReadinessApproval,
  type ServiceConnectionSummary,
  type ConnectionMonitoringControl,
  type ModelDeployment,
  type ServiceKind,
  type UpdateProductionReadinessControl,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AdminPrincipal } from "../auth/admin-session.js";
import type { ChatManager } from "../chat/chat-manager.js";
import type { ConnectionManager } from "../connections/connection-manager.js";
import type { ConnectionMonitoringManager } from "../connections/connection-monitor.js";
import type { DocumentManager } from "../documents/document-manager.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { OperationsManager } from "../operations/operations-manager.js";
import type { ToolingManager } from "../tooling/tooling-manager.js";
import type { ModelManager } from "../models/model-manager.js";
import { AiOpsConflictError, AiOpsNotFoundError, type AiOpsManager } from "./ai-ops-manager.js";

const HEALTH_FRESHNESS_MS = 15 * 60 * 1_000;

interface AiOpsDependencies {
  connections: ConnectionManager;
  connectionMonitoring?: ConnectionMonitoringManager;
  models?: ModelManager;
  jobs: OperationsManager;
  chat: ChatManager;
  documents: DocumentManager;
  memory: MemoryManager;
  agents: AgentManager;
  tools: ToolingManager;
}

interface StoredIncident {
  id: string;
  title: string;
  severity: "WARNING" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  component: string;
  summary: string;
  owner: string | null;
  automated: boolean;
  detectedAt: Date;
  lastObservedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

interface StoredEvaluation {
  id: string;
  name: string;
  targetType: "MODEL" | "PROMPT" | "POLICY" | "AGENT";
  targetReference: string;
  targetVersion: string;
  status: "DRAFT" | "PASSED" | "FAILED" | "PROMOTED";
  minimumPassRate: number;
  requiredCategories: string[];
  categoryResults: unknown;
  totalCases: number;
  passedCases: number;
  criticalFailures: number;
  createdAt: Date;
  completedAt: Date | null;
  promotedAt: Date | null;
  promotionReason: string | null;
}

interface StoredReadinessControl {
  key: string;
  title: string;
  domain: "SECURITY" | "INFRASTRUCTURE" | "RECOVERY" | "OPERATIONS" | "TRAINING" | "BUSINESS";
  description: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "BLOCKED" | "VERIFIED" | "WAIVED";
  owner: string | null;
  evidenceRefs: string[];
  note: string | null;
  lastUpdatedBy: string | null;
  verifiedAt: Date | null;
  revision: number;
  updatedAt: Date;
}

interface StoredReadinessApproval {
  id: string;
  role: "SECURITY" | "INFRASTRUCTURE" | "PRODUCT" | "BUSINESS";
  decision: "APPROVED" | "REJECTED";
  authority: string;
  evidenceRef: string;
  reason: string;
  recordedBy: string;
  recordedAt: Date;
  controlRevisions: unknown;
}

const READINESS_APPROVAL_ROLES = ["SECURITY", "INFRASTRUCTURE", "PRODUCT", "BUSINESS"] as const;

const serviceMetadata: Record<ServiceKind, { label: string; workflows: AiOpsWorkflow[] }> = {
  LITELLM: { label: "LiteLLM gateway", workflows: ["CHAT", "AGENTS"] },
  VLLM: { label: "vLLM inference", workflows: ["CHAT", "AGENTS"] },
  HERMES: { label: "Hermes runtime", workflows: ["AGENTS", "TOOLS"] },
  SUPERMEMORY: { label: "Supermemory", workflows: ["CHAT", "MEMORY", "AGENTS"] },
  SEAWEEDFS: { label: "SeaweedFS", workflows: ["DOCUMENTS"] },
  OCR: { label: "Unlimited OCR", workflows: ["DOCUMENTS"] },
  MCP: { label: "MCP gateway", workflows: ["AGENTS", "TOOLS"] },
  OIDC: { label: "Enterprise identity", workflows: ["CHAT", "DOCUMENTS", "MEMORY", "AGENTS", "TOOLS"] },
  SIEM: { label: "SIEM forwarding", workflows: [] },
  NOTIFICATION: { label: "Operator notifications", workflows: [] },
  OTHER: { label: "Other service", workflows: [] },
};

interface ActiveGuardrailPolicy {
  id: string;
  displayName: string;
  version: string;
  liteLLMGuardrails: string[];
  maxInputCharacters: number;
  updatedAt: Date;
}

interface ActivePromptTemplate {
  id: string;
  displayName: string;
  purpose: "CHAT_SYSTEM";
  version: string;
  contentChecksum: string;
  updatedAt: Date;
}

function guardrailPosture(active: ActiveGuardrailPolicy | null): GuardrailControl[] {
  const assignment = active
    ? `${active.liteLLMGuardrails.length} approved LiteLLM guardrail${active.liteLLMGuardrails.length === 1 ? "" : "s"} from ${active.displayName} v${active.version}`
    : null;
  return [
  {
    layer: "INPUT",
    label: "Input boundary",
    status: "PARTIAL",
    summary: active
      ? `Schema, identity, rate, and ${active.maxInputCharacters.toLocaleString("en-US")}-character chat limits are locally enforced; ${assignment} are attached to every LiteLLM chat request.`
      : "Schema, size, identity, and rate constraints are enforced; no evaluated LiteLLM guardrail assignment is active.",
    evidence: active
      ? `Policy ${active.id} is evaluation-gated in PostgreSQL; classifier behavior still requires target-environment evidence.`
      : "API contracts and identity-scoped request limits are enforced in the chat, document, agent, and tool routes.",
  },
  {
    layer: "OUTPUT",
    label: "Output boundary",
    status: "NOT_VERIFIED",
    summary: active
      ? `${assignment} are delegated to LiteLLM, but AIHub does not infer whether each upstream guardrail is configured for pre-call, post-call, or both.`
      : "Provider responses are structurally bounded, but no evaluated output guardrail assignment is active.",
    evidence: active
      ? "Streaming failures and LiteLLM policy rejections are retained as sanitized audit events; upstream hook modes require deployment verification."
      : "Streaming state and persistence are validated locally; safety-model evidence has not been recorded.",
  },
  {
    layer: "RETRIEVAL",
    label: "Retrieval authorization",
    status: "ENFORCED",
    summary: "Remote Supermemory results are rejected unless PostgreSQL confirms current owner and publication eligibility.",
    evidence: "Private-scope retrieval performs local ownership and lifecycle rechecks before a source reaches chat or Hermes.",
  },
  {
    layer: "MODEL_ACCESS",
    label: "Model access",
    status: "ENFORCED",
    summary: "Users and agents call dashboard-approved aliases through AIHub; provider credentials remain backend-only.",
    evidence: "Versioned model routes require healthy serving connections and exact promoted evaluation evidence before activation.",
  },
  {
    layer: "TOOL_USE",
    label: "Tool authorization",
    status: "ENFORCED",
    summary: "MCP invocations require gateway and per-run capability factors, exact-version grants, scope checks, and approvals.",
    evidence: "The governed tool gateway fails closed and retains calls and approval decisions in PostgreSQL.",
  },
  {
    layer: "DATA_EGRESS",
    label: "Data egress",
    status: "PARTIAL",
    summary: "AIHub uses configured internal endpoints, while infrastructure-level egress enforcement remains an on-prem acceptance gate.",
    evidence: "Application credentials are isolated; network policy and SIEM forwarding have not been proven locally.",
  },
  ];
}

function incident(record: StoredIncident): OperationalIncident {
  return {
    id: record.id,
    title: record.title,
    severity: record.severity,
    status: record.status,
    component: record.component,
    summary: record.summary,
    owner: record.owner,
    automated: record.automated,
    detectedAt: record.detectedAt.toISOString(),
    lastObservedAt: record.lastObservedAt.toISOString(),
    acknowledgedAt: record.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
    resolutionNote: record.resolutionNote,
  };
}

function evaluation(record: StoredEvaluation): EvaluationRun {
  const requiredCategories = evaluationCategorySchema.array().min(1)
    .refine((items) => new Set(items).size === items.length)
    .parse(record.requiredCategories);
  const rawResults = Array.isArray(record.categoryResults) ? record.categoryResults : [];
  const results = evaluationCategoryResultSchema.array()
    .refine((items) => new Set(items.map(({ category }) => category)).size === items.length)
    .parse(rawResults);
  if (record.status !== "DRAFT") {
    const resultCategories = new Set(results.map(({ category }) => category));
    if (requiredCategories.some((category) => !resultCategories.has(category))) {
      throw new AiOpsConflictError("Stored evaluation evidence is inconsistent with its required gate categories.");
    }
  }
  return {
    id: record.id,
    name: record.name,
    targetType: record.targetType,
    targetReference: record.targetReference,
    targetVersion: record.targetVersion,
    status: record.status,
    minimumPassRate: record.minimumPassRate,
    requiredCategories,
    results,
    totalCases: record.totalCases,
    passedCases: record.passedCases,
    criticalFailures: record.criticalFailures,
    passRate: record.totalCases === 0 ? null : record.passedCases / record.totalCases,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    promotedAt: record.promotedAt?.toISOString() ?? null,
    promotionReason: record.promotionReason,
  };
}

function readinessControl(record: StoredReadinessControl): ProductionReadinessControl {
  return {
    key: record.key,
    title: record.title,
    domain: record.domain,
    description: record.description,
    status: record.status,
    owner: record.owner,
    evidenceRefs: record.evidenceRefs,
    note: record.note,
    lastUpdatedBy: record.lastUpdatedBy,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    revision: record.revision,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function approvalMatchesControls(record: StoredReadinessApproval, controls: ProductionReadinessControl[]): boolean {
  if (!record.controlRevisions || typeof record.controlRevisions !== "object" || Array.isArray(record.controlRevisions)) return false;
  const snapshot = record.controlRevisions as Record<string, unknown>;
  return Object.keys(snapshot).length === controls.length
    && controls.every((control) => snapshot[control.key] === control.revision);
}

function readinessApproval(record: StoredReadinessApproval, isCurrent: boolean): ProductionReadinessApproval {
  return {
    id: record.id,
    role: record.role,
    decision: record.decision,
    authority: record.authority,
    evidenceRef: record.evidenceRef,
    reason: record.reason,
    recordedBy: record.recordedBy,
    recordedAt: record.recordedAt.toISOString(),
    isCurrent,
  };
}

function configuredComponent(
  connection: ServiceConnectionSummary,
  now: Date,
  monitoring: ConnectionMonitoringControl | null,
): AiOpsComponent {
  const metadata = serviceMetadata[connection.kind];
  const observedAt = connection.lastHealthcheckAt;
  const continuous = monitoring?.enabled === true;
  const freshnessMs = continuous
    ? Math.max(2 * monitoring.intervalSeconds * 1_000, 2 * 60 * 1_000)
    : HEALTH_FRESHNESS_MS;
  const recentlyObserved = observedAt !== null && now.getTime() - new Date(observedAt).getTime() <= freshnessMs;
  const evidenceSource = continuous && recentlyObserved ? "LIVE" as const : "LAST_VERIFIED" as const;
  if (!connection.enabled) {
    return {
      id: `connection:${connection.id}`,
      label: connection.displayName,
      status: "NOT_CONFIGURED",
      summary: `${metadata.label} is configured but disabled.`,
      source: "CONFIGURATION",
      observedAt,
      latencyMs: null,
      affectedWorkflows: metadata.workflows,
    };
  }
  if (connection.status === "UNREACHABLE") {
    return {
      id: `connection:${connection.id}`,
      label: connection.displayName,
      status: "UNAVAILABLE",
      summary: connection.lastHealthcheckMessage ?? `${metadata.label} was unreachable during its last check.`,
      source: evidenceSource,
      observedAt,
      latencyMs: null,
      affectedWorkflows: metadata.workflows,
    };
  }
  if (connection.status === "DEGRADED") {
    return {
      id: `connection:${connection.id}`,
      label: connection.displayName,
      status: "DEGRADED",
      summary: connection.lastHealthcheckMessage ?? `${metadata.label} was degraded during its last check.`,
      source: evidenceSource,
      observedAt,
      latencyMs: null,
      affectedWorkflows: metadata.workflows,
    };
  }
  const stale = !observedAt || !recentlyObserved;
  if (connection.status !== "HEALTHY" || stale) {
    return {
      id: `connection:${connection.id}`,
      label: connection.displayName,
      status: "NOT_VERIFIED",
      summary: !observedAt
        ? "Enabled, but no credential-aware connection test has passed."
        : continuous
          ? "The scheduled connection check is overdue."
          : "The last passing connection test is older than 15 minutes.",
      source: observedAt ? "LAST_VERIFIED" : "CONFIGURATION",
      observedAt,
      latencyMs: null,
      affectedWorkflows: metadata.workflows,
    };
  }
  return {
    id: `connection:${connection.id}`,
    label: connection.displayName,
    status: "HEALTHY",
    summary: connection.lastHealthcheckMessage ?? `${metadata.label} passed its last credential-aware check.`,
    source: evidenceSource,
    observedAt,
    latencyMs: null,
    affectedWorkflows: metadata.workflows,
  };
}

function placeholderComponent(kind: ServiceKind): AiOpsComponent {
  const metadata = serviceMetadata[kind];
  return {
    id: `service:${kind.toLowerCase()}`,
    label: metadata.label,
    status: "NOT_CONFIGURED",
    summary: "No dashboard-managed connection is configured.",
    source: "CONFIGURATION",
    observedAt: null,
    latencyMs: null,
    affectedWorkflows: metadata.workflows,
  };
}

function modelComponent(model: ModelDeployment): AiOpsComponent {
  const affectedWorkflows: AiOpsWorkflow[] = model.workload === "CHAT"
    ? ["CHAT"]
    : model.workload === "AGENT"
      ? ["AGENTS"]
      : model.workload === "OCR"
        ? ["DOCUMENTS"]
        : ["MEMORY"];
  const status = model.status !== "ACTIVE"
    ? "NOT_CONFIGURED" as const
    : !model.connection.enabled || ["DISABLED", "UNREACHABLE"].includes(model.connection.status)
      ? "UNAVAILABLE" as const
      : model.connection.status === "DEGRADED"
        ? "DEGRADED" as const
        : model.connection.status === "HEALTHY"
          ? "HEALTHY" as const
          : "NOT_VERIFIED" as const;
  return {
    id: `model:${model.id}`,
    label: model.displayName,
    status,
    summary: model.status !== "ACTIVE"
      ? `${model.workload.toLowerCase()} route ${model.modelAlias} is ${model.status.toLowerCase()}.`
      : status === "HEALTHY"
        ? `${model.modelAlias} is active${model.isDefault ? " as the workload default" : ""} with promoted version evidence.`
        : `The active route depends on ${model.connection.displayName}, which is ${model.connection.status.toLowerCase()}.`,
    source: "CONFIGURATION",
    observedAt: model.updatedAt,
    latencyMs: null,
    affectedWorkflows,
  };
}

async function settled<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export class PrismaAiOpsManager implements AiOpsManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly dependencies: AiOpsDependencies,
  ) {}

  async overview(): Promise<AiOpsOverview> {
    const generatedAt = new Date();
    const [connections, monitoring, models, jobs, chat, documents, memory, agents, tools, activeGuardrail, activePrompt] = await Promise.all([
      settled(this.dependencies.connections.list()),
      this.dependencies.connectionMonitoring ? settled(this.dependencies.connectionMonitoring.getControl()) : Promise.resolve(null),
      this.dependencies.models ? settled(this.dependencies.models.list()) : Promise.resolve(null),
      settled(this.dependencies.jobs.snapshot()),
      settled(this.dependencies.chat.metrics()),
      settled(this.dependencies.documents.metrics()),
      settled(this.dependencies.memory.metrics()),
      settled(this.dependencies.agents.metrics()),
      settled(this.dependencies.tools.metrics()),
      settled(this.prisma.guardrailPolicy.findFirst({
        where: { status: "ACTIVE" },
        select: { id: true, displayName: true, version: true, liteLLMGuardrails: true, maxInputCharacters: true, updatedAt: true },
      })),
      settled(this.prisma.promptTemplate.findFirst({
        where: { purpose: "CHAT_SYSTEM", status: "ACTIVE" },
        select: { id: true, displayName: true, purpose: true, version: true, contentChecksum: true, updatedAt: true },
      })),
    ]);

    const components: AiOpsComponent[] = [
      {
        id: "postgresql",
        label: "PostgreSQL",
        status: "HEALTHY",
        summary: "The AI operations snapshot was read from the PostgreSQL system of record.",
        source: "LIVE",
        observedAt: generatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["CHAT", "DOCUMENTS", "MEMORY", "AGENTS", "TOOLS"],
      },
      {
        id: "jobs",
        label: "pg-boss workers",
        status: jobs ? (jobs.status === "ONLINE" ? "HEALTHY" : "DEGRADED") : "UNAVAILABLE",
        summary: jobs ? (jobs.statusReasons[0] ?? "Required queues have online workers.") : "Queue and worker state could not be read.",
        source: "LIVE",
        observedAt: jobs?.capturedAt ?? generatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["DOCUMENTS", "MEMORY", "AGENTS"],
      },
    ];

    if (connections) {
      const configuredKinds = new Set(connections.map(({ kind }) => kind));
      components.push(...connections.map((connection) => configuredComponent(connection, generatedAt, monitoring)));
      components.push(...SERVICE_KINDS.filter((kind) => kind !== "OTHER" && !configuredKinds.has(kind)).map(placeholderComponent));
    } else {
      components.push({
        id: "connection-control",
        label: "Service connection control",
        status: "UNAVAILABLE",
        summary: "Dashboard-managed service connection state could not be read.",
        source: "LIVE",
        observedAt: generatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["CHAT", "DOCUMENTS", "MEMORY", "AGENTS", "TOOLS"],
      });
    }
    if (models) components.push(...models.items.map(modelComponent));
    if (activeGuardrail) {
      components.push({
        id: `guardrail:${activeGuardrail.id}`,
        label: activeGuardrail.displayName,
        status: "HEALTHY",
        summary: `${activeGuardrail.liteLLMGuardrails.length} LiteLLM guardrail assignment${activeGuardrail.liteLLMGuardrails.length === 1 ? "" : "s"} active with promoted policy evidence.`,
        source: "CONFIGURATION",
        observedAt: activeGuardrail.updatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["CHAT"],
      });
    }
    if (activePrompt) {
      const prompt = activePrompt as ActivePromptTemplate;
      components.push({
        id: `prompt:${prompt.id}`,
        label: prompt.displayName,
        status: "HEALTHY",
        summary: `Chat-system prompt v${prompt.version} is active with promoted CHAT and SAFETY evidence; checksum ${prompt.contentChecksum.slice(0, 12)}.`,
        source: "CONFIGURATION",
        observedAt: prompt.updatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["CHAT"],
      });
    }

    await this.reconcileAutomatedIncidents(components, generatedAt);
    const [incidentItems, openIncidentCount, criticalIncidentCount, evaluationGroups] = await Promise.all([
      this.prisma.operationalIncident.findMany({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        orderBy: { detectedAt: "desc" },
        take: 20,
      }),
      this.prisma.operationalIncident.count({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      }),
      this.prisma.operationalIncident.count({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, severity: "CRITICAL" },
      }),
      this.prisma.evaluationRun.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const visibleIncidents = incidentItems.map((item) => incident(item as StoredIncident)).sort((left, right) => {
      if (left.severity !== right.severity) return left.severity === "CRITICAL" ? -1 : 1;
      return right.detectedAt.localeCompare(left.detectedAt);
    });
    const evaluationCount = (status: StoredEvaluation["status"]) => evaluationGroups
      .filter((group) => group.status === status)
      .reduce((sum, group) => sum + group._count._all, 0);
    const status = components.some(({ status }) => status === "UNAVAILABLE")
      ? "CRITICAL"
      : components.some(({ status }) => status !== "HEALTHY")
        ? "DEGRADED"
        : "HEALTHY";

    return {
      generatedAt: generatedAt.toISOString(),
      status,
      components,
      jobs,
      metrics: { chat, documents, memory, agents, tools },
      guardrails: guardrailPosture(activeGuardrail),
      incidents: {
        open: openIncidentCount,
        critical: criticalIncidentCount,
        items: visibleIncidents,
      },
      evaluations: {
        drafts: evaluationCount("DRAFT"),
        passed: evaluationCount("PASSED"),
        failed: evaluationCount("FAILED"),
        promoted: evaluationCount("PROMOTED"),
      },
    };
  }

  async listIncidents(): Promise<OperationalIncidentList> {
    const items = await this.prisma.operationalIncident.findMany({
      orderBy: { detectedAt: "desc" },
      take: 200,
    });
    return { items: items.map((item) => incident(item as StoredIncident)) };
  }

  async createIncident(principal: AdminPrincipal, input: CreateOperationalIncident): Promise<OperationalIncident> {
    const now = new Date();
    const created = await this.prisma.$transaction(async (transaction) => {
      const record = await transaction.operationalIncident.create({
        data: { ...input, automated: false, detectedAt: now, lastObservedAt: now },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "operations.incident_created",
        resourceType: "OperationalIncident", resourceId: record.id, outcome: "SUCCESS",
        metadata: { component: record.component, severity: record.severity },
      } });
      return record;
    });
    return incident(created as StoredIncident);
  }

  async acknowledgeIncident(principal: AdminPrincipal, incidentId: string, input: IncidentDecision): Promise<OperationalIncident> {
    const now = new Date();
    return this.changeIncident(principal, incidentId, "OPEN", {
      status: "ACKNOWLEDGED",
      acknowledgedBy: principal.id,
      acknowledgedAt: now,
      owner: input.owner ?? principal.subject,
      resolutionNote: input.note,
    }, "operations.incident_acknowledged", input);
  }

  async resolveIncident(principal: AdminPrincipal, incidentId: string, input: IncidentDecision): Promise<OperationalIncident> {
    return this.changeIncident(principal, incidentId, ["OPEN", "ACKNOWLEDGED"], {
      status: "RESOLVED",
      activeFingerprint: null,
      resolvedBy: principal.id,
      resolvedAt: new Date(),
      owner: input.owner ?? principal.subject,
      resolutionNote: input.note,
    }, "operations.incident_resolved", input);
  }

  async listEvaluations(): Promise<EvaluationRunList> {
    const items = await this.prisma.evaluationRun.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return { items: items.map((item) => evaluation(item as StoredEvaluation)) };
  }

  async createEvaluation(principal: AdminPrincipal, input: CreateEvaluationRun): Promise<EvaluationRun> {
    const created = await this.prisma.$transaction(async (transaction) => {
      const record = await transaction.evaluationRun.create({ data: {
        ...input,
        createdBy: principal.id,
        categoryResults: [],
      } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "evaluation.candidate_created",
        resourceType: "EvaluationRun", resourceId: record.id, outcome: "SUCCESS",
        metadata: { targetType: record.targetType, targetReference: record.targetReference, targetVersion: record.targetVersion },
      } });
      return record;
    });
    return evaluation(created as StoredEvaluation);
  }

  async completeEvaluation(principal: AdminPrincipal, evaluationId: string, input: CompleteEvaluationRun): Promise<EvaluationRun> {
    const current = await this.prisma.evaluationRun.findUnique({ where: { id: evaluationId } });
    if (!current) throw new AiOpsNotFoundError("The evaluation candidate does not exist.");
    if (current.status !== "DRAFT") throw new AiOpsConflictError("Completed evaluation evidence is immutable; create a new candidate to rerun it.");
    const resultByCategory = new Map(input.results.map((result) => [result.category, result]));
    const missing = current.requiredCategories.filter((category) => !resultByCategory.has(category as EvaluationCategory));
    if (missing.length > 0) throw new AiOpsConflictError(`Evidence is missing for required categories: ${missing.join(", ")}.`);
    const unexpected = input.results.filter(({ category }) => !current.requiredCategories.includes(category));
    if (unexpected.length > 0) throw new AiOpsConflictError(`Evidence was provided for categories outside this gate: ${unexpected.map(({ category }) => category).join(", ")}.`);

    const categoryResults = input.results.map((result) => {
      const passRate = result.passedCases / result.totalCases;
      return {
        ...result,
        passRate,
        status: passRate >= current.minimumPassRate && result.criticalFailures === 0 ? "PASSED" as const : "FAILED" as const,
      };
    });
    const totalCases = categoryResults.reduce((sum, result) => sum + result.totalCases, 0);
    const passedCases = categoryResults.reduce((sum, result) => sum + result.passedCases, 0);
    const criticalFailures = categoryResults.reduce((sum, result) => sum + result.criticalFailures, 0);
    const requiredPassed = current.requiredCategories.every((category) => resultByCategory.has(category as EvaluationCategory)
      && categoryResults.find((result) => result.category === category)?.status === "PASSED");
    const status = requiredPassed ? "PASSED" as const : "FAILED" as const;
    const completedAt = new Date();
    const updated = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.evaluationRun.updateMany({
        where: { id: evaluationId, status: "DRAFT" },
        data: {
          status,
          categoryResults: categoryResults as Prisma.InputJsonValue,
          totalCases,
          passedCases,
          criticalFailures,
          completedAt,
        },
      });
      if (claimed.count !== 1) throw new AiOpsConflictError("The evaluation candidate changed before evidence was recorded.");
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "evaluation.evidence_recorded",
        resourceType: "EvaluationRun", resourceId: evaluationId, outcome: status,
        metadata: { totalCases, passedCases, criticalFailures, status },
      } });
      return transaction.evaluationRun.findUniqueOrThrow({ where: { id: evaluationId } });
    });
    return evaluation(updated as StoredEvaluation);
  }

  async promoteEvaluation(principal: AdminPrincipal, evaluationId: string, input: PromoteEvaluationRun): Promise<EvaluationRun> {
    const promotedAt = new Date();
    const promoted = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.evaluationRun.updateMany({
        where: { id: evaluationId, status: "PASSED", criticalFailures: 0 },
        data: { status: "PROMOTED", promotedBy: principal.id, promotedAt, promotionReason: input.reason },
      });
      if (claimed.count !== 1) {
        const exists = await transaction.evaluationRun.findUnique({ where: { id: evaluationId }, select: { id: true } });
        if (!exists) throw new AiOpsNotFoundError("The evaluation candidate does not exist.");
        throw new AiOpsConflictError("Only a passed, unpromoted evaluation candidate can be promoted.");
      }
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "evaluation.candidate_promoted",
        resourceType: "EvaluationRun", resourceId: evaluationId, outcome: "SUCCESS",
        metadata: { reason: input.reason },
      } });
      return transaction.evaluationRun.findUniqueOrThrow({ where: { id: evaluationId } });
    });
    return evaluation(promoted as StoredEvaluation);
  }

  async productionReadiness(): Promise<ProductionReadiness> {
    const { storedControls, latestDecisions } = await this.prisma.$transaction(async (transaction) => ({
      storedControls: await transaction.productionReadinessControl.findMany({ orderBy: [{ domain: "asc" }, { title: "asc" }] }),
      latestDecisions: await Promise.all(READINESS_APPROVAL_ROLES.map((role) => transaction.productionReadinessApproval.findFirst({
        where: { role },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      }))),
    }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const controls = storedControls.map((record) => readinessControl(record as StoredReadinessControl));
    const latestByRole = new Map<StoredReadinessApproval["role"], StoredReadinessApproval>();
    for (const record of latestDecisions as Array<StoredReadinessApproval | null>) {
      if (record) latestByRole.set(record.role, record);
    }
    const approvals = READINESS_APPROVAL_ROLES
      .map((role) => latestByRole.get(role))
      .filter((record): record is StoredReadinessApproval => record !== undefined)
      .map((record) => readinessApproval(record, approvalMatchesControls(record, controls)));
    const verifiedControls = controls.filter(({ status }) => status === "VERIFIED").length;
    const waivedControls = controls.filter(({ status }) => status === "WAIVED").length;
    const blockedControls = controls.filter(({ status }) => status === "BLOCKED").length;
    const approvedRoles = approvals.filter(({ decision, isCurrent }) => decision === "APPROVED" && isCurrent).length;
    const allControlsAccepted = controls.length > 0 && controls.every(({ status }) => status === "VERIFIED" || status === "WAIVED");
    const allRolesApproved = READINESS_APPROVAL_ROLES.every((role) => approvals.some((approval) => approval.role === role && approval.decision === "APPROVED" && approval.isCurrent));
    const rejected = approvals.some(({ decision, isCurrent }) => decision === "REJECTED" && isCurrent);
    const blockers = [
      ...controls.filter(({ status }) => status !== "VERIFIED" && status !== "WAIVED").map(({ title }) => `Control incomplete: ${title}`),
      ...READINESS_APPROVAL_ROLES.filter((role) => !approvals.some((approval) => approval.role === role && approval.decision === "APPROVED" && approval.isCurrent)).map((role) => {
        const approval = approvals.find((item) => item.role === role);
        if (approval?.decision === "REJECTED" && approval.isCurrent) return `${role} approval rejected`;
        return approval ? `${role} approval is stale after readiness evidence changed` : `${role} approval not recorded`;
      }),
    ];
    return {
      generatedAt: new Date().toISOString(),
      status: rejected ? "REJECTED" : allControlsAccepted && allRolesApproved ? "READY" : "NOT_READY",
      controls,
      approvals,
      summary: {
        totalControls: controls.length,
        verifiedControls,
        waivedControls,
        blockedControls,
        requiredApprovals: READINESS_APPROVAL_ROLES.length,
        approvedRoles,
      },
      blockers,
    };
  }

  async updateReadinessControl(
    principal: AdminPrincipal,
    controlKey: string,
    input: UpdateProductionReadinessControl,
  ): Promise<ProductionReadinessControl> {
    const verifiedAt = input.status === "VERIFIED" || input.status === "WAIVED" ? new Date() : null;
    const updated = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.productionReadinessControl.updateMany({
        where: { key: controlKey, revision: input.expectedRevision },
        data: {
          status: input.status,
          owner: input.owner,
          evidenceRefs: input.evidenceRefs,
          note: input.note,
          lastUpdatedBy: principal.subject,
          verifiedAt,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        const exists = await transaction.productionReadinessControl.findUnique({ where: { key: controlKey }, select: { key: true } });
        if (!exists) throw new AiOpsNotFoundError("The production-readiness control does not exist.");
        throw new AiOpsConflictError("The production-readiness control changed; refresh before recording another decision.");
      }
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "production_readiness.control_updated",
        resourceType: "ProductionReadinessControl",
        resourceId: controlKey,
        outcome: input.status,
        metadata: { status: input.status, owner: input.owner, evidenceRefs: input.evidenceRefs, note: input.note },
      } });
      return transaction.productionReadinessControl.findUniqueOrThrow({ where: { key: controlKey } });
    });
    return readinessControl(updated as StoredReadinessControl);
  }

  async recordReadinessApproval(
    principal: AdminPrincipal,
    input: RecordProductionReadinessApproval,
  ): Promise<ProductionReadinessApproval> {
    const recorded = await this.prisma.$transaction(async (transaction) => {
      const controls = await transaction.productionReadinessControl.findMany({
        select: { key: true, revision: true, status: true },
      });
      const controlsAccepted = controls.length > 0 && controls.every(({ status }) => status === "VERIFIED" || status === "WAIVED");
      if (input.decision === "APPROVED" && !controlsAccepted) {
        throw new AiOpsConflictError("An approval can be recorded only after every readiness control is verified or formally waived.");
      }
      const controlRevisions = Object.fromEntries(controls.map(({ key, revision }) => [key, revision]));
      const decision = await transaction.productionReadinessApproval.create({ data: {
        ...input,
        recordedBy: principal.subject,
        controlRevisions,
      } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "production_readiness.approval_recorded",
        resourceType: "ProductionReadinessApproval",
        resourceId: decision.id,
        outcome: input.decision,
        metadata: { role: input.role, authority: input.authority, evidenceRef: input.evidenceRef, controlCount: controls.length },
      } });
      return decision;
    });
    return readinessApproval(recorded as StoredReadinessApproval, true);
  }

  private async changeIncident(
    principal: AdminPrincipal,
    incidentId: string,
    expectedStatus: "OPEN" | Array<"OPEN" | "ACKNOWLEDGED">,
    data: Prisma.OperationalIncidentUpdateManyMutationInput,
    action: string,
    decision: IncidentDecision,
  ): Promise<OperationalIncident> {
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const updated = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.operationalIncident.updateMany({
        where: { id: incidentId, status: { in: statuses } },
        data,
      });
      if (claimed.count !== 1) {
        const exists = await transaction.operationalIncident.findUnique({ where: { id: incidentId }, select: { id: true } });
        if (!exists) throw new AiOpsNotFoundError("The operational incident does not exist.");
        throw new AiOpsConflictError("The operational incident is no longer eligible for this decision.");
      }
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action,
        resourceType: "OperationalIncident", resourceId: incidentId, outcome: "SUCCESS",
        metadata: { note: decision.note, owner: decision.owner ?? principal.subject },
      } });
      return transaction.operationalIncident.findUniqueOrThrow({ where: { id: incidentId } });
    });
    return incident(updated as StoredIncident);
  }

  private async reconcileAutomatedIncidents(components: AiOpsComponent[], observedAt: Date): Promise<void> {
    await Promise.all(components.map(async (component) => {
      const activeFingerprint = `component:${component.id}`;
      if (component.status === "DEGRADED" || component.status === "UNAVAILABLE") {
        await this.prisma.operationalIncident.upsert({
          where: { activeFingerprint },
          create: {
            activeFingerprint,
            title: `${component.label} is ${component.status === "UNAVAILABLE" ? "unavailable" : "degraded"}`,
            severity: component.status === "UNAVAILABLE" ? "CRITICAL" : "WARNING",
            component: component.id,
            summary: component.summary,
            automated: true,
            detectedAt: observedAt,
            lastObservedAt: observedAt,
          },
          update: {
            title: `${component.label} is ${component.status === "UNAVAILABLE" ? "unavailable" : "degraded"}`,
            severity: component.status === "UNAVAILABLE" ? "CRITICAL" : "WARNING",
            summary: component.summary,
            lastObservedAt: observedAt,
          },
        });
      } else {
        await this.prisma.operationalIncident.updateMany({
          where: { activeFingerprint, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
          data: {
            status: "RESOLVED",
            activeFingerprint: null,
            resolvedAt: observedAt,
            resolutionNote: "Automatically resolved after the component returned to a non-degraded state.",
          },
        });
      }
    }));
  }
}
