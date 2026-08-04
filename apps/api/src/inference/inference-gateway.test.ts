import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { InferenceGatewayChatRequest } from "@orcasynapse/contracts";
import {
  auditEvent,
  createTestDatabase,
  hermesRuntimeNode,
  inferenceGatewayRequest,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnosticStore } from "../connections/diagnostics/types.js";
import { InferenceGatewayError, DrizzleInferenceGateway } from "./inference-gateway.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const request: InferenceGatewayChatRequest = {
  model: "caller-selected-model",
  messages: [{ role: "user", content: "inspect the runtime" }],
  stream: false,
  max_tokens: 8_000,
};

const okResponse = () =>
  vi.fn(async () =>
    new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as typeof fetch;

/**
 * Provisions the connections the gateway authenticates against. Only credential
 * resolution is faked: decrypting envelope secrets belongs to the connection
 * manager, not to the gateway under test.
 */
async function harness(
  fetcher: typeof fetch = okResponse(),
  inferenceConfiguration: Record<string, unknown> = {},
) {
  const [hermesConnection] = await context.database
    .insert(serviceConnection)
    .values({
      slug: `hermes-${randomUUID().slice(0, 8)}`,
      displayName: "Hermes",
      kind: "HERMES",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "HEALTHY",
      baseUrl: "https://hermes.internal",
      configuration: {},
    })
    .returning({ id: serviceConnection.id });

  await context.database.insert(hermesRuntimeNode).values({
    slug: `node-${randomUUID().slice(0, 8)}`,
    displayName: "VM2",
    baseUrl: "https://hermes.internal",
    status: "ONLINE",
    enrolledAt: new Date(),
    lastSeenAt: new Date(),
    serviceConnectionId: hermesConnection!.id,
  });

  await context.database.insert(serviceConnection).values({
    slug: `inference-${randomUUID().slice(0, 8)}`,
    displayName: "Inference",
    kind: "INFERENCE",
    environment: "DEVELOPMENT",
    enabled: true,
    status: "HEALTHY",
    baseUrl: "https://vllm.internal",
    configuration: {},
  });

  const connections = {
    resolveForDiagnostic: vi.fn(async (id: string) =>
      id === hermesConnection!.id
        ? {
          id,
          activeRevision: 1,
          kind: "HERMES" as const,
          baseUrl: "https://hermes.internal",
          configuration: {},
          secrets: { inferenceGatewayKey: "runtime-key" },
        }
        : {
          id,
          activeRevision: 1,
          kind: "INFERENCE" as const,
          baseUrl: "https://vllm.internal",
          configuration: {
            inferenceBackend: "VLLM",
            modelAlias: "approved-agent",
            maxOutputTokens: 4_096,
            ...inferenceConfiguration,
          },
          secrets: { apiKey: "upstream-key" },
        },
    ),
    recordDiagnostic: vi.fn(),
  } as unknown as ConnectionDiagnosticStore;

  return {
    gateway: new DrizzleInferenceGateway(context.database, connections, fetcher),
    fetcher,
    hermesConnectionId: hermesConnection!.id,
  };
}

describe("DrizzleInferenceGateway", () => {
  it("rejects credentials that are not scoped to the enrolled runtime", async () => {
    const { gateway, fetcher } = await harness();

    await expect(gateway.chat("wrong-key", request, new AbortController().signal))
      .rejects.toBeInstanceOf(InferenceGatewayError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rewrites model selection, caps output, and keeps the inference key server-side", async () => {
    const { gateway, fetcher, hermesConnectionId } = await harness();

    await gateway.chat("runtime-key", request, new AbortController().signal);

    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://vllm.internal/v1/chat/completions"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer upstream-key" }),
      }),
    );
    const options = vi.mocked(fetcher).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: "approved-agent",
      max_tokens: 4_096,
      user: `hermes:${hermesConnectionId}`,
    });

    const [recorded] = await context.database
      .select({ action: auditEvent.action, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, hermesConnectionId));
    expect(recorded?.action).toBe("inference.gateway_requested");
    expect(recorded?.metadata).toMatchObject({
      modelAlias: "approved-agent",
      enforcementPlane: "ORCASYNAPSE",
    });
  });

  it("refuses a request once the runtime is at its per-minute limit", async () => {
    const { gateway, fetcher, hermesConnectionId } = await harness();
    // requestsPerMinute defaults to 30, so seed the window to its ceiling.
    await context.database.insert(inferenceGatewayRequest).values(
      Array.from({ length: 30 }, () => ({ connectionId: hermesConnectionId })),
    );

    await expect(gateway.chat("runtime-key", request, new AbortController().signal))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes max_completion_tokens to the backend's bounded max_tokens field", async () => {
    const { gateway, fetcher } = await harness();

    await gateway.chat(
      "runtime-key",
      { ...request, max_tokens: undefined, max_completion_tokens: 2_000 },
      new AbortController().signal,
    );

    const options = vi.mocked(fetcher).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toMatchObject({ max_tokens: 2_000 });
    expect(JSON.parse(String(options.body))).not.toHaveProperty("max_completion_tokens");
  });

  it("removes optional request hints that llama.cpp rejects", async () => {
    const { gateway, fetcher } = await harness(okResponse(), { inferenceBackend: "LLAMA_CPP" });

    await gateway.chat(
      "runtime-key",
      { ...request, stream: true, reasoning_effort: "medium", stream_options: { include_usage: true } },
      new AbortController().signal,
    );

    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("stream_options");
  });

  it("keeps supported hints for vLLM", async () => {
    const { gateway, fetcher } = await harness();

    await gateway.chat(
      "runtime-key",
      { ...request, stream: true, reasoning_effort: "medium" },
      new AbortController().signal,
    );

    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]!.body))).toMatchObject({
      reasoning_effort: "medium",
      stream_options: { include_usage: true },
    });
  });

  it("retries a partially compatible backend once without explicitly rejected hints", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unrecognized keys: reasoning_effort, stream_options" }), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const { gateway } = await harness(fetcher as typeof fetch, { inferenceBackend: "CUSTOM_OPENAI_COMPATIBLE" });

    await gateway.chat(
      "runtime-key",
      { ...request, stream: true, reasoning_effort: "medium" },
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    const retriedBody = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(retriedBody).not.toHaveProperty("reasoning_effort");
    expect(retriedBody).not.toHaveProperty("stream_options");
  });

  it("blocks recognizable credentials before calling the inference server", async () => {
    const { gateway, fetcher } = await harness();

    await expect(
      gateway.chat(
        "runtime-key",
        { ...request, messages: [{ role: "user", content: "-----BEGIN PRIVATE KEY-----\nsecret" }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses to serve when a suspended node leaves no eligible runtime", async () => {
    const { gateway, fetcher } = await harness();
    await context.database.update(hermesRuntimeNode).set({ status: "SUSPENDED" });

    await expect(gateway.chat("runtime-key", request, new AbortController().signal))
      .rejects.toBeInstanceOf(InferenceGatewayError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("DrizzleInferenceGateway rate-limit counter", () => {
  it("prunes its own window instead of scanning the audit trail", async () => {
    const { gateway, hermesConnectionId } = await harness();
    // A stale row from an earlier window must not count, and must not survive.
    await context.database.insert(inferenceGatewayRequest).values({
      connectionId: hermesConnectionId,
      occurredAt: new Date(Date.now() - 5 * 60 * 1_000),
    });

    await gateway.chat("runtime-key", request, new AbortController().signal);

    const rows = await context.database.select().from(inferenceGatewayRequest);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurredAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("keeps the audit trail complete while the counter stays bounded", async () => {
    const { gateway, hermesConnectionId } = await harness();

    await gateway.chat("runtime-key", request, new AbortController().signal);
    await gateway.chat("runtime-key", request, new AbortController().signal);

    // Two requests: two audit events retained, two counter rows in the window.
    const recorded = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "inference.gateway_requested");
    expect(recorded).toHaveLength(2);
    expect(recorded.every(({ resourceId }) => resourceId === hermesConnectionId)).toBe(true);
    expect(await context.database.select().from(inferenceGatewayRequest)).toHaveLength(2);
  });
});
