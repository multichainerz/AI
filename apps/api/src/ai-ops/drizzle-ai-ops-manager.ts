import {
  type AiOpsComponent,
  type AiOpsOverview,
  type AiOpsWorkflow,
  type CreateOperationalIncident,
  type GuardrailControl,
  type IncidentDecision,
  type OperationalIncident,
  type OperationalIncidentList,
  type ProductionReadiness,
  type ProductionReadinessApproval,
  type ProductionReadinessControl,
  type RecordProductionReadinessApproval,
  type ServiceConnectionSummary,
  type ConnectionMonitoringControl,
  type ModelDeployment,
  type ServiceKind,
  type UpdateProductionReadinessControl,
} from "@orcasynapse/contracts";
import {
  auditEvent,
  guardrailPolicy,
  operationalIncident,
  productionReadinessApproval,
  productionReadinessControl,
  promptTemplate,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { increment } from "../database-support.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AdminPrincipal } from "../auth/admin-session.js";
import type { ChatManager } from "../chat/chat-manager.js";
import type { ConnectionManager } from "../connections/connection-manager.js";
import type { ConnectionMonitoringManager } from "../connections/connection-monitor.js";
import type { OperationsManager } from "../operations/operations-manager.js";
import type { ToolingManager } from "../tooling/tooling-manager.js";
import type { ModelManager } from "../models/model-manager.js";
import type { AuditManager } from "../audit/audit-manager.js";
import { AiOpsConflictError, AiOpsNotFoundError, type AiOpsManager } from "./ai-ops-manager.js";

const HEALTH_FRESHNESS_MS = 15 * 60 * 1_000;
const REQUIRED_SERVICE_KINDS = ["INFERENCE", "HERMES"] as const satisfies readonly ServiceKind[];

export interface AiOpsDependencies {
  connections: ConnectionManager;
  connectionMonitoring?: ConnectionMonitoringManager;
  models?: ModelManager;
  runtime: OperationsManager;
  chat: ChatManager;
  agents: AgentManager;
  tools: ToolingManager;
  audit?: AuditManager;
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
  INFERENCE: { label: "Inference server", workflows: ["CHAT", "AGENTS"] },
  HERMES: { label: "Hermes runtime", workflows: ["AGENTS", "TOOLS"] },
  MCP: { label: "MCP gateway", workflows: ["AGENTS", "TOOLS"] },
  OIDC: { label: "Enterprise identity", workflows: ["CHAT", "AGENTS", "TOOLS"] },
  SIEM: { label: "SIEM forwarding", workflows: [] },
  NOTIFICATION: { label: "Operator notifications", workflows: [] },
  OTHER: { label: "Other service", workflows: [] },
};

interface ActiveGuardrailPolicy {
  id: string;
  displayName: string;
  version: string;
  maxInputCharacters: number;
  maxOutputCharacters: number;
  blockControlCharacters: boolean;
  blockCredentialPatterns: boolean;
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
  const enabledChecks = active
    ? Number(active.blockControlCharacters) + Number(active.blockCredentialPatterns)
    : 0;
  return [
  {
    layer: "INPUT",
    label: "Input boundary",
    status: "PARTIAL",
    summary: active
      ? `Schema, identity, rate, and ${active.maxInputCharacters.toLocaleString("en-US")}-character chat limits are locally enforced with ${enabledChecks} OrcaSynapse-native content check${enabledChecks === 1 ? "" : "s"}.`
      : "Schema, size, identity, and rate constraints are enforced; no OrcaSynapse guardrail policy is active.",
    evidence: active
      ? `Policy ${active.id} is version-pinned in PostgreSQL; semantic safety classification remains outside this deterministic baseline.`
      : "API contracts and identity-scoped request limits are enforced in the chat, agent, and tool routes.",
  },
  {
    layer: "OUTPUT",
    label: "Output boundary",
    status: active ? "PARTIAL" : "NOT_VERIFIED",
    summary: active
      ? `OrcaSynapse caps streamed responses at ${active.maxOutputCharacters.toLocaleString("en-US")} characters; semantic output classification is not claimed.`
      : "Provider responses are structurally bounded, but no output guardrail assignment is active.",
    evidence: active
      ? "Streaming failures and response-limit rejections are retained as sanitized audit events; representative model safety still requires deployment evidence."
      : "Streaming state and persistence are validated locally; safety-model evidence has not been recorded.",
  },
  {
    layer: "MODEL_ACCESS",
    label: "Model access",
    status: "ENFORCED",
    summary: "Users and agents call dashboard-approved aliases through OrcaSynapse; provider credentials remain backend-only.",
    evidence: "Versioned model routes require an enabled, healthy serving connection before activation.",
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
    summary: "OrcaSynapse uses configured internal endpoints, while infrastructure-level egress enforcement remains an on-prem acceptance gate.",
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
    : ["AGENTS"];
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

export class DrizzleAiOpsManager implements AiOpsManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly dependencies: AiOpsDependencies,
  ) {}

  /** The open-incident predicate every incident read and sweep shares. */
  private get openIncident() {
    return inArray(operationalIncident.status, ["OPEN", "ACKNOWLEDGED"]);
  }

  async overview(): Promise<AiOpsOverview> {
    const generatedAt = new Date();
    const [connections, monitoring, models, runtime, chat, agents, tools, forwarding, activeGuardrail, activePrompt] = await Promise.all([
      settled(this.dependencies.connections.list()),
      this.dependencies.connectionMonitoring ? settled(this.dependencies.connectionMonitoring.getControl()) : Promise.resolve(null),
      this.dependencies.models ? settled(this.dependencies.models.list()) : Promise.resolve(null),
      settled(this.dependencies.runtime.snapshot()),
      settled(this.dependencies.chat.metrics()),
      settled(this.dependencies.agents.metrics()),
      settled(this.dependencies.tools.metrics()),
      this.dependencies.audit ? settled(this.dependencies.audit.forwarding()) : Promise.resolve(null),
      settled(this.database
        .select({
          id: guardrailPolicy.id,
          displayName: guardrailPolicy.displayName,
          version: guardrailPolicy.version,
          maxInputCharacters: guardrailPolicy.maxInputCharacters,
          maxOutputCharacters: guardrailPolicy.maxOutputCharacters,
          blockControlCharacters: guardrailPolicy.blockControlCharacters,
          blockCredentialPatterns: guardrailPolicy.blockCredentialPatterns,
          updatedAt: guardrailPolicy.updatedAt,
        })
        .from(guardrailPolicy)
        .where(eq(guardrailPolicy.status, "ACTIVE"))
        .limit(1)
        .then(([row]) => row ?? null)),
      settled(this.database
        .select({
          id: promptTemplate.id,
          displayName: promptTemplate.displayName,
          purpose: promptTemplate.purpose,
          version: promptTemplate.version,
          contentChecksum: promptTemplate.contentChecksum,
          updatedAt: promptTemplate.updatedAt,
        })
        .from(promptTemplate)
        .where(and(eq(promptTemplate.purpose, "CHAT_SYSTEM"), eq(promptTemplate.status, "ACTIVE")))
        .limit(1)
        .then(([row]) => row ?? null)),
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
        affectedWorkflows: ["CHAT", "AGENTS", "TOOLS"],
      },
      {
        id: "hermes-run-reconciler",
        label: "Hermes run reconciler",
        status: runtime ? (runtime.status === "ONLINE" ? "HEALTHY" : "DEGRADED") : "UNAVAILABLE",
        summary: runtime ? (runtime.statusReasons[0] ?? "Queued Hermes runs have an online PostgreSQL-backed reconciler.") : "Hermes run state could not be read.",
        source: "LIVE",
        observedAt: runtime?.capturedAt ?? generatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["CHAT", "AGENTS"],
      },
    ];

    if (connections) {
      const configuredKinds = new Set(connections.map(({ kind }) => kind));
      components.push(...connections.map((connection) => configuredComponent(connection, generatedAt, monitoring)));
      components.push(...REQUIRED_SERVICE_KINDS.filter((kind) => !configuredKinds.has(kind)).map(placeholderComponent));
    } else {
      components.push({
        id: "connection-control",
        label: "Service connection control",
        status: "UNAVAILABLE",
        summary: "Dashboard-managed service connection state could not be read.",
        source: "LIVE",
        observedAt: generatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["CHAT", "AGENTS", "TOOLS"],
      });
    }
    if (forwarding) {
      // The SIEM connection's own health check says whether the endpoint is
      // reachable. It cannot say whether it is accepting the trail, so a
      // rejecting destination would otherwise read as HEALTHY here while the
      // audit view reported a failure.
      components.push({
        id: "audit-forwarding",
        label: "Audit forwarding",
        status: forwarding.status === "HEALTHY"
          ? "HEALTHY"
          : forwarding.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "DEGRADED",
        summary: forwarding.summary,
        source: "LIVE",
        observedAt: forwarding.lastAttemptAt ?? generatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: [],
      });
    }
    if (models) components.push(...models.items.map(modelComponent));
    if (activeGuardrail) {
      components.push({
        id: `guardrail:${activeGuardrail.id}`,
        label: activeGuardrail.displayName,
        status: "HEALTHY",
        summary: `OrcaSynapse-native runtime limits and ${Number(activeGuardrail.blockControlCharacters) + Number(activeGuardrail.blockCredentialPatterns)} content checks are active at version ${activeGuardrail.version}.`,
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
        // Says "released", not "active in chat": no runtime component reads a
        // prompt template — the worker builds system text from the Profile.
        summary: `Chat-system prompt v${prompt.version} is the released version; checksum ${prompt.contentChecksum.slice(0, 12)}.`,
        source: "CONFIGURATION",
        observedAt: prompt.updatedAt.toISOString(),
        latencyMs: null,
        affectedWorkflows: ["CHAT"],
      });
    }

    await this.reconcileAutomatedIncidents(components, generatedAt);
    const [incidentItems, openIncidentCount, criticalIncidentCount] = await Promise.all([
      this.database
        .select().from(operationalIncident).where(this.openIncident)
        .orderBy(desc(operationalIncident.detectedAt)).limit(20),
      this.database
        .select({ total: count() }).from(operationalIncident).where(this.openIncident)
        .then(([row]) => row?.total ?? 0),
      this.database
        .select({ total: count() }).from(operationalIncident)
        .where(and(this.openIncident, eq(operationalIncident.severity, "CRITICAL")))
        .then(([row]) => row?.total ?? 0),
    ]);
    const visibleIncidents = incidentItems.map((item) => incident(item as StoredIncident)).sort((left, right) => {
      if (left.severity !== right.severity) return left.severity === "CRITICAL" ? -1 : 1;
      return right.detectedAt.localeCompare(left.detectedAt);
    });
    const status = components.some(({ status }) => status === "UNAVAILABLE")
      ? "CRITICAL"
      : components.some(({ status }) => status !== "HEALTHY")
        ? "DEGRADED"
        : "HEALTHY";

    return {
      generatedAt: generatedAt.toISOString(),
      status,
      components,
      runtime,
      metrics: { chat, agents, tools },
      guardrails: guardrailPosture(activeGuardrail),
      incidents: {
        open: openIncidentCount,
        critical: criticalIncidentCount,
        items: visibleIncidents,
      },
    };
  }

  async listIncidents(): Promise<OperationalIncidentList> {
    const items = await this.database
      .select().from(operationalIncident)
      .orderBy(desc(operationalIncident.detectedAt)).limit(200);
    return { items: items.map((item) => incident(item as StoredIncident)) };
  }

  async createIncident(principal: AdminPrincipal, input: CreateOperationalIncident): Promise<OperationalIncident> {
    const now = new Date();
    const created = await this.database.transaction(async (transaction) => {
      const [record] = await transaction
        .insert(operationalIncident)
        .values({ ...input, automated: false, detectedAt: now, lastObservedAt: now })
        .returning();
      if (!record) throw new AiOpsConflictError("The operational incident could not be recorded.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "operations.incident_created",
        resourceType: "OperationalIncident", resourceId: record.id, outcome: "SUCCESS",
        metadata: { component: record.component, severity: record.severity },
      });
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

  async productionReadiness(): Promise<ProductionReadiness> {
    // Repeatable read keeps the controls and the approvals that reference their
    // revisions from being read across a concurrent change.
    const { storedControls, latestDecisions } = await this.database.transaction(async (transaction) => ({
      storedControls: await transaction
        .select().from(productionReadinessControl)
        .orderBy(asc(productionReadinessControl.domain), asc(productionReadinessControl.title)),
      latestDecisions: await Promise.all(READINESS_APPROVAL_ROLES.map((role) => transaction
        .select().from(productionReadinessApproval)
        .where(eq(productionReadinessApproval.role, role))
        .orderBy(desc(productionReadinessApproval.recordedAt), desc(productionReadinessApproval.id))
        .limit(1)
        .then(([row]) => row ?? null))),
    }), { isolationLevel: "repeatable read" });
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
    const updated = await this.database.transaction(async (transaction) => {
      const claimed = await transaction
        .update(productionReadinessControl)
        .set({
          status: input.status,
          owner: input.owner,
          evidenceRefs: input.evidenceRefs,
          note: input.note,
          lastUpdatedBy: principal.subject,
          verifiedAt,
          revision: increment(productionReadinessControl.revision),
        })
        .where(and(
          eq(productionReadinessControl.key, controlKey),
          eq(productionReadinessControl.revision, input.expectedRevision),
        ))
        .returning();
      const [record] = claimed;
      if (claimed.length !== 1 || !record) {
        const exists = await transaction
          .select({ key: productionReadinessControl.key }).from(productionReadinessControl)
          .where(eq(productionReadinessControl.key, controlKey)).limit(1);
        if (exists.length === 0) throw new AiOpsNotFoundError("The production-readiness control does not exist.");
        throw new AiOpsConflictError("The production-readiness control changed; refresh before recording another decision.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "production_readiness.control_updated",
        resourceType: "ProductionReadinessControl",
        resourceId: controlKey,
        outcome: input.status,
        metadata: { status: input.status, owner: input.owner, evidenceRefs: input.evidenceRefs, note: input.note },
      });
      return record;
    });
    return readinessControl(updated as StoredReadinessControl);
  }

  async recordReadinessApproval(
    principal: AdminPrincipal,
    input: RecordProductionReadinessApproval,
  ): Promise<ProductionReadinessApproval> {
    const recorded = await this.database.transaction(async (transaction) => {
      const controls = await transaction
        .select({
          key: productionReadinessControl.key,
          revision: productionReadinessControl.revision,
          status: productionReadinessControl.status,
        })
        .from(productionReadinessControl);
      const controlsAccepted = controls.length > 0 && controls.every(({ status }) => status === "VERIFIED" || status === "WAIVED");
      if (input.decision === "APPROVED" && !controlsAccepted) {
        throw new AiOpsConflictError("An approval can be recorded only after every readiness control is verified or formally waived.");
      }
      const controlRevisions = Object.fromEntries(controls.map(({ key, revision }) => [key, revision]));
      const [decision] = await transaction
        .insert(productionReadinessApproval)
        .values({ ...input, recordedBy: principal.subject, controlRevisions })
        .returning();
      if (!decision) throw new AiOpsConflictError("The readiness approval could not be recorded.");
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "production_readiness.approval_recorded",
        resourceType: "ProductionReadinessApproval",
        resourceId: decision.id,
        outcome: input.decision,
        metadata: { role: input.role, authority: input.authority, evidenceRef: input.evidenceRef, controlCount: controls.length },
      });
      return decision;
    });
    return readinessApproval(recorded as StoredReadinessApproval, true);
  }

  private async changeIncident(
    principal: AdminPrincipal,
    incidentId: string,
    expectedStatus: "OPEN" | Array<"OPEN" | "ACKNOWLEDGED">,
    data: Partial<typeof operationalIncident.$inferInsert>,
    action: string,
    decision: IncidentDecision,
  ): Promise<OperationalIncident> {
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const updated = await this.database.transaction(async (transaction) => {
      const claimed = await transaction
        .update(operationalIncident)
        .set(data)
        .where(and(
          eq(operationalIncident.id, incidentId),
          inArray(operationalIncident.status, statuses),
        ))
        .returning();
      const [record] = claimed;
      if (claimed.length !== 1 || !record) {
        const exists = await transaction
          .select({ id: operationalIncident.id }).from(operationalIncident)
          .where(eq(operationalIncident.id, incidentId)).limit(1);
        if (exists.length === 0) throw new AiOpsNotFoundError("The operational incident does not exist.");
        throw new AiOpsConflictError("The operational incident is no longer eligible for this decision.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action,
        resourceType: "OperationalIncident", resourceId: incidentId, outcome: "SUCCESS",
        metadata: { note: decision.note, owner: decision.owner ?? principal.subject },
      });
      return record;
    });
    return incident(updated as StoredIncident);
  }

  private async reconcileAutomatedIncidents(components: AiOpsComponent[], observedAt: Date): Promise<void> {
    await Promise.all(components.map(async (component) => {
      const activeFingerprint = `component:${component.id}`;
      if (component.status === "DEGRADED" || component.status === "UNAVAILABLE") {
        const title = `${component.label} is ${component.status === "UNAVAILABLE" ? "unavailable" : "degraded"}`;
        const severity = component.status === "UNAVAILABLE" ? "CRITICAL" as const : "WARNING" as const;
        // The fingerprint is unique among open incidents, so a component that
        // stays degraded refreshes one row rather than accumulating duplicates.
        await this.database
          .insert(operationalIncident)
          .values({
            activeFingerprint,
            title,
            severity,
            component: component.id,
            summary: component.summary,
            automated: true,
            detectedAt: observedAt,
            lastObservedAt: observedAt,
          })
          .onConflictDoUpdate({
            target: operationalIncident.activeFingerprint,
            set: { title, severity, summary: component.summary, lastObservedAt: observedAt },
          });
      } else {
        await this.database
          .update(operationalIncident)
          .set({
            status: "RESOLVED",
            activeFingerprint: null,
            resolvedAt: observedAt,
            resolutionNote: "Automatically resolved after the component returned to a non-degraded state.",
          })
          .where(and(eq(operationalIncident.activeFingerprint, activeFingerprint), this.openIncident));
      }
    }));
  }
}
