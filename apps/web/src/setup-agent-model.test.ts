import type { ModelObservation } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import {
  admitLimits,
  isOpenRouterFreeAlias,
  setupAgentDeploymentSlug,
  setupAgentModelChoices,
} from "./setup-agent-model.js";

const observation = (over: Partial<ModelObservation>): ModelObservation => ({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  alias: "local-qwen",
  displayName: "Local Qwen",
  observedContextWindowTokens: 131_072,
  observedMaxOutputTokens: 8_192,
  inputModalities: ["text"],
  ownedBy: null,
  lastSeenAt: "2026-08-22T00:00:00.000Z",
  missingFromUpstream: false,
  admittedWorkloads: [],
  ...over,
});

describe("OpenRouter free aliases", () => {
  it("matches the official :free variant suffix, not the free router", () => {
    expect(isOpenRouterFreeAlias("meta-llama/llama-3.2-3b-instruct:free")).toBe(true);
    expect(isOpenRouterFreeAlias("openrouter/free")).toBe(false);
    expect(isOpenRouterFreeAlias("anthropic/claude-sonnet-4")).toBe(false);
  });
});

describe("setupAgentModelChoices", () => {
  const paid = observation({ id: "1", alias: "anthropic/claude-sonnet-4", displayName: "Claude" });
  const free = observation({ id: "2", alias: "nvidia/nemotron-3-nano:free", displayName: "Nemotron free" });
  const router = observation({ id: "3", alias: "openrouter/free", displayName: "Free router" });
  const embedding = observation({ id: "4", alias: "text-embedding-3-small:free", displayName: "Embed" });
  const local = observation({ id: "5", alias: "hermes-agent", displayName: "Hermes" });

  it("keeps only :free chat variants on OpenRouter", () => {
    const chosen = setupAgentModelChoices([paid, free, router, embedding], "https://openrouter.ai/api/v1");
    expect(chosen.map((item) => item.alias)).toEqual(["nvidia/nemotron-3-nano:free"]);
  });

  it("keeps the local catalogue except embeddings", () => {
    const chosen = setupAgentModelChoices([local, embedding], "http://gpu.internal:8000");
    expect(chosen.map((item) => item.alias)).toEqual(["hermes-agent"]);
  });
});

describe("setupAgentDeploymentSlug", () => {
  it("slugifies an OpenRouter :free alias without dropping the variant", () => {
    expect(setupAgentDeploymentSlug("nvidia/nemotron-3-nano:free")).toBe("nvidia-nemotron-3-nano-free");
  });
});

describe("admitLimits", () => {
  it("prefers observed bounds", () => {
    expect(admitLimits(observation({}))).toEqual({ contextWindowTokens: 131_072, maxOutputTokens: 8_192 });
  });

  it("fills a missing OpenRouter max-completion without blocking admit", () => {
    expect(admitLimits(observation({ observedMaxOutputTokens: null }))).toEqual({
      contextWindowTokens: 131_072,
      maxOutputTokens: 8_192,
    });
  });
});
