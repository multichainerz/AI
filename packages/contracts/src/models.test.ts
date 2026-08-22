import { describe, expect, it } from "vitest";
import {
  createModelDeploymentSchema,
  modelDeploymentSchema,
  modelObservationSchema,
  modelRefreshResultSchema,
  updateModelDeploymentSchema,
} from "./models.js";

const input = {
  slug: "laguna-hermes",
  displayName: "Laguna Hermes",
  modelAlias: "hermes-agent",
  workload: "AGENT" as const,
  connectionId: "5277951c-7d22-4cec-8d46-fad3afba37dd",
  version: "2.1-nvfp4",
  license: "OrcaSynapse approved",
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

  it("still requires contract-bounded enforced limits on create", () => {
    const { contextWindowTokens: _context, maxOutputTokens: _output, ...withoutLimits } = input;
    expect(() => createModelDeploymentSchema.parse(withoutLimits)).toThrow();
    expect(() => createModelDeploymentSchema.parse({ ...input, contextWindowTokens: 512 })).toThrow();
  });

  it("requires optimistic concurrency for updates", () => {
    expect(() => updateModelDeploymentSchema.parse({ displayName: "Updated" })).toThrow();
  });

  it("rejects an active default route with no activation timestamp", () => {
    const active = {
      ...input,
      id: input.connectionId,
      status: "ACTIVE",
      connection: {
        id: input.connectionId,
        displayName: "vLLM Primary",
        kind: "INFERENCE",
        environment: "PRODUCTION",
        enabled: true,
        status: "HEALTHY",
      },
      isDefault: true,
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
      revision: 1,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    // The positive case first: without it, the rejection below would also pass
    // if the fixture were malformed for some entirely unrelated reason.
    expect(modelDeploymentSchema.parse(active).status).toBe("ACTIVE");
    expect(() => modelDeploymentSchema.parse({ ...active, firstActivatedAt: null })).toThrow();
  });

  it("fills observation fields on a deployment when the payload omits them", () => {
    const active = {
      ...input,
      id: input.connectionId,
      status: "ACTIVE",
      connection: {
        id: input.connectionId,
        displayName: "vLLM Primary",
        kind: "INFERENCE",
        environment: "PRODUCTION",
        enabled: true,
        status: "HEALTHY",
      },
      isDefault: true,
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
      revision: 1,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    expect(modelDeploymentSchema.parse(active)).toMatchObject({
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      missingFromUpstream: false,
      lastSeenAt: null,
    });
  });

  it("accepts an observation with unknown capabilities", () => {
    expect(modelObservationSchema.parse({
      id: input.connectionId,
      connectionId: input.connectionId,
      alias: "local-qwen",
      displayName: null,
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: null,
      lastSeenAt: "2026-08-22T00:00:00.000Z",
      missingFromUpstream: false,
      admittedWorkloads: [],
    }).inputModalities).toEqual([]);
  });

  it("accepts a refresh result that did not create a route", () => {
    expect(modelRefreshResultSchema.parse({
      connectionId: input.connectionId,
      refreshedAt: "2026-08-22T00:00:00.000Z",
      upserted: 1,
      vanished: 0,
      items: [],
      backfill: null,
    }).backfill).toBeNull();
  });
});
