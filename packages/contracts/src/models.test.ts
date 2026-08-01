import { describe, expect, it } from "vitest";
import {
  createModelDeploymentSchema,
  modelDeploymentSchema,
  updateModelDeploymentSchema,
} from "./models.js";

const input = {
  slug: "laguna-hermes",
  displayName: "Laguna Hermes",
  modelAlias: "hermes-agent",
  workload: "AGENT" as const,
  connectionId: "5277951c-7d22-4cec-8d46-fad3afba37dd",
  version: "2.1-nvfp4",
  license: "MPM approved",
  contextWindowTokens: 131_072,
  maxOutputTokens: 8_192,
  maxConcurrentRequests: 2,
};

describe("model catalogue contracts", () => {
  it("accepts a bounded model deployment", () => {
    expect(createModelDeploymentSchema.parse(input)).toEqual(input);
  });

  it("rejects output limits larger than the context window", () => {
    expect(() => createModelDeploymentSchema.parse({
      ...input,
      contextWindowTokens: 4_096,
      maxOutputTokens: 8_192,
    })).toThrow();
  });

  it("requires optimistic concurrency for updates", () => {
    expect(() => updateModelDeploymentSchema.parse({ displayName: "Updated" })).toThrow();
  });

  it("rejects an active default route without retained evaluation evidence", () => {
    expect(() => modelDeploymentSchema.parse({
      ...input,
      id: input.connectionId,
      status: "ACTIVE",
      connection: {
        id: input.connectionId,
        displayName: "vLLM Primary",
        kind: "VLLM",
        environment: "PRODUCTION",
        enabled: true,
        status: "HEALTHY",
      },
      isDefault: true,
      activationEvaluationId: null,
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
      revision: 1,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    })).toThrow();
  });
});
