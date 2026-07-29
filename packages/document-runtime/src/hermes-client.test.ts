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
    await expect(new HermesClient(resolver(), fetcher).assertZeroToolBoundary()).rejects.toThrow("enabled native toolset");
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
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
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

  it("rejects configured request paths that escape the Hermes origin", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new HermesClient(resolver({ capabilitiesPath: "https://outside.example/capabilities" }), fetcher);
    await expect(client.assertZeroToolBoundary()).rejects.toThrow("configured origin");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
