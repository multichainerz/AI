import type { ChatMessage } from "@aihub/contracts";
import { describe, expect, it } from "vitest";
import { chatMessageTelemetry } from "./chat-view.js";

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
    totalTokens: 1_490,
    latencyMs: 4_000,
    finishReason: "stop",
    errorCode: null,
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
      { key: "total", label: "Total", value: "1,490" },
      { key: "latency", label: "Latency", value: "4.00 s" },
      { key: "finish", label: "Finish", value: "stop" },
    ]);
  });

  it("does not invent throughput when vLLM omits usage", () => {
    const metrics = chatMessageTelemetry(message({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      latencyMs: null,
      finishReason: null,
    }));

    expect(metrics.every(({ value }) => value === "—")).toBe(true);
  });
});
