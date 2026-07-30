import { describe, expect, it, vi } from "vitest";
import type { PrismaRuntimeConnectionResolver } from "./connection-resolver.js";
import { HermesClient } from "./hermes-client.js";

function resolver(configuration: Record<string, unknown> = {}): PrismaRuntimeConnectionResolver {
  return {
    resolveOne: vi.fn(async () => ({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "HERMES",
      baseUrl: "https://hermes.mpm.internal/",
      configuration,
      secrets: { apiKey: "strong-hermes-key" },
    })),
  } as unknown as PrismaRuntimeConnectionResolver;
}

const capabilities = {
  platform: "hermes-agent",
  auth: { type: "bearer", required: true },
  runtime: { mode: "server_agent", tool_execution: "server", split_runtime: false },
  features: { run_submission: true, run_status: true, run_stop: true },
};

describe("HermesClient", () => {
  it("accepts an authenticated Runs API only when every API-server toolset is disabled", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer strong-hermes-key" }));
      return new Response(JSON.stringify(input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "terminal", enabled: false, tools: ["terminal"] }] }), { status: 200 });
    });
    await expect(new HermesClient(resolver(), fetcher).assertZeroToolBoundary()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects any enabled native toolset", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "terminal", enabled: true, tools: ["terminal"] }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertZeroToolBoundary()).rejects.toThrow("enabled toolset");
  });

  it("accepts governed tools only through the exact private run-context contract", async () => {
    const configured = resolver({
      governedMcpUrl: "https://aihub.internal/api/v1/mcp/",
      governedToolsetName: "aihub-governed-tools",
    });
    vi.mocked(configured.resolveOne).mockResolvedValue({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "HERMES",
      baseUrl: "https://hermes.mpm.internal/",
      configuration: {
        governedMcpUrl: "https://aihub.internal/api/v1/mcp/",
        governedToolsetName: "aihub-governed-tools",
      },
      secrets: { apiKey: "strong-hermes-key", mcpGatewayToken: `aihub_mcp_${"g".repeat(43)}` },
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (input.toString().startsWith("https://aihub.internal/")) {
        expect(init?.headers).toEqual(expect.objectContaining({ authorization: `Bearer aihub_mcp_${"g".repeat(43)}` }));
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: "aihub-hermes-preflight",
          result: { serverInfo: { name: "mpm-aihub-governed-tools", version: "0.1.0" } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify(input.toString().endsWith("/v1/capabilities")
        ? {
          ...capabilities,
          runtime: { ...capabilities.runtime, private_context_redacted: true, private_context_prompt_visible: false },
          features: { ...capabilities.features, private_run_context: "aihub_mcp_headers_v1" },
        }
        : { object: "list", platform: "api_server", data: [{ name: "aihub-governed-tools", enabled: true }] }), { status: 200 });
    });

    await expect(new HermesClient(configured, fetcher).assertGovernedToolBoundary()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("denies governed tools when Hermes does not guarantee private-context redaction", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "aihub-governed-tools", enabled: true }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertGovernedToolBoundary()).rejects.toThrow("private, redacted");
  });

  it("rejects malformed toolset entries instead of assuming they are disabled", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "terminal" }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertZeroToolBoundary()).rejects.toThrow("unrecognized entry");
  });

  it("submits idempotently and parses pollable output", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (input.toString().endsWith("/v1/capabilities")) {
        return new Response(JSON.stringify(capabilities), { status: 200 });
      }
      if (input.toString().endsWith("/v1/toolsets")) {
        return new Response(JSON.stringify({ object: "list", platform: "api_server", data: [] }), { status: 200 });
      }
      if (init?.method === "POST") {
        expect(init.headers).toEqual(expect.objectContaining({ "idempotency-key": "run-session-1" }));
        expect(JSON.parse(String(init.body))).toMatchObject({ input: "Analyze", session_id: "run-session-1", model: "hermes-agent" });
        return new Response(JSON.stringify({ run_id: "run_external_1", status: "started" }), { status: 202 });
      }
      return new Response(JSON.stringify({ run_id: "run_external_1", status: "completed", output: "Result" }), { status: 200 });
    });
    const client = new HermesClient(resolver(), fetcher);
    const id = await client.start({ input: "Analyze", instructions: "Stay bounded", sessionId: "run-session-1", modelAlias: "hermes-agent" });
    await expect(client.status(id)).resolves.toMatchObject({ id, status: "completed", output: "Result", error: null });
  });

  it("submits governed credentials only in private context, never in model-visible instructions", async () => {
    const configured = resolver({
      governedMcpUrl: "https://aihub.internal/api/v1/mcp/",
      governedToolsetName: "aihub-governed-tools",
    });
    vi.mocked(configured.resolveOne).mockResolvedValue({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "HERMES",
      baseUrl: "https://hermes.mpm.internal/",
      configuration: {
        governedMcpUrl: "https://aihub.internal/api/v1/mcp/",
        governedToolsetName: "aihub-governed-tools",
      },
      secrets: { apiKey: "strong-hermes-key", mcpGatewayToken: `aihub_mcp_${"g".repeat(43)}` },
    });
    const authorization = `8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d.${"r".repeat(43)}`;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (input.toString().startsWith("https://aihub.internal/")) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: "aihub-hermes-preflight",
          result: { serverInfo: { name: "mpm-aihub-governed-tools", version: "0.1.0" } },
        }), { status: 200 });
      }
      if (input.toString().endsWith("/v1/capabilities")) {
        return new Response(JSON.stringify({
          ...capabilities,
          runtime: { ...capabilities.runtime, private_context_redacted: true, private_context_prompt_visible: false },
          features: { ...capabilities.features, private_run_context: "aihub_mcp_headers_v1" },
        }), { status: 200 });
      }
      if (input.toString().endsWith("/v1/toolsets")) {
        return new Response(JSON.stringify({
          object: "list", platform: "api_server", data: [{ name: "aihub-governed-tools", enabled: true }],
        }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.instructions).toBe("Stay bounded");
      expect(body.instructions).not.toContain(authorization);
      expect(body.private_context).toMatchObject({
        protocol: "aihub_mcp_headers_v1",
        mcp: {
          name: "aihub-governed-tools",
          url: "https://aihub.internal/api/v1/mcp/",
          headers: { "aihub-run-authorization": authorization },
        },
      });
      return new Response(JSON.stringify({ run_id: "run_external_1" }), { status: 202 });
    });
    await expect(new HermesClient(configured, fetcher).start({
      input: "Analyze",
      instructions: "Stay bounded",
      sessionId: "run-session-1",
      modelAlias: "hermes-agent",
      governedMcp: { authorization, expiresAt: new Date("2026-07-30T01:00:00.000Z") },
    })).resolves.toBe("run_external_1");
  });

  it("rejects configured request paths that escape the Hermes origin", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new HermesClient(resolver({ capabilitiesPath: "https://outside.example/capabilities" }), fetcher);
    await expect(client.assertZeroToolBoundary()).rejects.toThrow("configured origin");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
