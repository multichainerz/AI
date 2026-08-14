import { describe, expect, it, vi } from "vitest";
import { InferenceDiscoveryService } from "./inference-discovery-service.js";
import type { ConnectionDiagnosticStore } from "./types.js";

function responseFor(url: URL): Response {
  if (url.pathname === "/v1/models") {
    return Response.json({ data: [{ id: "gemma-4-e4b" }] });
  }
  if (url.pathname === "/health") return Response.json({ status: "ok" });
  if (url.pathname === "/props") {
    return Response.json({ default_generation_settings: { temperature: 0.8 }, total_slots: 1 });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

describe("InferenceDiscoveryService", () => {
  it("normalizes an OpenAI URL and discovers a llama.cpp server without guessed fields", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => responseFor(new URL(String(input))));
    const result = await new InferenceDiscoveryService(undefined, fetchMock as typeof fetch).discover({
      baseUrl: "http://gpu.internal:8080/v1",
      timeoutMs: 8000,
    });

    expect(result).toMatchObject({
      status: "READY",
      normalizedBaseUrl: "http://gpu.internal:8080",
      backend: "LLAMA_CPP",
      backendConfidence: "HIGH",
      models: [{ id: "gemma-4-e4b" }],
      recommended: {
        baseUrl: "http://gpu.internal:8080",
        healthPath: "/health",
        modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions",
        modelAlias: "gemma-4-e4b",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("uses the stored connection credential unless the administrator supplies a replacement", async () => {
    const store: ConnectionDiagnosticStore = {
      resolveForDiagnostic: async () => ({
        id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        activeRevision: 2,
        kind: "INFERENCE",
        baseUrl: "http://gpu.internal:8000/v1",
        configuration: {},
        secrets: { apiKey: "stored-secret" },
      }),
      recordDiagnostic: async () => true,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer stored-secret" });
      return responseFor(new URL(String(input)));
    });
    const result = await new InferenceDiscoveryService(store, fetchMock as typeof fetch).discover({
      baseUrl: "http://gpu.internal:8000",
      connectionId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      timeoutMs: 8000,
    });

    expect(result.status).toBe("READY");
  });

  it("never forwards a stored credential when the administrator changes the server origin", async () => {
    const store: ConnectionDiagnosticStore = {
      resolveForDiagnostic: async () => ({
        id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        activeRevision: 2,
        kind: "INFERENCE",
        baseUrl: "http://old-gpu.internal:8000",
        configuration: {},
        secrets: { apiKey: "must-not-leave-origin" },
      }),
      recordDiagnostic: async () => true,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({});
      return responseFor(new URL(String(input)));
    });

    await new InferenceDiscoveryService(store, fetchMock as typeof fetch).discover({
      baseUrl: "http://new-gpu.internal:8000",
      connectionId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      timeoutMs: 8000,
    });
  });

  it("distinguishes credential rejection from an unreachable server", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path === "/v1/models" || path === "/api/tags"
        ? Response.json({ error: "unauthorized" }, { status: 401 })
        : Response.json({ error: "not found" }, { status: 404 });
    });
    const result = await new InferenceDiscoveryService(undefined, fetchMock as typeof fetch).discover({
      baseUrl: "https://secured.internal/v1/models",
      timeoutMs: 8000,
    });

    expect(result).toMatchObject({ status: "AUTH_REQUIRED", models: [] });
  });

  it("does not mistake LM Studio's HTTP 200 error payloads for vendor endpoints", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "lfm2.5-2.6b" }] });
      if (path === "/get_server_info") {
        return Response.json({ error: { message: `Unexpected endpoint or method. (GET ${path})` } });
      }
      return Response.json({ error: `Unexpected endpoint or method. (GET ${path})` });
    });
    const result = await new InferenceDiscoveryService(undefined, fetchMock as typeof fetch).discover({
      baseUrl: "http://lm-studio.internal:1234",
      timeoutMs: 8000,
    });

    expect(result).toMatchObject({
      status: "READY",
      backend: "CUSTOM_OPENAI_COMPATIBLE",
      models: [{ id: "lfm2.5-2.6b" }],
      recommended: { healthPath: null, modelsPath: "/v1/models" },
    });
    expect(result.probes.find(({ key }) => key === "sglang-info")).toMatchObject({
      status: "FAILED",
      httpStatus: 200,
      message: "SGLang identity is not supported by this server.",
    });
  });

  it("requires positive SGLang response evidence instead of trusting a generic HTTP 200", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "model" }] });
      if (path === "/get_server_info") return Response.json({ message: "generic catch-all" });
      return Response.json({ error: "not found" }, { status: 404 });
    });

    const result = await new InferenceDiscoveryService(undefined, fetchMock as typeof fetch).discover({
      baseUrl: "http://generic.internal:8000",
      timeoutMs: 8000,
    });

    expect(result.backend).toBe("CUSTOM_OPENAI_COMPATIBLE");
  });

  it("recognizes SGLang only when its server metadata is present", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "model" }] });
      if (path === "/get_server_info") {
        return Response.json({
          version: "0.5.6",
          attention_backend: "flashinfer",
          max_total_num_tokens: 65_536,
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });

    const result = await new InferenceDiscoveryService(undefined, fetchMock as typeof fetch).discover({
      baseUrl: "http://sglang.internal:8000",
      timeoutMs: 8000,
    });

    expect(result.backend).toBe("SGLANG");
  });

  it("cancels a chunked discovery response when it exceeds one megabyte", async () => {
    let bytesProduced = 0;
    let cancelled = false;
    const chunk = new Uint8Array(65_536).fill(32);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path !== "/v1/models") return Response.json({ error: "not found" }, { status: 404 });
      return new Response(new ReadableStream({
        pull(controller) {
          bytesProduced += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200 });
    });

    const result = await new InferenceDiscoveryService(undefined, fetchMock as typeof fetch).discover({
      baseUrl: "http://oversized.internal:8000",
      timeoutMs: 8000,
    });

    expect(result.probes.find(({ key }) => key === "models-openai")).toMatchObject({
      status: "FAILED",
      message: "OpenAI model discovery response exceeded the one-megabyte safety limit.",
    });
    expect(cancelled).toBe(true);
    expect(bytesProduced).toBeLessThan(2_000_000);
  });
});
