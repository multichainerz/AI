import { createHash } from "node:crypto";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { PromptConflictError } from "./prompt-manager.js";
import { PrismaPromptManager } from "./prisma-prompt-manager.js";

const PROMPT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const EVALUATION_ID = "de44bc5d-0355-4c3f-872e-1af99f356d19";
const ADMIN_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const CONTENT = "You are the approved OrcaSynapse assistant. State uncertainty and protect private data.";
const now = new Date("2026-07-30T00:00:00.000Z");
const principal = {
  id: ADMIN_ID,
  subject: "security-admin",
  role: "SECURITY_ADMIN",
  scopes: ["prompts:read", "prompts:manage"],
  createdAt: now.toISOString(),
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
} as AdminPrincipal;

function prompt(overrides: Record<string, unknown> = {}) {
  return {
    id: PROMPT_ID,
    slug: "orcasynapse-chat-system",
    displayName: "OrcaSynapse chat system",
    description: "Approved employee chat behavior.",
    purpose: "CHAT_SYSTEM" as const,
    version: "1.0.0",
    status: "DRAFT" as const,
    content: CONTENT,
    contentChecksum: createHash("sha256").update(CONTENT).digest("hex"),
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
    promptTemplate: {
      findUnique: vi.fn(async () => prompt()),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => prompt({ status: "ACTIVE", activationEvaluationId: EVALUATION_ID, firstActivatedAt: now, revision: 2 })),
    },
    evaluationRun: { findFirst: vi.fn(async () => ({ id: EVALUATION_ID })) },
    auditEvent: { create: vi.fn(async () => ({})) },
    ...overrides,
  };
}

describe("PrismaPromptManager", () => {
  it("requires a new version when prompt content changes", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      promptTemplate: { findUnique: vi.fn(async () => prompt({ status: "SUSPENDED" })), updateMany: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaPromptManager(prisma).update(principal, PROMPT_ID, {
      content: `${CONTENT} New behavior.`,
      expectedRevision: 1,
    })).rejects.toThrow("new version");
    expect(transaction.promptTemplate.updateMany).not.toHaveBeenCalled();
  });

  it("requires exact promoted chat and safety evidence", async () => {
    const transaction = activationTransaction({ evaluationRun: { findFirst: vi.fn(async () => null) } });
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaPromptManager(prisma).activate(principal, PROMPT_ID, {
      expectedRevision: 1,
      reason: "Release evaluated prompt",
    })).rejects.toThrow("prompt:orcasynapse-chat-system version 1.0.0");
    expect(transaction.evaluationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        targetType: "PROMPT",
        targetReference: "prompt:orcasynapse-chat-system",
        targetVersion: "1.0.0",
        status: "PROMOTED",
        requiredCategories: { hasEvery: ["CHAT", "SAFETY"] },
      }),
    }));
  });

  it("activates atomically and audits checksum rather than prompt content", async () => {
    const transaction = activationTransaction();
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaPromptManager(prisma).activate(principal, PROMPT_ID, {
      expectedRevision: 1,
      reason: "Approved prompt baseline",
    })).resolves.toMatchObject({ status: "ACTIVE", activationEvaluationId: EVALUATION_ID });
    const audit = (transaction.auditEvent.create.mock.calls as unknown as Array<[unknown]>)[0]?.[0];
    expect(audit).toEqual(expect.objectContaining({ data: expect.objectContaining({ action: "prompt.template_activated", metadata: expect.objectContaining({ contentChecksum: expect.any(String) }) }) }));
    expect(JSON.stringify(audit)).not.toContain(CONTENT);
  });

  it("rejects a second active prompt for the same purpose", async () => {
    const transaction = activationTransaction({
      promptTemplate: {
        ...activationTransaction().promptTemplate,
        findFirst: vi.fn(async () => ({ displayName: "Existing prompt" })),
      },
    });
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;
    await expect(new PrismaPromptManager(prisma).activate(principal, PROMPT_ID, {
      expectedRevision: 1,
      reason: "Release evaluated prompt",
    })).rejects.toBeInstanceOf(PromptConflictError);
    expect(transaction.evaluationRun.findFirst).not.toHaveBeenCalled();
  });
});
