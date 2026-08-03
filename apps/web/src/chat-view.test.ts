import type { ChatMessage } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { chatMessageTelemetry, createClientMessageId } from "./chat-view.js";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "5f33defe-1492-40de-a8dc-13ae8e6753c8",
    conversationId: "39f00c3c-c342-4678-ac24-91ea38aa25bb",
    role: "ASSISTANT",
    status: "COMPLETED",
    content: "Response",
    modelAlias: "qwen3.5-122b-a10b",
    inputTokens: 1_250,
    outputTokens: 240,
    reasoningTokens: 32,
    totalTokens: 1_490,
    latencyMs: 4_000,
    firstTokenLatencyMs: 280,
    finishReason: "stop",
    errorCode: null,
    agentRunId: "c184ecb8-8597-48bd-9de6-262049b55db6",
    runStatus: "COMPLETED",
    lastEventCursor: "42",
    runtimeEvents: [],
    approvals: [],
    sources: [],
    feedback: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:04.000Z",
    ...overrides,
  };
}

describe("chat response telemetry", () => {
  it("derives effective throughput and exposes provider usage separately", () => {
    expect(chatMessageTelemetry(message())).toEqual([
      { key: "throughput", label: "Effective speed", value: "60.0 tok/s" },
      { key: "input", label: "Input", value: "1,250" },
      { key: "output", label: "Output", value: "240" },
      { key: "reasoning", label: "Reasoning", value: "32" },
      { key: "total", label: "Total", value: "1,490" },
      { key: "first-token", label: "First token", value: "280 ms" },
      { key: "latency", label: "Latency", value: "4.00 s" },
      { key: "finish", label: "Finish", value: "stop" },
    ]);
  });

  it("does not invent throughput when the inference server omits usage", () => {
    const metrics = chatMessageTelemetry(message({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      latencyMs: null,
      firstTokenLatencyMs: null,
      finishReason: null,
    }));

    expect(metrics.every(({ value }) => value === "—")).toBe(true);
  });
});

describe("optimistic chat message identifiers", () => {
  it("uses native randomUUID when the browser exposes it", () => {
    expect(createClientMessageId({ randomUUID: () => "native-uuid" })).toBe("native-uuid");
  });

  it("creates an RFC 4122-shaped UUID when randomUUID is unavailable", () => {
    const id = createClientMessageId({
      getRandomValues: (bytes) => {
        bytes.fill(0xab);
        return bytes;
      },
    });

    expect(id).toBe("abababab-abab-4bab-abab-abababababab");
  });

  it("still creates a local-only UUID when Web Crypto is unavailable", () => {
    expect(createClientMessageId(null)).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  });
});
