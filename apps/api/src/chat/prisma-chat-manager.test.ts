import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agents/agent-manager.js";
import { ChatPolicyViolationError } from "./chat-manager.js";
import { acquireChatRateLimitLock, PrismaChatManager } from "./prisma-chat-manager.js";

const principal = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "user:pilot",
  identityMode: "ENTERPRISE" as const,
  scopes: ["chat:use", "agents:use"],
};

describe("Hermes-backed chat", () => {
  it("acquires the PostgreSQL rate-limit lock without deserializing a void result", async () => {
    const executeRaw = vi.fn(async (..._arguments: unknown[]) => 1);
    await acquireChatRateLimitLock(
      { $executeRaw: executeRaw } as unknown as Parameters<typeof acquireChatRateLimitLock>[0],
      "user:pilot",
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect((executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(" ")).toContain("pg_advisory_xact_lock");
    expect(executeRaw.mock.calls[0]?.[1]).toBe("orcasynapse-chat:user:pilot");
  });

  it("binds a new conversation to the active immutable Agent Profile", async () => {
    const created = {
      id: "814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd",
      title: "New conversation",
      modelAlias: "hermes-model",
      profileId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      profileName: "Hermes Analyst",
      status: "ACTIVE",
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      lastMessageAt: null,
      _count: { messages: 0 },
    };
    const transaction = {
      chatConversation: { create: vi.fn(async () => created) },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      agentProfile: { findFirst: vi.fn(async () => ({ id: created.profileId, activeVersion: 2 })) },
      agentProfileVersion: { findUnique: vi.fn(async () => ({ displayName: created.profileName, modelAlias: created.modelAlias, version: 2 })) },
      $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaChatManager(prisma, {} as AgentManager);

    await expect(manager.create(principal, {})).resolves.toMatchObject({
      profileId: created.profileId, profileName: "Hermes Analyst", modelAlias: "hermes-model",
    });
    expect(transaction.chatConversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ profileId: created.profileId, profileName: "Hermes Analyst" }),
    }));
  });

  it("audits and blocks input above the active guardrail ceiling before queuing Hermes", async () => {
    const auditCreate = vi.fn(async () => ({}));
    const prisma = {
      guardrailPolicy: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [{
          id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d", version: "1.0.0",
          maxInputCharacters: 5, maxOutputCharacters: 200_000,
          blockControlCharacters: true, blockCredentialPatterns: true,
        }]),
      },
      chatConversation: { findFirst: vi.fn(async () => ({ id: "814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd" })) },
      auditEvent: { create: auditCreate },
    } as unknown as OrcaSynapsePrismaClient;
    const agents = { submitRun: vi.fn() } as unknown as AgentManager;
    const manager = new PrismaChatManager(prisma, agents);

    await expect(manager.streamMessage(
      principal,
      "814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd",
      "123456",
      vi.fn(),
    )).rejects.toBeInstanceOf(ChatPolicyViolationError);
    expect(agents.submitRun).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "guardrail.request_blocked", metadata: expect.objectContaining({ reason: "INPUT_CHARACTER_LIMIT" }) }),
    }));
  });

  it("stops the linked durable Hermes run only through explicit cancellation", async () => {
    const conversationId = "814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd";
    const runId = "dd729774-47cb-4bd1-83d2-2ff75c6f3ec1";
    const prisma = {
      chatMessage: {
        findFirst: vi.fn(async () => ({ id: "78e3b103-3c63-41d8-a6c9-13b02369ee07", agentRunId: runId })),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
      chatConversation: { findFirst: vi.fn(async () => ({
        id: conversationId,
        title: "Pilot chat",
        modelAlias: "hermes-model",
        profileId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        profileName: "Hermes Analyst",
        status: "ACTIVE",
        createdAt: new Date("2026-08-03T00:00:00.000Z"),
        updatedAt: new Date("2026-08-03T00:00:00.000Z"),
        lastMessageAt: null,
        _count: { messages: 0 },
        messages: [],
      })) },
    } as unknown as OrcaSynapsePrismaClient;
    const agents = { cancelRun: vi.fn(async () => ({})) } as unknown as AgentManager;
    const manager = new PrismaChatManager(prisma, agents);

    await expect(manager.cancelActiveRun(principal, conversationId))
      .resolves.toMatchObject({ id: conversationId, messages: [] });
    expect(agents.cancelRun).toHaveBeenCalledWith(
      expect.objectContaining({ subject: principal.subject }),
      runId,
      false,
    );
  });
});
