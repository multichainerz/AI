import { describe, expect, it } from "vitest";
import { inferenceGatewayChatRequestSchema } from "./inference-gateway.js";

describe("inference gateway contract", () => {
  it("accepts a bounded OpenAI-compatible tool request", () => {
    expect(inferenceGatewayChatRequestSchema.parse({
      model: "ignored-by-gateway",
      messages: [{ role: "user", content: "check the service" }],
      tools: [{ type: "function", function: { name: "health", parameters: { type: "object" } } }],
      stream: true,
    })).toMatchObject({ stream: true });
  });

  it("rejects unbounded or provider-specific fields outside the allowlist", () => {
    expect(inferenceGatewayChatRequestSchema.safeParse({
      messages: [{ role: "user", content: "hello" }],
      arbitrary_provider_secret: "no",
    }).success).toBe(false);
  });

  it("accepts the modern completion-token field but rejects ambiguous dual limits", () => {
    expect(inferenceGatewayChatRequestSchema.safeParse({
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 512,
    }).success).toBe(true);
    expect(inferenceGatewayChatRequestSchema.safeParse({
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 256,
      max_completion_tokens: 512,
    }).success).toBe(false);
  });
});
