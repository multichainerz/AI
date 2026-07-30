import type { AIHubPrismaClient } from "@aihub/database";
import { describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { GuardrailConflictError } from "./guardrail-manager.js";
import { PrismaGuardrailManager } from "./prisma-guardrail-manager.js";

const POLICY_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const EVALUATION_ID = "de44bc5d-0355-4c3f-872e-1af99f356d19";
const ADMIN_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const now = new Date("2026-07-30T00:00:00.000Z");
const principal = {
  id: ADMIN_ID,
  subject: "security-admin",
  role: "SECURITY_ADMIN",
  scopes: ["guardrails:read", "guardrails:manage"],
  createdAt: now.toISOString(),
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
} as AdminPrincipal;

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    slug: "chat-safety",
    displayName: "Chat safety",
    description: "Approved chat safety controls.",
    version: "1.0.0",
    status: "DRAFT" as const,
    liteLLMGuardrails: ["presidio-pii", "prompt-injection"],
    maxInputCharacters: 12_000,
    activationEvaluationId: null,
    firstActivatedAt: null,
    revision: 1,
    createdBy: ADMIN_ID,
    updatedBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function activationTransaction(overrides: Record<string, unknown> = {}) {
  return {
    $executeRaw: vi.fn(async () => 1),
    guardrailPolicy: {
      findUnique: vi.fn(async () => policy()),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => policy({ status: "ACTIVE", activationEvaluationId: EVALUATION_ID, firstActivatedAt: now, revision: 2 })),
    },
    modelDeployment: { count: vi.fn(async () => 0), findFirst: vi.fn() },
    serviceConnection: { findMany: vi.fn(async () => [{ kind: "LITELLM", enabled: true, status: "HEALTHY" }]) },
    evaluationRun: { findFirst: vi.fn(async () => ({ id: EVALUATION_ID })) },
    auditEvent: { create: vi.fn(async () => ({})) },
    ...overrides,
  };
}

describe("PrismaGuardrailManager", () => {
  it("requires a new version when assignments or limits change", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      guardrailPolicy: { findUnique: vi.fn(async () => policy({ status: "SUSPENDED" })), updateMany: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as AIHubPrismaClient;

    await expect(new PrismaGuardrailManager(prisma).update(principal, POLICY_ID, {
      liteLLMGuardrails: ["new-safety-check"],
      expectedRevision: 1,
    })).rejects.toThrow("new policy version");
    expect(transaction.guardrailPolicy.updateMany).not.toHaveBeenCalled();
  });

  it("requires exactly one healthy effective LiteLLM route", async () => {
    const transaction = activationTransaction({
      serviceConnection: { findMany: vi.fn(async () => [
        { kind: "LITELLM", enabled: true, status: "HEALTHY" },
        { kind: "LITELLM", enabled: true, status: "UNREACHABLE" },
      ]) },
    });
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as AIHubPrismaClient;

    await expect(new PrismaGuardrailManager(prisma).activate(principal, POLICY_ID, {
      expectedRevision: 1,
      reason: "Release policy",
    })).rejects.toBeInstanceOf(GuardrailConflictError);
    expect(transaction.evaluationRun.findFirst).not.toHaveBeenCalled();
  });

  it("requires exact promoted safety evidence", async () => {
    const transaction = activationTransaction({
      evaluationRun: { findFirst: vi.fn(async () => null) },
    });
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as AIHubPrismaClient;

    await expect(new PrismaGuardrailManager(prisma).activate(principal, POLICY_ID, {
      expectedRevision: 1,
      reason: "Release policy",
    })).rejects.toThrow("policy:chat-safety version 1.0.0");
    expect(transaction.evaluationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        targetType: "POLICY",
        targetReference: "policy:chat-safety",
        targetVersion: "1.0.0",
        status: "PROMOTED",
        requiredCategories: { has: "SAFETY" },
      }),
    }));
  });

  it("activates atomically and records the evidence without classifier secrets", async () => {
    const transaction = activationTransaction();
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as AIHubPrismaClient;

    await expect(new PrismaGuardrailManager(prisma).activate(principal, POLICY_ID, {
      expectedRevision: 1,
      reason: "Approved safety baseline",
    })).resolves.toMatchObject({ status: "ACTIVE", activationEvaluationId: EVALUATION_ID });
    expect(transaction.guardrailPolicy.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ACTIVE", activationEvaluationId: EVALUATION_ID, revision: { increment: 1 } }),
    }));
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "guardrail.policy_activated", metadata: expect.objectContaining({ evaluationRunId: EVALUATION_ID }) }),
    }));
  });
});
