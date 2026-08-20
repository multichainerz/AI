import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { InferenceGatewayChatRequest } from "@orcasynapse/contracts";
import {
  auditEvent,
  createTestDatabase,
  guardrailPolicy,
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
afterAll(async () => { await context?.drop(); }, 120_000);
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

const streamedResponse = () =>
  vi.fn(async () =>
    new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  ) as typeof fetch;

/**
 * Wire bytes one streamed token actually costs, measured against a real vLLM
 * SSE stream: `data: ` plus a full chat-completion envelope plus `\n\n`, about
 * 231 bytes carrying roughly four characters of content.
 */
const MEASURED_SSE_BYTES_PER_TOKEN = 231;

/**
 * An endless chunked 400, with counters for how much of it reached the process
 * and whether the upstream body was released.
 *
 * `content-length` is deliberately absent — that is what a chunked error
 * response looks like, and `Number(null)` is 0, so the declared-length guard
 * never fires on one. The source never closes, so only a cancel can end it:
 * this is the multi-gigabyte error page an upstream can answer 400 with.
 */
function endlessChunkedError() {
  const chunk = new Uint8Array(64 * 1_024).fill(120);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk.slice());
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 400 }),
    pulledBytes: () => pulled * chunk.byteLength,
    cancelled: () => cancelled,
  };
}

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
      // The modern spelling: OpenAI's reasoning models refuse max_tokens, and
      // a backend that refuses this one gets the same cap re-sent as max_tokens.
      max_completion_tokens: 4_096,
      user: `hermes:${hermesConnectionId}`,
    });
    expect(JSON.parse(String(options.body))).not.toHaveProperty("max_tokens");

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

  it("records a rate-limited request, outside the transaction that refuses it", async () => {
    /*
     * The reason this was invisible. `RATE_LIMITED` is thrown from inside
     * `this.database.transaction(...)`, so a row written beside it is rolled
     * back with the refusal that caused it -- which is why nothing about a
     * rate limit ever reached the audit trail. This asserts the row survives,
     * not merely that the code was reached.
     */
    const { gateway, hermesConnectionId } = await harness();
    await context.database.insert(inferenceGatewayRequest).values(
      Array.from({ length: 30 }, () => ({ connectionId: hermesConnectionId })),
    );

    await expect(gateway.chat("runtime-key", request, new AbortController().signal))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });

    const [recorded] = await context.database
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "inference.gateway_rejected"));
    expect(recorded?.outcome).toBe("FAILURE");
    expect(recorded?.resourceId).toBe(hermesConnectionId);
    expect(recorded?.metadata).toMatchObject({
      reason: "RATE_LIMIT",
      modelAlias: "approved-agent",
      enforcementPlane: "ORCASYNAPSE",
    });
  });

  it("carries one bounded output cap under the modern field, whichever spelling arrived", async () => {
    const { gateway, fetcher } = await harness();

    await gateway.chat(
      "runtime-key",
      { ...request, max_tokens: undefined, max_completion_tokens: 2_000 },
      new AbortController().signal,
    );

    const options = vi.mocked(fetcher).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toMatchObject({ max_completion_tokens: 2_000 });
    expect(JSON.parse(String(options.body))).not.toHaveProperty("max_tokens");
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
    // The cap is a swap on this backend, never a drop: llama.cpp's compact
    // surface gets the same bound under the deprecated spelling.
    expect(body).toMatchObject({ max_tokens: 4_096 });
    expect(body).not.toHaveProperty("max_completion_tokens");
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

  it("re-sends the cap as max_tokens when a backend rejects the modern field", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unrecognized key: max_completion_tokens" }), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const { gateway } = await harness(fetcher as typeof fetch, { inferenceBackend: "CUSTOM_OPENAI_COMPATIBLE" });

    await gateway.chat("runtime-key", request, new AbortController().signal);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(first).toMatchObject({ max_completion_tokens: 4_096 });
    const retried = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(retried).toMatchObject({ max_tokens: 4_096 });
    expect(retried).not.toHaveProperty("max_completion_tokens");
  });

  it("guards every text part of an array-content message, not only string bodies", async () => {
    /*
     * The array form is the one both APIs treat as canonical for anything
     * multimodal. A guardrail that read only string content would become a
     * formality the moment a caller switched forms — a credential inside a
     * text part sailed past inspection while the same string in a plain body
     * was refused.
     */
    const { gateway } = await harness();

    await expect(gateway.chat(
      "runtime-key",
      {
        ...request,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "-----BEGIN PRIVATE KEY-----\nsecret" },
            { type: "image_url", image_url: { url: "https://images.internal/chart.png" } },
          ],
        }],
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });

  it("bounds and releases a chunked 400 instead of teeing it", async () => {
    // The hint reader used to inspect `response.clone()`. A clone tees the body,
    // and a tee branch's `cancel()` only settles once *both* branches are
    // cancelled — so the bounded read's own cleanup never returned, the request
    // hung with no timeout covering it, and the upstream body was never
    // released. The rate limiter is consumed before the upstream call, so a
    // node can drive this repeatedly.
    const upstream = endlessChunkedError();
    const { gateway } = await harness(vi.fn(async () => upstream.response) as typeof fetch);

    const outcome = await Promise.race([
      gateway.chat("runtime-key", request, new AbortController().signal)
        .then(() => "resolved" as const, (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 2_000)),
    ]);

    expect(outcome).not.toBe("HUNG");
    expect(outcome).toMatchObject({ code: "UPSTREAM_FAILED" });
    // Cancelling the body is what ends an endless upstream and frees the
    // connection; without it the source keeps whatever it has already produced.
    expect(upstream.cancelled()).toBe(true);
    expect(upstream.pulledBytes()).toBeLessThanOrEqual(128 * 1_024);
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

  it("forwards the redacted message rather than the one it was sent", async () => {
    /*
     * The assertion that makes redaction real. The forwarded body is built by
     * spreading the request, so spreading the pre-inspection copy would leave
     * the rewrite visible only in the audit trail while the model received the
     * original -- a redaction nobody could tell was not working.
     */
    const { gateway, fetcher, hermesConnectionId } = await harness();
    await context.database.insert(guardrailPolicy).values({
      slug: `policy-${randomUUID().slice(0, 8)}`,
      displayName: "Redacting policy",
      description: "Removes an internal codename before it reaches the model.",
      version: "1",
      status: "ACTIVE",
      maxInputCharacters: 32_000,
      maxOutputCharacters: 200_000,
      firstActivatedAt: new Date(),
      rules: [{
        id: randomUUID(),
        label: "Internal codename",
        type: "WORD",
        pattern: "seahorse",
        action: "REDACT",
        caseSensitive: false,
        enabled: true,
      }],
    });

    await gateway.chat(
      "runtime-key",
      { ...request, messages: [{ role: "user", content: "tell me about seahorse" }] },
      new AbortController().signal,
    );

    const [, init] = (fetcher as unknown as { mock: { calls: Array<[URL, RequestInit]> } }).mock.calls[0]!;
    const forwarded = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(forwarded.messages[0]?.content).toBe("tell me about [redacted]");
    expect(String(init.body)).not.toContain("seahorse");

    const [event] = await context.database
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.action, "inference.gateway_redacted"));
    expect(JSON.stringify(event?.metadata)).toContain("Internal codename");
    // Counts and labels only; the text it removed is exactly what must not be
    // copied into the trail to explain the removal.
    expect(JSON.stringify(event?.metadata)).not.toContain("seahorse");
    expect(hermesConnectionId).toBeTruthy();
  });

  it("records a guardrail refusal without recording what triggered it", async () => {
    /*
     * A policy rejection throws before `consumeRateLimit`, which was the only
     * thing writing to the trail -- so guardrails could block every request in
     * a deployment and leave no evidence that anything had happened.
     *
     * The metadata names the violation and nothing else. A
     * CREDENTIAL_PATTERN rejection exists precisely because the message looked
     * like a key; copying the message in to explain the refusal would store the
     * key in the audit trail.
     */
    const { gateway, hermesConnectionId } = await harness();

    await expect(
      gateway.chat(
        "runtime-key",
        { ...request, messages: [{ role: "user", content: "-----BEGIN PRIVATE KEY-----\nsecret" }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });

    const [recorded] = await context.database
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "inference.gateway_rejected"));
    expect(recorded?.outcome).toBe("FAILURE");
    expect(recorded?.resourceId).toBe(hermesConnectionId);
    expect(recorded?.metadata).toMatchObject({ reason: "POLICY", violation: "CREDENTIAL_PATTERN" });
    expect(JSON.stringify(recorded?.metadata)).not.toContain("PRIVATE KEY");

    // And the accepted-request row is not written for a refused request: the
    // rate-limit counter is never reached, so the two must not both appear.
    const accepted = await context.database
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "inference.gateway_requested"));
    expect(accepted).toHaveLength(0);
  });

  it("budgets a streamed response in wire bytes rather than in output characters", async () => {
    // The byte budget was `maxOutputCharacters * 8`, a ratio that only holds
    // for a single JSON body. On SSE every token is its own framed chunk at
    // roughly 231 wire bytes per four characters of content — about 50:1 — so
    // the default 200,000-character policy ran out after ~6,900 token frames,
    // below the 8,192-token deployment this repo ships as an example. Worse,
    // it ran out after the headers were flushed, so the caller got a truncated
    // answer that looked complete.
    const { gateway } = await harness(streamedResponse(), { maxOutputTokens: 8_192 });

    const result = await gateway.chat(
      "runtime-key",
      { ...request, stream: true },
      new AbortController().signal,
    );

    expect(result.maxResponseBytes).toBeGreaterThanOrEqual(8_192 * MEASURED_SSE_BYTES_PER_TOKEN);
    expect(result.stream).toBe(true);
  });

  it("still holds a non-streamed body to the character-derived budget", async () => {
    // Nothing above may be read as licence to loosen the JSON path, where
    // bytes and characters really are within a constant of each other.
    const { gateway } = await harness(okResponse(), { maxOutputTokens: 8_192 });

    const result = await gateway.chat("runtime-key", request, new AbortController().signal);

    // The default policy allows 256,000 output characters.
    expect(result.maxResponseBytes).toBe(256_000 * 8);
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

  it("refuses a chat path that would leave the approved inference origin", async () => {
    const { gateway, fetcher } = await harness(okResponse(), { chatPath: "//exfiltration.example/v1/chat" });

    await expect(gateway.chat("runtime-key", request, new AbortController().signal))
      .rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    // The prompt must never reach an origin the operator did not approve.
    expect(fetcher).not.toHaveBeenCalled();
  });

  /*
   * The authored-policy latch, on the gateway path. A drafted-but-never-
   * activated policy used to fall back to the permissive defaults silently;
   * authored guardrails that are not enforcing must refuse, and must do so
   * before any prompt leaves for the model.
   */
  it("refuses inference when only never-activated guardrail drafts exist", async () => {
    const { gateway, fetcher } = await harness();
    await context.database.insert(guardrailPolicy).values({
      slug: `policy-${randomUUID().slice(0, 8)}`,
      displayName: "Drafted guardrails",
      description: "Written but never activated.",
      version: "1",
      status: "DRAFT",
      maxInputCharacters: 32_000,
      maxOutputCharacters: 200_000,
      firstActivatedAt: null,
      rules: [],
    });

    await expect(gateway.chat("runtime-key", request, new AbortController().signal))
      .rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  /*
   * The role-aware length ceiling. A replayed message may only be re-checked
   * against the ceiling it was produced under: person-typed input against
   * `maxInputCharacters`, assistant and tool traffic against
   * `maxOutputCharacters`. Before this, the first answer or tool page longer
   * than the input ceiling poisoned its conversation permanently -- every
   * later turn carried the oversized echo and refused with
   * INPUT_CHARACTER_LIMIT.
   */
  it("forwards an assistant echo longer than the input ceiling", async () => {
    const { gateway, fetcher } = await harness();
    // Over the 128k default input ceiling, under the 256k output ceiling.
    const answer = "a".repeat(130_000);

    await gateway.chat(
      "runtime-key",
      { ...request, messages: [{ role: "assistant", content: answer }, { role: "user", content: "go on" }] },
      new AbortController().signal,
    );

    const [, init] = (fetcher as unknown as { mock: { calls: Array<[URL, RequestInit]> } }).mock.calls[0]!;
    const forwarded = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(forwarded.messages[0]?.content).toBe(answer);
  });

  it("forwards a tool message the size of a read_file page", async () => {
    const { gateway, fetcher } = await harness();

    await gateway.chat(
      "runtime-key",
      { ...request, messages: [{ role: "tool", content: "t".repeat(60_000) }, { role: "user", content: "summarise it" }] },
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("still refuses a user message past the input ceiling", async () => {
    const { gateway, fetcher } = await harness();

    await expect(gateway.chat(
      "runtime-key",
      { ...request, messages: [{ role: "user", content: "u".repeat(130_000) }] },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "POLICY_REJECTED", message: expect.stringContaining("INPUT_CHARACTER_LIMIT") });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honours a raised input ceiling end to end", async () => {
    // 125k characters: over the old 32k policy bound and over the old 120k
    // message-schema cap, so this passes only if both moved together.
    const { gateway, fetcher } = await harness();
    await context.database.insert(guardrailPolicy).values({
      slug: `policy-${randomUUID().slice(0, 8)}`,
      displayName: "Wide input ceiling",
      description: "Allows long typed input.",
      version: "1",
      status: "ACTIVE",
      maxInputCharacters: 128_000,
      maxOutputCharacters: 256_000,
      firstActivatedAt: new Date(),
      rules: [],
    });

    await gateway.chat(
      "runtime-key",
      { ...request, messages: [{ role: "user", content: "u".repeat(125_000) }] },
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses an assistant echo past the output ceiling its policy grants", async () => {
    // A tighter-than-default policy, because the contract already caps one
    // string body at 120k: the policy ceiling is what an operator tunes.
    const { gateway, fetcher } = await harness();
    await context.database.insert(guardrailPolicy).values({
      slug: `policy-${randomUUID().slice(0, 8)}`,
      displayName: "Tight output ceiling",
      description: "Bounds what an echoed answer may carry.",
      version: "1",
      status: "ACTIVE",
      maxInputCharacters: 32_000,
      maxOutputCharacters: 50_000,
      firstActivatedAt: new Date(),
      rules: [],
    });

    await expect(gateway.chat(
      "runtime-key",
      { ...request, messages: [{ role: "assistant", content: "a".repeat(60_000) }, { role: "user", content: "go on" }] },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "POLICY_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
