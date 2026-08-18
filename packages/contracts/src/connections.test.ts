import { describe, expect, it } from "vitest";
import {
  createServiceConnectionSchema,
  inferenceCatalogueRequestSchema,
  inferenceCatalogueResultSchema,
  inferenceDiscoveryRequestSchema,
  inferenceDiscoveryResultSchema,
  isOpenRouterEndpoint,
  modelAliasSchema,
  parseServiceConnectionConfiguration,
  updateConnectionMonitoringControlSchema,
  serviceConnectionSummarySchema,
} from "./connections.js";

const connectionBase = {
  slug: "service-primary",
  displayName: "Service Primary",
  environment: "PRODUCTION" as const,
  baseUrl: "https://service.orcasynapse.internal",
  enabled: true,
  secrets: {},
};

describe("service connection configuration", () => {
  it("accepts an evidence-backed inference discovery result", () => {
    expect(inferenceDiscoveryRequestSchema.parse({
      baseUrl: "gpu.internal:8000/v1",
      connectionId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
    })).toMatchObject({ baseUrl: "http://gpu.internal:8000/v1", timeoutMs: 8000 });

    expect(isOpenRouterEndpoint("https://openrouter.ai")).toBe(true);
    expect(isOpenRouterEndpoint("https://eu.openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterEndpoint("https://vllm.internal:8000")).toBe(false);
    expect(modelAliasSchema.safeParse("anthropic/claude-sonnet-4").success).toBe(true);
    expect(modelAliasSchema.safeParse("~openai/gpt-latest").success).toBe(false);

    expect(inferenceCatalogueRequestSchema.parse({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
    })).toMatchObject({ provider: "openrouter", timeoutMs: 8000 });

    expect(inferenceCatalogueResultSchema.parse({
      provider: "openrouter",
      models: [{ id: "anthropic/claude-sonnet-4", name: "Claude Sonnet" }],
      key: { label: "pilot", limitRemaining: 12.5 },
    })).toMatchObject({ provider: "openrouter" });
    expect(inferenceCatalogueResultSchema.safeParse({
      provider: "openrouter",
      models: [{ id: "~openai/gpt-latest" }],
      key: {},
    }).success).toBe(false);

    expect(inferenceDiscoveryResultSchema.parse({
      status: "READY",
      message: "Inference server is ready.",
      normalizedBaseUrl: "http://gpu.internal:8000",
      backend: "VLLM",
      backendConfidence: "HIGH",
      backendEvidence: ["The vLLM version endpoint responded."],
      models: [{ id: "hermes-primary" }],
      recommended: {
        baseUrl: "http://gpu.internal:8000",
        inferenceBackend: "VLLM",
        healthPath: "/health",
        modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions",
        modelAlias: "hermes-primary",
      },
      probes: [{
        key: "models",
        label: "OpenAI model discovery",
        path: "/v1/models",
        status: "PASSED",
        httpStatus: 200,
        latencyMs: 12,
        message: "Discovered one model.",
      }],
    })).toMatchObject({ status: "READY", backend: "VLLM" });
  });

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

  it("rejects unsupported connection kinds", () => {
    const result = createServiceConnectionSchema.safeParse({
      ...connectionBase,
      kind: "OBJECT_STORE",
      configuration: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts only the Hermes control-plane paths used by the hardened worker", () => {
    expect(parseServiceConnectionConfiguration("HERMES", {
      healthPath: "/health",
      capabilitiesPath: "/v1/capabilities",
      toolsetsPath: "/v1/toolsets",
      sessionsPath: "/api/sessions",
      runPollIntervalMs: 1_000,
      timeoutMs: 8_000,
    })).toMatchObject({
      toolsetsPath: "/v1/toolsets",
      sessionsPath: "/api/sessions",
    });
    expect(() => parseServiceConnectionConfiguration("HERMES", { modelAlias: "not-owned-here" })).toThrow();
  });

  it("rejects settings that do not belong to the selected service", () => {
    const result = createServiceConnectionSchema.safeParse({
      ...connectionBase,
      kind: "INFERENCE",
      configuration: { platformAdminGroups: ["belongs-to-enterprise-access"] },
    });

    expect(result.success).toBe(false);
  });

  it("records a supported backend while keeping inference routing provider-neutral", () => {
    expect(parseServiceConnectionConfiguration("INFERENCE", {
      inferenceBackend: "LLAMA_CPP",
      healthPath: "/health",
      modelsPath: "/v1/models",
      chatPath: "/v1/chat/completions",
      modelAlias: "hermes-primary",
    })).toMatchObject({ inferenceBackend: "LLAMA_CPP", modelAlias: "hermes-primary" });

    expect(() => parseServiceConnectionConfiguration("INFERENCE", {
      inferenceBackend: "UNSUPPORTED_ENGINE",
    })).toThrow();
  });

  it("rejects absolute or cross-origin health paths", () => {
    expect(() =>
      parseServiceConnectionConfiguration("INFERENCE", {
        healthPath: "https://untrusted.example/health",
      }),
    ).toThrow();
  });

  it("accepts a bounded OIDC group allowlist and rejects provider-only settings elsewhere", () => {
    expect(parseServiceConnectionConfiguration("OIDC", {
      clientId: "orcasynapse",
      redirectUri: "https://orcasynapse.example.internal/api/v1/auth/oidc/callback",
      scopes: ["openid", "profile", "email", "groups"],
      groupsClaim: "realm_access.groups",
      allowedGroups: ["OrcaSynapse-Pilot"],
      platformAdminGroups: ["OrcaSynapse-Platform-Admins"],
      emailClaim: "email",
      nameClaim: "name",
      tokenAuthMethod: "client_secret_basic",
      caseSensitiveGroups: false,
    })).toMatchObject({ clientId: "orcasynapse", allowedGroups: ["OrcaSynapse-Pilot"], platformAdminGroups: ["OrcaSynapse-Platform-Admins"] });

    expect(() => parseServiceConnectionConfiguration("INFERENCE", {
      allowedGroups: ["OrcaSynapse-Pilot"],
    })).toThrow();
  });

  it("does not allow arbitrary configuration keys in browser summaries", () => {
    const result = serviceConnectionSummarySchema.safeParse({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "service-primary",
      displayName: "Service Primary",
      kind: "INFERENCE",
      environment: "PRODUCTION",
      baseUrl: "https://service.orcasynapse.internal",
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
