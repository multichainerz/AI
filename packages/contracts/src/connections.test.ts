import { describe, expect, it } from "vitest";
import {
  createServiceConnectionSchema,
  parseServiceConnectionConfiguration,
  updateConnectionMonitoringControlSchema,
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
  it("bounds dashboard-managed scheduled monitoring", () => {
    expect(updateConnectionMonitoringControlSchema.safeParse({
      enabled: true,
      intervalSeconds: 300,
      reason: "Pilot monitoring approved",
    }).success).toBe(true);
    expect(updateConnectionMonitoringControlSchema.safeParse({
      enabled: true,
      intervalSeconds: 5,
      reason: "Too frequent",
    }).success).toBe(false);
  });

  it("accepts typed vendor-neutral S3 settings", () => {
    const result = createServiceConnectionSchema.parse({
      ...connectionBase,
      kind: "S3",
      configuration: {
        bucket: "aihub-documents",
        region: "us-east-1",
        forcePathStyle: false,
        objectTimeoutMs: 120_000,
        timeoutMs: 10_000,
      },
    });

    expect(result.configuration).toEqual({
      bucket: "aihub-documents",
      region: "us-east-1",
      forcePathStyle: false,
      objectTimeoutMs: 120_000,
      timeoutMs: 10_000,
    });
    expect(() => parseServiceConnectionConfiguration("S3", { bucket: "192.168.1.10" })).toThrow();
    expect(() => parseServiceConnectionConfiguration("S3", { bucket: "invalid..bucket" })).toThrow();
    expect(() => parseServiceConnectionConfiguration("S3", { objectTimeoutMs: 1_000 })).toThrow();
  });

  it("accepts bounded Supermemory runtime and retrieval settings", () => {
    expect(parseServiceConnectionConfiguration("SUPERMEMORY", {
      documentsPath: "/v3/documents",
      searchPath: "/v3/search",
      memoryTimeoutMs: 300_000,
      memoryPollIntervalMs: 2_000,
      retrievalLimit: 6,
      retrievalThreshold: 0.25,
    })).toMatchObject({ documentsPath: "/v3/documents", retrievalLimit: 6 });

    expect(() => parseServiceConnectionConfiguration("SUPERMEMORY", {
      retrievalLimit: 100,
    })).toThrow();
  });

  it("accepts only the Hermes control-plane paths used by the hardened worker", () => {
    expect(parseServiceConnectionConfiguration("HERMES", {
      healthPath: "/health",
      capabilitiesPath: "/v1/capabilities",
      toolsetsPath: "/v1/toolsets",
      runsPath: "/v1/runs",
      governedMcpUrl: "https://aihub.internal/api/v1/mcp/",
      governedToolsetName: "aihub-governed-tools",
      runPollIntervalMs: 1_000,
      timeoutMs: 8_000,
    })).toMatchObject({
      toolsetsPath: "/v1/toolsets",
      runsPath: "/v1/runs",
      governedMcpUrl: "https://aihub.internal/api/v1/mcp/",
      governedToolsetName: "aihub-governed-tools",
    });
    expect(() => parseServiceConnectionConfiguration("HERMES", { modelAlias: "not-owned-here" })).toThrow();
  });

  it("rejects settings that do not belong to the selected service", () => {
    const result = createServiceConnectionSchema.safeParse({
      ...connectionBase,
      kind: "S3",
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

  it("accepts a bounded OIDC group allowlist and rejects provider-only settings elsewhere", () => {
    expect(parseServiceConnectionConfiguration("OIDC", {
      clientId: "aihub",
      redirectUri: "https://aihub.mpm.internal/api/v1/auth/oidc/callback",
      scopes: ["openid", "profile", "email", "groups"],
      groupsClaim: "realm_access.groups",
      allowedGroups: ["AIHub-Pilot"],
      emailClaim: "email",
      nameClaim: "name",
      tokenAuthMethod: "client_secret_basic",
      caseSensitiveGroups: false,
    })).toMatchObject({ clientId: "aihub", allowedGroups: ["AIHub-Pilot"] });

    expect(() => parseServiceConnectionConfiguration("VLLM", {
      allowedGroups: ["AIHub-Pilot"],
    })).toThrow();
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
