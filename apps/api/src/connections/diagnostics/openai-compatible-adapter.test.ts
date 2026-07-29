import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type { ResolvedConnection } from "./types.js";

const connection: ResolvedConnection = {
  id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
  kind: "VLLM",
  baseUrl: "https://vllm.mpm.internal",
  configuration: {},
  secrets: { apiKey: "private-token" },
};

const adapter = new OpenAICompatibleAdapter({
  serviceName: "vLLM",
  defaultHealthPath: "/health",
});

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible connection diagnostics", () => {
  it("reports healthy only after health and authenticated model discovery succeed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "hermes-primary" }, { id: "embed-primary" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.test(connection, new AbortController().signal);

    expect(result).toMatchObject({
      status: "HEALTHY",
      details: { modelCount: 2, modelIds: ["hermes-primary", "embed-primary"] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer private-token" },
    });
  });

  it("reports degraded when the service is reachable but model discovery is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
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
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
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
});
