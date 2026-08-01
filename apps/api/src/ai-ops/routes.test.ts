import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type AiOpsOverview,
  type EvaluationRun,
  type OperationalIncident,
  type ProductionReadiness,
  type ProductionReadinessApproval,
  type ProductionReadinessControl,
} from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { AiOpsConflictError, type AiOpsManager } from "./ai-ops-manager.js";

const TOKEN = "o".repeat(43);
const SESSION_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const INCIDENT_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const EVALUATION_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const timestamp = "2026-07-30T00:00:00.000Z";
const principal: AdministratorSession = {
  id: SESSION_ID,
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: timestamp,
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? principal : null; }
  async revoke() { return true; }
}

const incident: OperationalIncident = {
  id: INCIDENT_ID,
  title: "vLLM unavailable",
  severity: "CRITICAL",
  status: "OPEN",
  component: "connection:vllm",
  summary: "vLLM did not pass its last connection check.",
  owner: null,
  automated: true,
  detectedAt: timestamp,
  lastObservedAt: timestamp,
  acknowledgedAt: null,
  resolvedAt: null,
  resolutionNote: null,
};

const evaluation: EvaluationRun = {
  id: EVALUATION_ID,
  name: "Hermes analyst v1",
  targetType: "AGENT",
  targetReference: "agent:hermes-analyst",
  targetVersion: "1",
  status: "DRAFT",
  minimumPassRate: 0.95,
  requiredCategories: ["SAFETY", "PERMISSIONS"],
  results: [],
  totalCases: 0,
  passedCases: 0,
  criticalFailures: 0,
  passRate: null,
  createdAt: timestamp,
  completedAt: null,
  promotedAt: null,
  promotionReason: null,
};

const readinessControl: ProductionReadinessControl = {
  key: "security-threat-model",
  title: "Threat model and security review",
  domain: "SECURITY",
  description: "MPM Security reviews the intended pilot scope.",
  status: "NOT_STARTED",
  owner: null,
  evidenceRefs: [],
  note: null,
  lastUpdatedBy: null,
  verifiedAt: null,
  revision: 0,
  updatedAt: timestamp,
};

const readinessApproval: ProductionReadinessApproval = {
  id: "c43149d0-a76d-43ee-932e-7a4d527673e8",
  role: "SECURITY",
  decision: "APPROVED",
  authority: "MPM Security Review Board",
  evidenceRef: "approval/security/2026-07-30",
  reason: "Approved for the bounded pilot scope.",
  recordedBy: "platform-admin",
  recordedAt: timestamp,
  isCurrent: true,
};

const readiness: ProductionReadiness = {
  generatedAt: timestamp,
  status: "NOT_READY",
  controls: [readinessControl],
  approvals: [],
  summary: { totalControls: 1, verifiedControls: 0, waivedControls: 0, blockedControls: 0, requiredApprovals: 4, approvedRoles: 0 },
  blockers: ["Control incomplete: Threat model and security review", "SECURITY approval not recorded"],
};

const overview: AiOpsOverview = {
  generatedAt: timestamp,
  status: "DEGRADED",
  components: [{
    id: "postgresql", label: "PostgreSQL", status: "HEALTHY", summary: "Live query succeeded.",
    source: "LIVE", observedAt: timestamp, latencyMs: null, affectedWorkflows: ["CHAT"],
  }],
  runtime: null,
  metrics: { chat: null, documents: null, memory: null, agents: null, tools: null },
  guardrails: [],
  incidents: { open: 1, critical: 1, items: [incident] },
  evaluations: { drafts: 1, passed: 0, failed: 0, promoted: 0 },
};

function fakeManager(): AiOpsManager {
  return {
    overview: vi.fn(async () => overview),
    listIncidents: vi.fn(async () => ({ items: [incident] })),
    createIncident: vi.fn(async () => incident),
    acknowledgeIncident: vi.fn(async (): Promise<OperationalIncident> => ({ ...incident, status: "ACKNOWLEDGED", acknowledgedAt: timestamp })),
    resolveIncident: vi.fn(async (): Promise<OperationalIncident> => ({ ...incident, status: "RESOLVED", resolvedAt: timestamp })),
    listEvaluations: vi.fn(async () => ({ items: [evaluation] })),
    createEvaluation: vi.fn(async () => evaluation),
    completeEvaluation: vi.fn(async (): Promise<EvaluationRun> => ({ ...evaluation, status: "PASSED", completedAt: timestamp })),
    promoteEvaluation: vi.fn(async (): Promise<EvaluationRun> => ({ ...evaluation, status: "PROMOTED", completedAt: timestamp, promotedAt: timestamp, promotionReason: "Approved for the controlled pilot." })),
    productionReadiness: vi.fn(async () => readiness),
    updateReadinessControl: vi.fn(async (): Promise<ProductionReadinessControl> => ({ ...readinessControl, status: "IN_PROGRESS", owner: "Security", revision: 1 })),
    recordReadinessApproval: vi.fn(async () => readinessApproval),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function harness(manager = fakeManager()) {
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions(), aiOpsManager: manager } });
  apps.push(app);
  return { app, manager };
}

describe("AI operations routes", () => {
  it("fails closed and returns a schema-bounded overview", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/operations/overview" })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/operations/overview", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "DEGRADED", incidents: { critical: 1 } });
  });

  it("validates identifiers before incident and evaluation decisions", async () => {
    const { app, manager } = await harness();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/operations/incidents/not-a-uuid/resolve", headers, payload: { note: "Recovered cleanly." } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/operations/evaluations/not-a-uuid/promote", headers })).statusCode).toBe(400);
    expect(manager.resolveIncident).not.toHaveBeenCalled();
    expect(manager.promoteEvaluation).not.toHaveBeenCalled();
  });

  it("keeps evidence conflicts explicit", async () => {
    const manager = fakeManager();
    vi.mocked(manager.promoteEvaluation).mockRejectedValueOnce(new AiOpsConflictError("Evidence has not passed."));
    const { app } = await harness(manager);
    const response = await app.inject({ method: "POST", url: `/api/v1/admin/operations/evaluations/${EVALUATION_ID}/promote`, headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` }, payload: { reason: "Approved for the controlled pilot." } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "CONFLICT" });
  });

  it("requires a promotion rationale before invoking the release decision", async () => {
    const { app, manager } = await harness();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/operations/evaluations/${EVALUATION_ID}/promote`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_PROMOTION" });
    expect(manager.promoteEvaluation).not.toHaveBeenCalled();
  });

  it("returns production readiness and validates optimistic control updates", async () => {
    const { app, manager } = await harness();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    const summary = await app.inject({ method: "GET", url: "/api/v1/admin/operations/readiness", headers });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ status: "NOT_READY", summary: { totalControls: 1 } });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/operations/readiness/controls/security-threat-model",
      headers,
      payload: { status: "VERIFIED", owner: "Security", evidenceRefs: [], note: "Done", expectedRevision: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(manager.updateReadinessControl).not.toHaveBeenCalled();
  });

  it("records an external approval without conflating its authority with the recorder", async () => {
    const { app, manager } = await harness();
    const input = {
      role: "SECURITY",
      decision: "APPROVED",
      authority: "MPM Security Review Board",
      evidenceRef: "approval/security/2026-07-30",
      reason: "Approved for the bounded pilot scope.",
    } as const;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/operations/readiness/approvals",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ authority: input.authority, recordedBy: "platform-admin" });
    expect(manager.recordReadinessApproval).toHaveBeenCalledWith(principal, input);
  });

  it("keeps premature approval conflicts explicit", async () => {
    const manager = fakeManager();
    vi.mocked(manager.recordReadinessApproval).mockRejectedValueOnce(new AiOpsConflictError("Readiness controls are incomplete."));
    const { app } = await harness(manager);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/operations/readiness/approvals",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: { role: "SECURITY", decision: "APPROVED", authority: "MPM Security", evidenceRef: "approval/security", reason: "Approved for pilot." },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "CONFLICT" });
  });
});
