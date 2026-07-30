import type { AIHubPrismaClient } from "@aihub/database";
import { describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { ModelConflictError } from "./model-manager.js";
import { PrismaModelManager } from "./prisma-model-manager.js";

const MODEL_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const CONNECTION_ID = "5277951c-7d22-4cec-8d46-fad3afba37dd";
const EVALUATION_ID = "de44bc5d-0355-4c3f-872e-1af99f356d19";
const ADMIN_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const now = new Date("2026-07-30T00:00:00.000Z");
const principal = {
  id: ADMIN_ID,
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: ["models:read", "models:manage"],
  createdAt: now.toISOString(),
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
} as AdminPrincipal;
const connection = {
  id: CONNECTION_ID,
  displayName: "LiteLLM Primary",
  kind: "LITELLM" as const,
  environment: "PRODUCTION" as const,
  enabled: true,
  status: "HEALTHY" as const,
};

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: MODEL_ID,
    slug: "laguna-hermes",
    displayName: "Laguna Hermes",
    modelAlias: "hermes-agent",
    workload: "AGENT" as const,
    status: "DRAFT" as const,
    connectionId: CONNECTION_ID,
    version: "2.1-nvfp4",
    license: "MPM approved",
    contextWindowTokens: 131_072,
    maxOutputTokens: 8_192,
    maxConcurrentRequests: 2,
    isDefault: false,
    activationEvaluationId: null,
    firstActivatedAt: null,
    revision: 1,
    createdBy: ADMIN_ID,
    updatedBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
    connection,
    ...overrides,
  };
}

describe("PrismaModelManager", () => {
  it("rejects a workload connected to the wrong service type", async () => {
    const prisma = {
      serviceConnection: { findUnique: vi.fn(async () => ({ ...connection, kind: "OIDC" })) },
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaModelManager(prisma);

    await expect(manager.create(principal, {
      slug: "laguna-chat",
      displayName: "Laguna Chat",
      modelAlias: "chat-primary",
      workload: "CHAT",
      connectionId: CONNECTION_ID,
      version: "2.1",
      license: null,
      contextWindowTokens: 131_072,
      maxOutputTokens: 4_096,
      maxConcurrentRequests: 4,
    })).rejects.toBeInstanceOf(ModelConflictError);
  });

  it("requires a new declared version for material route changes", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      modelDeployment: {
        findUnique: vi.fn(async () => model({ status: "SUSPENDED" })),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaModelManager(prisma);

    await expect(manager.update(principal, MODEL_ID, {
      modelAlias: "hermes-agent-v2",
      expectedRevision: 1,
    })).rejects.toThrow("new model version");
    expect(transaction.modelDeployment.updateMany).not.toHaveBeenCalled();
  });

  it("requires exact promoted model evidence before activation", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      modelDeployment: { findUnique: vi.fn(async () => model()) },
      evaluationRun: { findFirst: vi.fn(async () => null) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;

    await expect(new PrismaModelManager(prisma).activate(principal, MODEL_ID, {
      expectedRevision: 1,
      reason: "Promote for pilot",
      makeDefault: true,
    })).rejects.toThrow("model:laguna-hermes version 2.1-nvfp4");
  });

  it("atomically assigns the default and retains activation evidence", async () => {
    const active = model({
      status: "ACTIVE",
      isDefault: true,
      activationEvaluationId: EVALUATION_ID,
      firstActivatedAt: now,
      revision: 2,
    });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({}));
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      modelDeployment: {
        findUnique: vi.fn(async () => model()),
        updateMany,
        findUniqueOrThrow: vi.fn(async () => active),
      },
      evaluationRun: { findFirst: vi.fn(async () => ({ id: EVALUATION_ID })) },
      auditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;

    await expect(new PrismaModelManager(prisma).activate(principal, MODEL_ID, {
      expectedRevision: 1,
      reason: "Approved for bounded pilot",
      makeDefault: true,
    })).resolves.toMatchObject({ status: "ACTIVE", isDefault: true, activationEvaluationId: EVALUATION_ID });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workload: "AGENT", isDefault: true },
      data: { isDefault: false, revision: { increment: 1 } },
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "model.route_activated", metadata: expect.objectContaining({ evaluationRunId: EVALUATION_ID }) }),
    }));
  });
});
