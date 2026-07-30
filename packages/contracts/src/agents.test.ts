import { describe, expect, it } from "vitest";
import {
  agentRunSchema,
  createAgentProfileSchema,
  updateAgentRuntimeControlSchema,
} from "./agents.js";

const configuration = {
  slug: "hermes-analyst",
  displayName: "Hermes Analyst",
  purpose: "Analyze private operational documents.",
  instructions: "Answer using authorized evidence and state uncertainty.",
  soulMd: "You are a careful analyst who is precise and candid about uncertainty.",
  skills: [],
  modelAlias: "hermes-agent",
  maxTurns: 1,
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  allowPrivateKnowledge: true,
  safeMode: true,
} as const;

describe("agent contracts", () => {
  it("accepts only the Phase 5 single-turn safe-mode boundary", () => {
    expect(createAgentProfileSchema.parse(configuration)).toEqual(configuration);
    expect(createAgentProfileSchema.safeParse({ ...configuration, maxTurns: 2 }).success).toBe(false);
    expect(createAgentProfileSchema.safeParse({ ...configuration, safeMode: false }).success).toBe(false);
  });

  it("requires an operator reason for runtime changes", () => {
    expect(updateAgentRuntimeControlSchema.safeParse({ enabled: true, reason: "Acceptance checks passed." }).success).toBe(true);
    expect(updateAgentRuntimeControlSchema.safeParse({ enabled: false, reason: "x" }).success).toBe(false);
  });

  it("bounds run provenance to recognized capabilities and sources", () => {
    const base = {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      profileId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      profileSlug: "hermes-analyst",
      profileName: "Hermes Analyst",
      profileVersion: 1,
      profileDistributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "COMPLETED",
      input: "Summarize the policy.",
      output: "Summary",
      effectiveCapabilities: ["knowledge:private:read"],
      sources: [],
      failureCode: null,
      failureMessage: null,
      queuedAt: "2026-07-30T00:00:00.000Z",
      startedAt: "2026-07-30T00:00:01.000Z",
      completedAt: "2026-07-30T00:00:02.000Z",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:02.000Z",
    };
    expect(agentRunSchema.parse(base).status).toBe("COMPLETED");
    expect(agentRunSchema.safeParse({ ...base, effectiveCapabilities: ["terminal:write"] }).success).toBe(false);
  });
});
