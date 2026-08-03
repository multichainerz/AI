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
      details: { modelCount: 2, modelIds: ["hermes-primary", "embed-primary"], inferenceBackend: "LLAMA_CPP" },
    });
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
      details: { modelIds: ["gemma-4-e4b"], healthHttpStatus: 404 },
    });
  });
});
