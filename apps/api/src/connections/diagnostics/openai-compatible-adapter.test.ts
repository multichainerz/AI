import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type { ResolvedConnection } from "./types.js";

const connection: ResolvedConnection = {
  id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
  activeRevision: 1,
  kind: "INFERENCE",
  baseUrl: "https://vllm.orcasynapse.internal",
  configuration: { inferenceBackend: "LLAMA_CPP" },
  secrets: { apiKey: "private-token" },
};

const adapter = new OpenAICompatibleAdapter({
  serviceName: "Inference server",
  defaultHealthPath: "/health",
});

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible connection diagnostics", () => {
  it("reports healthy after authenticated model discovery and records optional health evidence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "hermes-primary" }, { id: "embed-primary" }] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.test(connection, new AbortController().signal);

    expect(result).toMatchObject({
      status: "HEALTHY",
      details: { modelCount: 2, inferenceBackend: "LLAMA_CPP" },
    });
    expect(result.details).not.toHaveProperty("modelIds");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer private-token" },
    });
  });

  it("reports degraded when the service is reachable but model discovery is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("not-json", { status: 200 })),
    );

    await expect(adapter.test(connection, new AbortController().signal)).resolves.toMatchObject({
      status: "DEGRADED",
      details: { failure: "invalid_models_response" },
    });
  });

  it("cancels a chunked models response as soon as the safety limit is exceeded", async () => {
    let bytesProduced = 0;
    let cancelled = false;
    const chunk = new Uint8Array(65_536).fill(32);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        bytesProduced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 })));

    await expect(adapter.test(connection, new AbortController().signal)).resolves.toMatchObject({
      status: "DEGRADED",
      details: { failure: "models_response_too_large", responseTooLarge: true },
    });
    expect(cancelled).toBe(true);
    expect(bytesProduced).toBeLessThan(2_000_000);
  });

  it("reports degraded when the configured model alias is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: [{ id: "different-model" }] })),
    );

    await expect(
      adapter.test(
        { ...connection, configuration: { modelAlias: "hermes-primary" } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: "DEGRADED",
      details: { modelAlias: "hermes-primary", modelCount: 1 },
    });
  });

  it("does not reject a working model API because an optional health route is absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ models: [{ name: "gemma-4-e4b" }] }))
      .mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter.test(connection, new AbortController().signal)).resolves.toMatchObject({
      status: "HEALTHY",
      details: { modelCount: 1, healthHttpStatus: 404 },
    });
  });

  it("does not call OpenRouter's key probe against a local server", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "hermes-primary" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await adapter.test(connection, new AbortController().signal);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://vllm.orcasynapse.internal/v1/models",
      "https://vllm.orcasynapse.internal/health",
    ]);
  });

  it("refuses OpenRouter when the models list is public and no key is stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(Response.json({
        data: Array.from({ length: 60 }, (_, index) => ({ id: `vendor/model-${index}` })),
      })),
    );

    await expect(adapter.test({
      ...connection,
      baseUrl: "https://openrouter.ai",
      configuration: {
        inferenceBackend: "CUSTOM_OPENAI_COMPATIBLE",
        modelsPath: "/api/v1/models",
        modelAlias: "vendor/model-51",
      },
      secrets: {},
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "DEGRADED",
      details: { failure: "openrouter_key_required", modelCount: 60 },
    });
  });

  it("refuses OpenRouter when the key is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "anthropic/claude-sonnet-4" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter.test({
      ...connection,
      baseUrl: "https://openrouter.ai",
      configuration: {
        inferenceBackend: "CUSTOM_OPENAI_COMPATIBLE",
        modelsPath: "/api/v1/models",
        chatPath: "/api/v1/chat/completions",
        modelAlias: "anthropic/claude-sonnet-4",
      },
      secrets: { apiKey: "sk-or-bad" },
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "DEGRADED",
      details: { authentication: "rejected", httpStatus: 401 },
    });
  });

  it("accepts an OpenRouter alias past the old fifty-model slice once the key is proven", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        data: Array.from({ length: 60 }, (_, index) => ({ id: `vendor/model-${index}` })),
      }))
      .mockResolvedValueOnce(Response.json({ data: { label: "pilot" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter.test({
      ...connection,
      baseUrl: "https://openrouter.ai",
      configuration: {
        inferenceBackend: "CUSTOM_OPENAI_COMPATIBLE",
        modelsPath: "/api/v1/models",
        healthPath: "/api/v1/models",
        modelAlias: "vendor/model-51",
      },
      secrets: { apiKey: "sk-or-v1-test" },
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "HEALTHY",
      details: { modelCount: 60, modelAlias: "vendor/model-51", credential: "verified" },
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://openrouter.ai/api/v1/key");
  });
});
