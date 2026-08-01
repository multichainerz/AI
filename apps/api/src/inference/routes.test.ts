import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { InferenceGatewayError } from "./inference-gateway.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function gatewayApp() {
  const gateway = {
    models: vi.fn(async (token: string | undefined) => {
      if (token !== "runtime-key") throw new InferenceGatewayError("UNAUTHORIZED", "Invalid runtime key.");
      return { object: "list", data: [{ id: "hermes-agent", object: "model", owned_by: "mpm-aihub" }] };
    }),
    chat: vi.fn(async (token: string | undefined) => {
      if (token !== "runtime-key") throw new InferenceGatewayError("UNAUTHORIZED", "Invalid runtime key.");
      return {
        response: new Response(JSON.stringify({ id: "chatcmpl-1", choices: [] }), { headers: { "content-type": "application/json" } }),
        maxResponseBytes: 65_536,
      };
    }),
  };
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", inferenceGateway: gateway as never } });
  apps.push(app);
  return { app, gateway };
}

describe("internal inference gateway routes", () => {
  it("requires the node-scoped bearer credential", async () => {
    const { app } = await gatewayApp();
    const response = await app.inject({ method: "GET", url: "/internal/v1/models" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { type: "unauthorized" } });
  });

  it("proxies a bounded OpenAI-compatible request without exposing vLLM", async () => {
    const { app, gateway } = await gatewayApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/chat/completions",
      headers: { authorization: "Bearer runtime-key" },
      payload: { model: "caller-choice", messages: [{ role: "user", content: "hello" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "chatcmpl-1" });
    expect(gateway.chat).toHaveBeenCalledWith("runtime-key", expect.objectContaining({ messages: [{ role: "user", content: "hello" }] }), expect.any(AbortSignal));
  });

  it("rejects unknown provider fields at the boundary", async () => {
    const { app, gateway } = await gatewayApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/chat/completions",
      headers: { authorization: "Bearer runtime-key" },
      payload: { messages: [{ role: "user", content: "hello" }], direct_vllm_override: true },
    });
    expect(response.statusCode).toBe(400);
    expect(gateway.chat).not.toHaveBeenCalled();
  });
});
