import { describe, expect, it } from "vitest";
import { contractBoundedLimits, mapObservedCatalogue } from "./observed-catalogue.js";

describe("mapObservedCatalogue", () => {
  it("keeps OpenRouter context, vision and file modalities, and max completion", () => {
    expect(mapObservedCatalogue({
      data: [
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          context_length: 200_000,
          architecture: { input_modalities: ["text", "image", "file"] },
          top_provider: { max_completion_tokens: 8_192 },
        },
        { id: "~openai/gpt-latest", name: "dropped" },
      ],
    }, "openrouter")).toEqual([
      {
        alias: "anthropic/claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        observedContextWindowTokens: 200_000,
        observedMaxOutputTokens: 8_192,
        inputModalities: ["text", "image", "file"],
        ownedBy: null,
      },
    ]);
  });

  it("stores unknown capabilities for a generic id-only catalogue", () => {
    expect(mapObservedCatalogue({
      data: [{ id: "hermes-agent", owned_by: "vllm" }],
    }, "generic")).toEqual([
      {
        alias: "hermes-agent",
        displayName: null,
        observedContextWindowTokens: null,
        observedMaxOutputTokens: null,
        inputModalities: [],
        ownedBy: "vllm",
      },
    ]);
  });

  it("does not treat extra keys on a generic payload as observed facts", () => {
    expect(mapObservedCatalogue({
      data: [{
        id: "qwen3-vl",
        name: "Qwen VL",
        context_length: 131_072,
        architecture: { input_modalities: ["text", "image"] },
        top_provider: { max_completion_tokens: 8_192 },
      }],
    }, "generic")).toEqual([
      {
        alias: "qwen3-vl",
        displayName: "Qwen VL",
        observedContextWindowTokens: null,
        observedMaxOutputTokens: null,
        inputModalities: [],
        ownedBy: null,
      },
    ]);
  });
});

describe("contractBoundedLimits", () => {
  it("returns null when either observed limit is missing", () => {
    expect(contractBoundedLimits({
      observedContextWindowTokens: 131_072,
      observedMaxOutputTokens: null,
    })).toBeNull();
  });

  it("returns null for Laguna-shaped numbers that were not observed", () => {
    expect(contractBoundedLimits({
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
    })).toBeNull();
  });
});
