import { describe, expect, it } from "vitest";
import {
  createServiceConnectionSchema,
  parseServiceConnectionConfiguration,
  serviceConnectionSummarySchema,
} from "./connections.js";

const connectionBase = {
  slug: "service-primary",
  displayName: "Service Primary",
  environment: "PRODUCTION" as const,
  baseUrl: "https://service.mpm.internal",
  enabled: true,
  secrets: {},
};

describe("service connection configuration", () => {
  it("accepts typed SeaweedFS S3 settings", () => {
    const result = createServiceConnectionSchema.parse({
      ...connectionBase,
      kind: "SEAWEEDFS",
      configuration: {
        bucket: "aihub-documents",
        region: "us-east-1",
        forcePathStyle: true,
        timeoutMs: 10_000,
      },
    });

    expect(result.configuration).toEqual({
      bucket: "aihub-documents",
      region: "us-east-1",
      forcePathStyle: true,
      timeoutMs: 10_000,
    });
  });

  it("rejects settings that do not belong to the selected service", () => {
    const result = createServiceConnectionSchema.safeParse({
      ...connectionBase,
      kind: "SEAWEEDFS",
      configuration: { modelsPath: "/v1/models" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects absolute or cross-origin health paths", () => {
    expect(() =>
      parseServiceConnectionConfiguration("VLLM", {
        healthPath: "https://untrusted.example/health",
      }),
    ).toThrow();
  });

  it("does not allow arbitrary configuration keys in browser summaries", () => {
    const result = serviceConnectionSummarySchema.safeParse({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "service-primary",
      displayName: "Service Primary",
      kind: "VLLM",
      environment: "PRODUCTION",
      baseUrl: "https://service.mpm.internal",
      enabled: true,
      status: "NOT_TESTED",
      configuration: { accidentallySecret: "must-not-pass" },
      secretFieldNames: [],
      lastHealthcheckAt: null,
      lastHealthcheckMessage: null,
      updatedAt: new Date().toISOString(),
    });

    expect(result.success).toBe(false);
  });
});
