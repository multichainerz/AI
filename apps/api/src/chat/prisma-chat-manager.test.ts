import type { AIHubPrismaClient } from "@aihub/database";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnosticStore } from "../connections/diagnostics/types.js";
import { ChatConfigurationError, ChatPolicyViolationError } from "./chat-manager.js";
import { boundedContextMessages, PrismaChatManager } from "./prisma-chat-manager.js";

describe("chat context bounding", () => {
  it("keeps the newest complete messages within the character budget and restores chronology", () => {
    const result = boundedContextMessages([
      { role: "USER", content: "latest-user" },
      { role: "ASSISTANT", content: "recent-answer" },
      { role: "USER", content: "old-question" },
    ], 25);

    expect(result).toEqual([
      { role: "assistant", content: "recent-answer" },
      { role: "user", content: "latest-user" },
    ]);
  });

  it("fails closed when a catalogue exists without an active default chat route", async () => {
    const prisma = {
      promptTemplate: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      guardrailPolicy: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => []),
      },
      modelDeployment: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => []),
      },
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaChatManager(prisma, {} as ConnectionDiagnosticStore);

    await expect(manager.create({
      id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
    }, {})).rejects.toBeInstanceOf(ChatConfigurationError);
    expect(prisma.modelDeployment.count).toHaveBeenCalledWith({
      where: { workload: "CHAT", firstActivatedAt: { not: null } },
    });
    expect(prisma.modelDeployment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workload: "CHAT", status: "ACTIVE", isDefault: true },
    }));
  });

  it("fails closed after first policy activation when no policy remains active", async () => {
    const prisma = {
      promptTemplate: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      guardrailPolicy: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => []),
      },
      modelDeployment: { count: vi.fn(), findMany: vi.fn() },
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaChatManager(prisma, {} as ConnectionDiagnosticStore);

    await expect(manager.create({
      id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
    }, {})).rejects.toThrow("Activate one evaluated chat policy");
    expect(prisma.guardrailPolicy.count).toHaveBeenCalledWith({ where: { firstActivatedAt: { not: null } } });
    expect(prisma.modelDeployment.count).not.toHaveBeenCalled();
  });

  it("fails closed after prompt governance is adopted when no chat prompt is active", async () => {
    const prisma = {
      promptTemplate: { count: vi.fn(async () => 1), findMany: vi.fn(async () => []) },
      guardrailPolicy: { count: vi.fn(), findMany: vi.fn() },
      modelDeployment: { count: vi.fn(), findMany: vi.fn() },
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaChatManager(prisma, {} as ConnectionDiagnosticStore);

    await expect(manager.create({
      id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
    }, {})).rejects.toThrow("Activate one evaluated chat-system prompt");
    expect(prisma.guardrailPolicy.count).not.toHaveBeenCalled();
  });

  it("audits and blocks input above the active policy ceiling before inference", async () => {
    const auditCreate = vi.fn(async () => ({}));
    const prisma = {
      promptTemplate: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      guardrailPolicy: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [{
          id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
          version: "1.0.0",
          liteLLMGuardrails: ["presidio-pii"],
          maxInputCharacters: 5,
        }]),
      },
      modelDeployment: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [{ connectionId: "5277951c-7d22-4cec-8d46-fad3afba37dd", modelAlias: "chat-primary", maxOutputTokens: 2048 }]),
      },
      serviceConnection: { findMany: vi.fn(async () => [{ id: "5277951c-7d22-4cec-8d46-fad3afba37dd", status: "HEALTHY" }]) },
      chatConversation: { findFirst: vi.fn(async () => ({ id: "814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd" })) },
      auditEvent: { create: auditCreate },
    } as unknown as AIHubPrismaClient;
    const connections = {
      resolveForDiagnostic: vi.fn(async () => ({
        id: "5277951c-7d22-4cec-8d46-fad3afba37dd",
        baseUrl: "https://litellm.mpm.internal",
        configuration: {},
        secrets: { apiKey: "secret" },
      })),
    } as unknown as ConnectionDiagnosticStore;
    const manager = new PrismaChatManager(prisma, connections);

    await expect(manager.streamMessage({
      id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
      subject: "user:pilot",
      identityMode: "ENTERPRISE",
    }, "814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd", "123456", new AbortController().signal, vi.fn()))
      .rejects.toBeInstanceOf(ChatPolicyViolationError);
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "guardrail.request_blocked", metadata: expect.objectContaining({ reason: "INPUT_CHARACTER_LIMIT", maxInputCharacters: 5 }) }),
    }));
  });
});
