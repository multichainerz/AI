import type {
  ConnectionMonitoringControl,
  ModelDeployment,
  ServiceConnectionSummary,
} from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import { describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { AiOpsConflictError } from "./ai-ops-manager.js";
import { PrismaAiOpsManager } from "./prisma-ai-ops-manager.js";

const EVALUATION_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const SESSION_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const now = new Date("2026-07-30T00:00:00.000Z");
const principal: AdminPrincipal = {
  id: SESSION_ID,
  subject: "security-admin",
  role: "SECURITY_ADMIN",
  scopes: ["evaluations:read", "evaluations:manage", "evaluations:promote"],
  createdAt: now.toISOString(),
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

function operationsOverviewHarness(
  connection: ServiceConnectionSummary,
  monitoring: ConnectionMonitoringControl,
  models: ModelDeployment[] = [],
  activeGuardrail: {
    id: string;
    displayName: string;
    version: string;
    liteLLMGuardrails: string[];
    maxInputCharacters: number;
    updatedAt: Date;
  } | null = null,
  activePrompt: {
    id: string;
    displayName: string;
    purpose: "CHAT_SYSTEM";
    version: string;
    contentChecksum: string;
    updatedAt: Date;
  } | null = null,
) {
  const operationalIncident = {
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  };
  const prisma = {
    operationalIncident,
    evaluationRun: { groupBy: vi.fn(async () => []) },
    guardrailPolicy: { findFirst: vi.fn(async () => activeGuardrail) },
    promptTemplate: { findFirst: vi.fn(async () => activePrompt) },
  } as unknown as AIHubPrismaClient;
  const metrics = { metrics: vi.fn(async () => ({})) };
  const dependencies = {
    connections: { list: vi.fn(async () => [connection]) },
    connectionMonitoring: { getControl: vi.fn(async () => monitoring) },
    models: { list: vi.fn(async () => ({ items: models })) },
    jobs: { snapshot: vi.fn(async () => ({
      status: "ONLINE",
      statusReasons: [],
      capturedAt: new Date().toISOString(),
    })) },
    chat: metrics,
    documents: metrics,
    memory: metrics,
    agents: metrics,
    tools: metrics,
  };
  return new PrismaAiOpsManager(prisma, dependencies as never);
}

describe("PrismaAiOpsManager scheduled connection evidence", () => {
  const connection = (lastHealthcheckAt: string): ServiceConnectionSummary => ({
    id: "5277951c-7d22-4cec-8d46-fad3afba37dd",
    slug: "litellm-primary",
    displayName: "LiteLLM Primary",
    kind: "LITELLM",
    environment: "PRODUCTION",
    baseUrl: "https://litellm.mpm.internal",
    enabled: true,
    status: "HEALTHY",
    configuration: {},
    activeRevision: 1,
    secretFieldNames: ["apiKey"],
    lastHealthcheckAt,
    lastHealthcheckMessage: "Credential-aware check passed.",
    updatedAt: lastHealthcheckAt,
  });
  const monitoring: ConnectionMonitoringControl = {
    enabled: true,
    intervalSeconds: 300,
    reason: "Monitor pilot dependencies.",
    updatedAt: new Date().toISOString(),
    updatedBy: SESSION_ID,
  };

  it("reports a recent scheduled check as live evidence", async () => {
    const manager = operationsOverviewHarness(connection(new Date().toISOString()), monitoring);

    const overview = await manager.overview();

    expect(overview.components.find(({ id }) => id.startsWith("connection:"))).toMatchObject({
      status: "HEALTHY",
      source: "LIVE",
    });
  });

  it("downgrades an overdue scheduled check without presenting it as live", async () => {
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
    const manager = operationsOverviewHarness(connection(elevenMinutesAgo), monitoring);

    const overview = await manager.overview();

    expect(overview.components.find(({ id }) => id.startsWith("connection:"))).toMatchObject({
      status: "NOT_VERIFIED",
      source: "LAST_VERIFIED",
      summary: "The scheduled connection check is overdue.",
    });
  });

  it("includes evaluated active model routes in the central component view", async () => {
    const observedAt = new Date().toISOString();
    const manager = operationsOverviewHarness(connection(observedAt), monitoring, [{
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "laguna-chat",
      displayName: "Laguna Chat",
      modelAlias: "chat-primary",
      workload: "CHAT",
      status: "ACTIVE",
      connection: { id: "5277951c-7d22-4cec-8d46-fad3afba37dd", displayName: "LiteLLM Primary", kind: "LITELLM", environment: "PRODUCTION", enabled: true, status: "HEALTHY" },
      version: "2.1-nvfp4",
      license: null,
      contextWindowTokens: 131_072,
      maxOutputTokens: 8_192,
      maxConcurrentRequests: 4,
      isDefault: true,
      activationEvaluationId: EVALUATION_ID,
      firstActivatedAt: observedAt,
      revision: 2,
      createdBy: SESSION_ID,
      updatedBy: SESSION_ID,
      createdAt: observedAt,
      updatedAt: observedAt,
    }]);

    const overview = await manager.overview();

    expect(overview.components.find(({ id }) => id.startsWith("model:"))).toMatchObject({
      status: "HEALTHY",
      source: "CONFIGURATION",
      affectedWorkflows: ["CHAT"],
    });
  });

  it("reports the evaluated active policy and its LiteLLM assignment posture", async () => {
    const observedAt = new Date().toISOString();
    const manager = operationsOverviewHarness(connection(observedAt), monitoring, [], {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      displayName: "Chat safety",
      version: "1.0.0",
      liteLLMGuardrails: ["presidio-pii", "prompt-injection"],
      maxInputCharacters: 12_000,
      updatedAt: new Date(observedAt),
    });

    const overview = await manager.overview();

    expect(overview.components.find(({ id }) => id.startsWith("guardrail:"))).toMatchObject({
      status: "HEALTHY",
      affectedWorkflows: ["CHAT"],
    });
    expect(overview.guardrails.find(({ layer }) => layer === "INPUT")?.summary).toContain("12,000-character");
    expect(overview.guardrails.find(({ layer }) => layer === "OUTPUT")?.summary).toContain("2 approved LiteLLM guardrails");
  });

  it("reports the evaluated active chat-system prompt without exposing its content", async () => {
    const observedAt = new Date().toISOString();
    const manager = operationsOverviewHarness(connection(observedAt), monitoring, [], null, {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      displayName: "MPM chat system",
      purpose: "CHAT_SYSTEM",
      version: "1.0.0",
      contentChecksum: "a".repeat(64),
      updatedAt: new Date(observedAt),
    });

    const component = (await manager.overview()).components.find(({ id }) => id.startsWith("prompt:"));
    expect(component).toMatchObject({ status: "HEALTHY", source: "CONFIGURATION", affectedWorkflows: ["CHAT"] });
    expect(component?.summary).toContain("checksum aaaaaaaaaaaa");
  });
});

function draftEvaluation() {
  return {
    id: EVALUATION_ID,
    name: "Hermes analyst v1",
    targetType: "AGENT" as const,
    targetReference: "agent:hermes-analyst",
    targetVersion: "1",
    status: "DRAFT" as const,
    minimumPassRate: 0.9,
    requiredCategories: ["SAFETY", "PERMISSIONS"],
    categoryResults: [],
    totalCases: 0,
    passedCases: 0,
    criticalFailures: 0,
    createdAt: now,
    completedAt: null,
    promotedAt: null,
    promotionReason: null,
  };
}

describe("PrismaAiOpsManager evaluation gates", () => {
  it("passes only when every required category meets the threshold with retained evidence", async () => {
    let updateData: Record<string, unknown> = {};
    const transaction = {
      evaluationRun: {
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updateData = data;
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => ({ ...draftEvaluation(), ...updateData })),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      evaluationRun: { findUnique: vi.fn(async () => draftEvaluation()) },
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);

    const completed = await manager.completeEvaluation(principal, EVALUATION_ID, { results: [
      { category: "SAFETY", totalCases: 10, passedCases: 9, criticalFailures: 0, evidenceRefs: ["eval/safety.json"] },
      { category: "PERMISSIONS", totalCases: 20, passedCases: 20, criticalFailures: 0, evidenceRefs: ["eval/permissions.json"] },
    ] });

    expect(completed).toMatchObject({ status: "PASSED", totalCases: 30, passedCases: 29, criticalFailures: 0 });
    expect(completed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "SAFETY", passRate: 0.9, status: "PASSED" }),
      expect.objectContaining({ category: "PERMISSIONS", passRate: 1, status: "PASSED" }),
    ]));
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "evaluation.evidence_recorded", outcome: "PASSED" }),
    }));
  });

  it("fails closed when required or unexpected categories do not match the gate", async () => {
    const transaction = vi.fn();
    const prisma = {
      evaluationRun: { findUnique: vi.fn(async () => draftEvaluation()) },
      $transaction: transaction,
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);

    await expect(manager.completeEvaluation(principal, EVALUATION_ID, { results: [
      { category: "SAFETY", totalCases: 10, passedCases: 10, criticalFailures: 0, evidenceRefs: ["eval/safety.json"] },
    ] })).rejects.toBeInstanceOf(AiOpsConflictError);
    await expect(manager.completeEvaluation(principal, EVALUATION_ID, { results: [
      { category: "SAFETY", totalCases: 10, passedCases: 10, criticalFailures: 0, evidenceRefs: ["eval/safety.json"] },
      { category: "PERMISSIONS", totalCases: 10, passedCases: 10, criticalFailures: 0, evidenceRefs: ["eval/permissions.json"] },
      { category: "CHAT", totalCases: 10, passedCases: 10, criticalFailures: 0, evidenceRefs: ["eval/chat.json"] },
    ] })).rejects.toBeInstanceOf(AiOpsConflictError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("marks a category and candidate failed when the threshold is missed", async () => {
    let updateData: Record<string, unknown> = {};
    const transaction = {
      evaluationRun: {
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { updateData = data; return { count: 1 }; }),
        findUniqueOrThrow: vi.fn(async () => ({ ...draftEvaluation(), ...updateData })),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      evaluationRun: { findUnique: vi.fn(async () => draftEvaluation()) },
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);

    const completed = await manager.completeEvaluation(principal, EVALUATION_ID, { results: [
      { category: "SAFETY", totalCases: 10, passedCases: 8, criticalFailures: 0, evidenceRefs: ["eval/safety.json"] },
      { category: "PERMISSIONS", totalCases: 10, passedCases: 10, criticalFailures: 0, evidenceRefs: ["eval/permissions.json"] },
    ] });

    expect(completed.status).toBe("FAILED");
    expect(completed.results.find(({ category }) => category === "SAFETY")?.status).toBe("FAILED");
  });

  it("retains and audits the rationale for an atomic promotion decision", async () => {
    let updateData: Record<string, unknown> = {};
    const transaction = {
      evaluationRun: {
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { updateData = data; return { count: 1 }; }),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(async () => ({
          ...draftEvaluation(),
          status: "PASSED",
          categoryResults: [
            { category: "SAFETY", totalCases: 10, passedCases: 10, criticalFailures: 0, evidenceRefs: ["eval/safety.json"], passRate: 1, status: "PASSED" },
            { category: "PERMISSIONS", totalCases: 10, passedCases: 10, criticalFailures: 0, evidenceRefs: ["eval/permissions.json"], passRate: 1, status: "PASSED" },
          ],
          totalCases: 20,
          passedCases: 20,
          completedAt: now,
          ...updateData,
        })),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);
    const reason = "Approved for the controlled MPM pilot.";

    const promoted = await manager.promoteEvaluation(principal, EVALUATION_ID, { reason });

    expect(promoted).toMatchObject({ status: "PROMOTED", promotionReason: reason });
    expect(transaction.evaluationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: EVALUATION_ID, status: "PASSED", criticalFailures: 0 },
      data: expect.objectContaining({ status: "PROMOTED", promotedBy: SESSION_ID, promotionReason: reason }),
    }));
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "evaluation.candidate_promoted", metadata: { reason } }),
    }));
  });
});

describe("PrismaAiOpsManager production readiness", () => {
  const verifiedControl = {
    key: "security-threat-model",
    title: "Threat model and security review",
    domain: "SECURITY" as const,
    description: "MPM Security reviews the intended pilot scope.",
    status: "VERIFIED" as const,
    owner: "MPM Security",
    evidenceRefs: ["evidence/security-review.pdf"],
    note: "Review completed.",
    lastUpdatedBy: "security-admin",
    verifiedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };

  it("reports ready only when every control and latest required authority decision is accepted", async () => {
    const approvals = (["SECURITY", "INFRASTRUCTURE", "PRODUCT", "BUSINESS"] as const).map((role, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      role,
      decision: "APPROVED" as const,
      authority: `MPM ${role}`,
      evidenceRef: `approvals/${role.toLowerCase()}`,
      reason: "Approved for the bounded pilot.",
      recordedBy: "platform-admin",
      recordedAt: now,
      controlRevisions: { [verifiedControl.key]: verifiedControl.revision },
    }));
    const transaction = {
      productionReadinessControl: { findMany: vi.fn(async () => [verifiedControl]) },
      productionReadinessApproval: { findFirst: vi.fn(async ({ where }: { where: { role: string } }) => approvals.find(({ role }) => role === where.role) ?? null) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);

    const readiness = await manager.productionReadiness();

    expect(readiness).toMatchObject({ status: "READY", summary: { totalControls: 1, verifiedControls: 1, approvedRoles: 4 } });
    expect(readiness.blockers).toEqual([]);
  });

  it("updates a control with optimistic concurrency and an audit event", async () => {
    const updated = { ...verifiedControl, revision: 2 };
    const transaction = {
      productionReadinessControl: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(async () => updated),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);
    const input = {
      status: "VERIFIED" as const,
      owner: "MPM Security",
      evidenceRefs: ["evidence/security-review.pdf"],
      note: "Review completed.",
      expectedRevision: 1,
    };

    const result = await manager.updateReadinessControl(principal, verifiedControl.key, input);

    expect(result).toMatchObject({ status: "VERIFIED", revision: 2, lastUpdatedBy: "security-admin" });
    expect(transaction.productionReadinessControl.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: verifiedControl.key, revision: 1 },
      data: expect.objectContaining({ revision: { increment: 1 }, verifiedAt: expect.any(Date) }),
    }));
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "production_readiness.control_updated", outcome: "VERIFIED" }),
    }));
  });

  it("invalidates an approval snapshot when readiness evidence changes", async () => {
    const staleApproval = {
      id: "c43149d0-a76d-43ee-932e-7a4d527673e8",
      role: "SECURITY" as const,
      decision: "APPROVED" as const,
      authority: "MPM Security",
      evidenceRef: "approvals/security",
      reason: "Approved before the evidence changed.",
      recordedBy: "platform-admin",
      recordedAt: now,
      controlRevisions: { [verifiedControl.key]: 0 },
    };
    const transaction = {
      productionReadinessControl: { findMany: vi.fn(async () => [verifiedControl]) },
      productionReadinessApproval: { findFirst: vi.fn(async ({ where }: { where: { role: string } }) => where.role === "SECURITY" ? staleApproval : null) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);

    const readiness = await manager.productionReadiness();

    expect(readiness.status).toBe("NOT_READY");
    expect(readiness.approvals[0]).toMatchObject({ role: "SECURITY", decision: "APPROVED", isCurrent: false });
    expect(readiness.blockers).toContain("SECURITY approval is stale after readiness evidence changed");
  });

  it("binds a recorded approval to the exact accepted control revisions", async () => {
    const approvalId = "c43149d0-a76d-43ee-932e-7a4d527673e8";
    let createData: Record<string, unknown> = {};
    const transaction = {
      productionReadinessControl: { findMany: vi.fn(async () => [{ key: verifiedControl.key, revision: 1, status: "VERIFIED" }]) },
      productionReadinessApproval: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createData = data;
        return { id: approvalId, recordedAt: now, ...data };
      }) },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);
    const input = { role: "SECURITY" as const, decision: "APPROVED" as const, authority: "MPM Security", evidenceRef: "approvals/security", reason: "Approved for the bounded pilot." };

    const approval = await manager.recordReadinessApproval(principal, input);

    expect(createData).toMatchObject({ recordedBy: "security-admin", controlRevisions: { [verifiedControl.key]: 1 } });
    expect(approval).toMatchObject({ role: "SECURITY", decision: "APPROVED", isCurrent: true });
  });

  it("rejects an approval while any readiness control is incomplete", async () => {
    const transaction = {
      productionReadinessControl: { findMany: vi.fn(async () => [{ key: "security-penetration-test", revision: 0, status: "NOT_STARTED" }]) },
      productionReadinessApproval: { create: vi.fn() },
      auditEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaAiOpsManager(prisma, {} as never);

    await expect(manager.recordReadinessApproval(principal, {
      role: "SECURITY",
      decision: "APPROVED",
      authority: "MPM Security",
      evidenceRef: "approvals/security",
      reason: "Approved for the bounded pilot.",
    })).rejects.toBeInstanceOf(AiOpsConflictError);
    expect(transaction.productionReadinessApproval.create).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
  });
});
