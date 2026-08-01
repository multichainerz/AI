import type { InferenceGatewayChatRequest } from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnosticStore } from "../connections/diagnostics/types.js";
import { InferenceGatewayError, PrismaInferenceGateway } from "./inference-gateway.js";

const request: InferenceGatewayChatRequest = {
  model: "caller-selected-model",
  messages: [{ role: "user", content: "inspect the runtime" }],
  stream: false,
  max_tokens: 8_000,
};

function harness(fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), {
  status: 200,
  headers: { "content-type": "application/json" },
})) as typeof fetch) {
  const transaction = {
    $executeRaw: vi.fn(async () => 1),
    auditEvent: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({})),
    },
  };
  const prisma = {
    serviceConnection: {
      findMany: vi.fn(async ({ where }: { where: { kind: string } }) => where.kind === "HERMES"
        ? [{ id: "11111111-1111-4111-8111-111111111111" }]
        : [{ id: "22222222-2222-4222-8222-222222222222" }]),
    },
    modelDeployment: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    guardrailPolicy: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
  } as unknown as AIHubPrismaClient;
  const connections = {
    resolveForDiagnostic: vi.fn(async (id: string) => id.startsWith("1111") ? {
      id,
      activeRevision: 1,
      kind: "HERMES" as const,
      baseUrl: "https://hermes.internal",
      configuration: {},
      secrets: { inferenceGatewayKey: "runtime-key" },
    } : {
      id,
      activeRevision: 1,
      kind: "VLLM" as const,
      baseUrl: "https://vllm.internal",
      configuration: { modelAlias: "approved-agent", maxOutputTokens: 4_096 },
      secrets: { apiKey: "upstream-key" },
    }),
    recordDiagnostic: vi.fn(),
  } as unknown as ConnectionDiagnosticStore;
  return { gateway: new PrismaInferenceGateway(prisma, connections, fetcher), fetcher, transaction };
}

describe("PrismaInferenceGateway", () => {
  it("rejects credentials that are not scoped to the enrolled runtime", async () => {
    const { gateway, fetcher } = harness();
    await expect(gateway.chat("wrong-key", request, new AbortController().signal))
      .rejects.toBeInstanceOf(InferenceGatewayError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rewrites model selection, caps output, and keeps the vLLM key server-side", async () => {
    const { gateway, fetcher, transaction } = harness();
    await gateway.chat("runtime-key", request, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith(new URL("https://vllm.internal/v1/chat/completions"), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer upstream-key" }),
    }));
    const options = vi.mocked(fetcher).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: "approved-agent",
      max_tokens: 4_096,
      user: "hermes:11111111-1111-4111-8111-111111111111",
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "inference.gateway_requested", metadata: { modelAlias: "approved-agent", enforcementPlane: "AIHUB" } }),
    }));
  });

  it("normalizes max_completion_tokens to vLLM's bounded max_tokens field", async () => {
    const { gateway, fetcher } = harness();
    await gateway.chat("runtime-key", {
      ...request,
      max_tokens: undefined,
      max_completion_tokens: 2_000,
    }, new AbortController().signal);
    const options = vi.mocked(fetcher).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toMatchObject({ max_tokens: 2_000 });
    expect(JSON.parse(String(options.body))).not.toHaveProperty("max_completion_tokens");
  });

  it("blocks recognizable credentials before calling vLLM", async () => {
    const { gateway, fetcher } = harness();
    await expect(gateway.chat("runtime-key", {
      ...request,
      messages: [{ role: "user", content: "-----BEGIN PRIVATE KEY-----\nsecret" }],
    }, new AbortController().signal)).rejects.toMatchObject({ code: "POLICY_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
