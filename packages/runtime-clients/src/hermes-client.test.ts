import { describe, expect, it, vi } from "vitest";
import type { DrizzleRuntimeConnectionResolver } from "./connection-resolver.js";
import { HermesClient } from "./hermes-client.js";

function resolver(configuration: Record<string, unknown> = {}): DrizzleRuntimeConnectionResolver {
  return {
    resolveOne: vi.fn(async () => ({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "HERMES",
      baseUrl: "https://hermes.orcasynapse.internal/",
      configuration,
      secrets: { apiKey: "strong-hermes-key" },
    })),
  } as unknown as DrizzleRuntimeConnectionResolver;
}

const capabilities = {
  platform: "hermes-agent",
  auth: { type: "bearer", required: true },
  runtime: { mode: "server_agent", tool_execution: "server", split_runtime: false },
  features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true },
};

/** One SSE frame per chunk, so a test controls exactly what each read delivers. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("HermesClient", () => {
  it("accepts an authenticated Runs API only when every API-server toolset is disabled", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer strong-hermes-key" }));
      return new Response(JSON.stringify(input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : [{ name: "terminal", enabled: false, tools: ["terminal"] }]), { status: 200 });
    });
    await expect(new HermesClient(resolver(), fetcher).assertAdmittedToolBoundary()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects any enabled native toolset", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "terminal", enabled: true, tools: ["terminal"] }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertAdmittedToolBoundary()).rejects.toThrow("enabled toolset");
  });

  it("accepts an enabled toolset once an operator has admitted it", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "clarify", enabled: true, tools: ["clarify"] }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertAdmittedToolBoundary(["clarify"]))
      .resolves.toBeUndefined();
  });

  it("refuses a runtime running a toolset nobody admitted, and names it", async () => {
    // Drift is the thing worth failing on: the runtime is no longer the one
    // this installation approved, whatever else it still has enabled.
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [
          { name: "clarify", enabled: true, tools: ["clarify"] },
          { name: "code_execution", enabled: true, tools: ["execute_code"] },
        ] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertAdmittedToolBoundary(["clarify"]))
      .rejects.toThrow("code_execution");
  });

  it("does not let an admission list excuse a toolset that is merely admitted, not enabled", async () => {
    // Admitting something the runtime never turned on is not an error, and must
    // not be reported as drift in either direction.
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "clarify", enabled: false, tools: ["clarify"] }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertAdmittedToolBoundary(["clarify", "todo"]))
      .resolves.toBeUndefined();
  });

  it("refuses governed tools against a Hermes that advertises what real builds advertise", async () => {
    // Regression guard for a design assumption: `orcasynapse_mcp_headers_v1` is
    // OrcaSynapse's own name for a handoff no shipped Hermes implements. The
    // capabilities document below is the one the pilot actually returns, and
    // the boundary must keep failing closed against it.
    const realWorldCapabilities = {
      platform: "hermes-agent",
      auth: { type: "bearer", required: true },
      runtime: { mode: "server_agent", tool_execution: "server", split_runtime: false },
      features: {
        chat_completions: true, run_submission: true, run_status: true, run_events_sse: true,
        run_stop: true, run_approval_response: true, tool_progress_events: true, approval_events: true,
      },
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? realWorldCapabilities
        : { object: "list", platform: "api_server", data: [] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertGovernedToolBoundary())
      .rejects.toThrow("private, redacted");
  });

  it("accepts governed tools only through the exact private run-context contract", async () => {
    const configured = resolver({
      governedMcpUrl: "https://orcasynapse.internal/api/v1/mcp/",
      governedToolsetName: "orcasynapse-governed-tools",
    });
    vi.mocked(configured.resolveOne).mockResolvedValue({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "HERMES",
      baseUrl: "https://hermes.orcasynapse.internal/",
      configuration: {
        governedMcpUrl: "https://orcasynapse.internal/api/v1/mcp/",
        governedToolsetName: "orcasynapse-governed-tools",
      },
      secrets: { apiKey: "strong-hermes-key", mcpGatewayToken: `orcasynapse_mcp_${"g".repeat(43)}` },
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (input.toString().startsWith("https://orcasynapse.internal/")) {
        expect(init?.headers).toEqual(expect.objectContaining({ authorization: `Bearer orcasynapse_mcp_${"g".repeat(43)}` }));
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: "orcasynapse-hermes-preflight",
          result: { serverInfo: { name: "orcasynapse-governed-tools", version: "0.1.0" } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify(input.toString().endsWith("/v1/capabilities")
        ? {
          ...capabilities,
          runtime: { ...capabilities.runtime, private_context_redacted: true, private_context_prompt_visible: false },
          features: { ...capabilities.features, private_run_context: "orcasynapse_mcp_headers_v1" },
        }
        : { object: "list", platform: "api_server", data: [{ name: "orcasynapse-governed-tools", enabled: true }] }), { status: 200 });
    });

    await expect(new HermesClient(configured, fetcher).assertGovernedToolBoundary()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("denies governed tools when Hermes does not guarantee private-context redaction", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "orcasynapse-governed-tools", enabled: true }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertGovernedToolBoundary()).rejects.toThrow("private, redacted");
  });

  it("rejects malformed toolset entries instead of assuming they are disabled", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [{ name: "terminal" }] },
    ), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).assertAdmittedToolBoundary()).rejects.toThrow("unrecognized entry");
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
        expect(init.headers).toEqual(expect.objectContaining({
          "idempotency-key": "run-request-1",
          "x-hermes-session-key": "memory-scope-1",
        }));
        expect(JSON.parse(String(init.body))).toMatchObject({
          input: "Analyze",
          session_id: "run-session-1",
          model: "hermes-agent",
          conversation_history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
        });
        return new Response(JSON.stringify({ run_id: "run_external_1", status: "started" }), { status: 202 });
      }
      return new Response(JSON.stringify({ run_id: "run_external_1", status: "completed", output: "Result" }), { status: 200 });
    });
    const client = new HermesClient(resolver(), fetcher);
    const id = await client.start({
      input: "Analyze", instructions: "Stay bounded", sessionId: "run-session-1",
      idempotencyKey: "run-request-1", modelAlias: "hermes-agent",
      conversationHistory: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
      memorySessionKey: "memory-scope-1",
    });
    await expect(client.status(id)).resolves.toMatchObject({ id, status: "completed", output: "Result", error: null });
  });

  it("reports unmeasured token usage as unknown rather than as zero", async () => {
    // llama.cpp behind an OpenAI-compatible gateway returns no usage, and Hermes
    // forwards {0,0,0}. Recording that verbatim tells an operator the run was
    // free — a stronger claim than the runtime ever made.
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      run_id: "run_external_1", status: "completed", output: "Red\nBlue\nGreen",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).status("run_external_1")).resolves.toMatchObject({
      output: "Red\nBlue\nGreen",
      inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null,
    });
  });

  it("keeps genuine token counts, including a real zero alongside a measured total", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      run_id: "run_external_1", status: "completed", output: "Result",
      usage: { input_tokens: 120, output_tokens: 0, reasoning_tokens: 0, total_tokens: 120 },
    }), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).status("run_external_1")).resolves.toMatchObject({
      inputTokens: 120, outputTokens: 0, reasoningTokens: 0, totalTokens: 120,
    });
  });

  it("leaves zeroes alone on a run that produced no output", async () => {
    // Nothing was produced, so zero is a plausible measurement and this client
    // has no standing to overrule it.
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      run_id: "run_external_1", status: "failed", error: "upstream refused",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }), { status: 200 }));
    await expect(new HermesClient(resolver(), fetcher).status("run_external_1")).resolves.toMatchObject({
      status: "failed", inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
  });

  it("submits governed credentials only in private context, never in model-visible instructions", async () => {
    const configured = resolver({
      governedMcpUrl: "https://orcasynapse.internal/api/v1/mcp/",
      governedToolsetName: "orcasynapse-governed-tools",
    });
    vi.mocked(configured.resolveOne).mockResolvedValue({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "HERMES",
      baseUrl: "https://hermes.orcasynapse.internal/",
      configuration: {
        governedMcpUrl: "https://orcasynapse.internal/api/v1/mcp/",
        governedToolsetName: "orcasynapse-governed-tools",
      },
      secrets: { apiKey: "strong-hermes-key", mcpGatewayToken: `orcasynapse_mcp_${"g".repeat(43)}` },
    });
    const authorization = `8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d.${"r".repeat(43)}`;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (input.toString().startsWith("https://orcasynapse.internal/")) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: "orcasynapse-hermes-preflight",
          result: { serverInfo: { name: "orcasynapse-governed-tools", version: "0.1.0" } },
        }), { status: 200 });
      }
      if (input.toString().endsWith("/v1/capabilities")) {
        return new Response(JSON.stringify({
          ...capabilities,
          runtime: { ...capabilities.runtime, private_context_redacted: true, private_context_prompt_visible: false },
          features: { ...capabilities.features, private_run_context: "orcasynapse_mcp_headers_v1" },
        }), { status: 200 });
      }
      if (input.toString().endsWith("/v1/toolsets")) {
        return new Response(JSON.stringify({
          object: "list", platform: "api_server", data: [{ name: "orcasynapse-governed-tools", enabled: true }],
        }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.instructions).toBe("Stay bounded");
      expect(body.instructions).not.toContain(authorization);
      expect(body.private_context).toMatchObject({
        protocol: "orcasynapse_mcp_headers_v1",
        mcp: {
          name: "orcasynapse-governed-tools",
          url: "https://orcasynapse.internal/api/v1/mcp/",
          headers: { "orcasynapse-run-authorization": authorization },
        },
      });
      return new Response(JSON.stringify({ run_id: "run_external_1" }), { status: 202 });
    });
    await expect(new HermesClient(configured, fetcher).start({
      input: "Analyze",
      instructions: "Stay bounded",
      sessionId: "run-session-1",
      idempotencyKey: "run-request-1",
      modelAlias: "hermes-agent",
      conversationHistory: [],
      memorySessionKey: "memory-scope-1",
      governedMcp: { authorization, expiresAt: new Date("2026-07-30T01:00:00.000Z") },
    })).resolves.toBe("run_external_1");
  });

  it("rejects configured request paths that escape the Hermes origin", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new HermesClient(resolver({ capabilitiesPath: "https://outside.example/capabilities" }), fetcher);
    await expect(client.assertAdmittedToolBoundary()).rejects.toThrow("configured origin");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("projects and batches the official data-only Hermes run SSE protocol", async () => {
    const payload = [
      "data: {\"event\":\"subagent.start\",\"id\":\"event-1\",\"child_session_id\":\"child-1\",\"summary\":\"Researching the bounded task\",\"hidden_prompt\":\"do not retain\"}\n\n",
      "data: {\"event\":\"message.delta\",\"id\":\"delta-1\",\"delta\":\"Hello \"}\n\n",
      "data: {\"event\":\"message.delta\",\"id\":\"delta-2\",\"delta\":\"world\"}\n\n",
      "data: {\"event\":\"approval.request\",\"id\":\"approval-event\",\"approval_id\":\"approval-1\",\"command\":\"Read protected source\",\"choices\":[\"once\",\"deny\"]}\n\n",
      "data: {\"event\":\"subagent.complete\",\"id\":\"event-2\",\"child_session_id\":\"child-1\",\"status\":\"completed\",\"summary\":\"Research complete\",\"duration_seconds\":1.25,\"usage\":{\"input_tokens\":20,\"output_tokens\":30,\"reasoning_tokens\":5,\"cost_usd\":0.02},\"tool_arguments\":{\"secret\":true}}\n\n",
    ].join("");
    const fetcher = vi.fn<typeof fetch>(async () => new Response(payload, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }));
    const projected: unknown[] = [];
    await new HermesClient(resolver(), fetcher).events(
      "run_external_1",
      (event) => { projected.push(event); },
      new AbortController().signal,
    );
    expect(projected).toHaveLength(4);
    expect(projected[1]).toMatchObject({
      type: "MESSAGE_DELTA",
      delta: "Hello world",
    });
    expect(projected[2]).toMatchObject({
      type: "APPROVAL_REQUIRED",
      approvalExternalId: "approval-1",
      approvalCommand: "Read protected source",
      approvalChoices: ["ALLOW_ONCE", "DENY"],
    });
    expect(projected[3]).toMatchObject({
      sourceEventId: "event-2",
      type: "SUBAGENT_COMPLETED",
      childSessionId: "child-1",
      status: "completed",
      summary: "Research complete",
      durationMs: 1250,
      inputTokens: 20,
      outputTokens: 30,
      reasoningTokens: 5,
      costUsd: 0.02,
    });
    expect(projected[3]).not.toHaveProperty("hidden_prompt");
    expect(projected[3]).not.toHaveProperty("tool_arguments");
  });

  it("delivers a 70 KB tool preview instead of ending the run stream over it", async () => {
    // Reproduced against a real Hermes: one `tool.complete` carrying a 70 KB
    // preview ended `events()` outright and *zero* events were delivered, so
    // the run degraded to polling — the message froze mid-generation and then
    // jumped to the final answer. Nothing here is oversized; the old guard
    // measured the whole accumulated buffer against a 64 KB ceiling.
    const chunks = [
      "data: {\"event\":\"message.delta\",\"id\":\"delta-1\",\"delta\":\"Partial answer\"}\n\n",
      `data: {"event":"tool.complete","id":"large","tool":"search","preview":"${"x".repeat(70_000)}"}\n\n`,
      "data: {\"event\":\"message.delta\",\"id\":\"delta-2\",\"delta\":\" continues\"}\n\n",
      "data: {\"event\":\"run.complete\",\"id\":\"final\",\"status\":\"completed\",\"output\":\"Partial answer continues\"}\n\n",
    ];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(sseStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }));
    const projected: Array<{ type: string; preview: string | null }> = [];
    await expect(new HermesClient(resolver(), fetcher).events(
      "run_external_1",
      (event) => { projected.push({ type: event.type, preview: event.preview }); },
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(projected.map((event) => event.type))
      .toEqual(["MESSAGE_DELTA", "TOOL_COMPLETED", "MESSAGE_DELTA", "RUN_COMPLETED"]);
    // The preview is bounded where previews are bounded, not by ending the run.
    expect(projected[1]?.preview).toHaveLength(1_000);
  });

  it("skips one genuinely oversized event and keeps delivering the ones around it", async () => {
    const chunks = [
      "data: {\"event\":\"message.delta\",\"id\":\"delta-1\",\"delta\":\"Partial answer\"}\n\n",
      `data: {"event":"tool.complete","id":"oversized","tool":"search","preview":"${"x".repeat(600_000)}"}\n\n`,
      "data: {\"event\":\"message.delta\",\"id\":\"delta-2\",\"delta\":\" continues\"}\n\n",
      "data: {\"event\":\"run.complete\",\"id\":\"final\",\"status\":\"completed\",\"output\":\"Partial answer continues\"}\n\n",
    ];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(sseStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const projected: Array<{ type: string; delta: string | null }> = [];
    await expect(new HermesClient(resolver(), fetcher).events(
      "run_external_1",
      (event) => { projected.push({ type: event.type, delta: event.delta }); },
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(projected.map((event) => event.type)).toEqual(["MESSAGE_DELTA", "RUN_COMPLETED"]);
    expect(projected[0]?.delta).toBe("Partial answer continues");
  });

  it("resynchronises on the next boundary when one event outgrows what it will buffer", async () => {
    // The oversized event arrives unterminated and split across reads, so the
    // bound trips with no boundary in sight. Everything after its terminator
    // still has to be delivered.
    const chunks = [
      "data: {\"event\":\"message.delta\",\"id\":\"delta-1\",\"delta\":\"Partial answer\"}\n\n",
      `data: {"event":"tool.complete","id":"oversized","tool":"search","preview":"${"x".repeat(600_000)}`,
      "\"}\n\ndata: {\"event\":\"message.delta\",\"id\":\"delta-2\",\"delta\":\" continues\"}\n\n"
        + "data: {\"event\":\"run.complete\",\"id\":\"final\",\"status\":\"completed\",\"output\":\"Partial answer continues\"}\n\n",
    ];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(sseStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const projected: Array<{ type: string; delta: string | null }> = [];
    await expect(new HermesClient(resolver(), fetcher).events(
      "run_external_1",
      (event) => { projected.push({ type: event.type, delta: event.delta }); },
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(projected.map((event) => event.type)).toEqual(["MESSAGE_DELTA", "RUN_COMPLETED"]);
    expect(projected[0]?.delta).toBe("Partial answer continues");
  });

  it("measures an event in characters, so multi-byte text is not mistaken for an oversized event", async () => {
    // The guard counted UTF-8 bytes while `safeDelta` caps at 64,000
    // characters, so roughly 22k CJK characters tripped a limit their
    // character count was nowhere near.
    const delta = "録".repeat(30_000);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(sseStream([
      `data: {"event":"message.delta","id":"delta-1","delta":"${delta}"}\n\n`,
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const projected: Array<string | null> = [];
    await expect(new HermesClient(resolver(), fetcher).events(
      "run_external_1",
      (event) => { projected.push(event.delta); },
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(projected).toEqual([delta]);
  });

  it("hands over coalesced output when the stream fails mid-run", async () => {
    // A delta that was coalesced but never flushed is real output the caller
    // already paid for. Frozen clock, so the 100 ms coalescing window cannot
    // flush it for us and the abnormal exit path is the only thing that can.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            "data: {\"event\":\"message.delta\",\"id\":\"delta-1\",\"delta\":\"Partial answer\"}\n\n",
          ));
        },
        pull(controller) { controller.error(new Error("upstream reset")); },
      });
      const fetcher = vi.fn<typeof fetch>(async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
      const projected: Array<string | null> = [];
      await expect(new HermesClient(resolver(), fetcher).events(
        "run_external_1",
        (event) => { projected.push(event.delta); },
        new AbortController().signal,
      )).rejects.toThrow("upstream reset");
      expect(projected).toEqual(["Partial answer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the upstream reader rather than abandoning a stream that is still producing", async () => {
    // Releasing the lock alone leaves Hermes writing into a stream nobody
    // reads. The run here is still open when the consumer gives up, which is
    // exactly the case where the upstream has to be told to stop.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: {\"event\":\"tool.start\",\"id\":\"tool-1\",\"tool\":\"search\"}\n\n",
        ));
      },
      pull: () => new Promise<void>(() => undefined),
      cancel() { cancelled = true; },
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    await expect(new HermesClient(resolver(), fetcher).events(
      "run_external_1",
      () => { throw new Error("consumer stopped reading"); },
      new AbortController().signal,
    )).rejects.toThrow("consumer stopped reading");
    expect(cancelled).toBe(true);
  });

  it("forwards a bounded allow-once approval to the official run endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input.toString()).toBe("https://hermes.orcasynapse.internal/v1/runs/run_external_1/approval");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ choice: "once" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await expect(new HermesClient(resolver(), fetcher).decideApproval("run_external_1", "once")).resolves.toBeUndefined();
  });
});
