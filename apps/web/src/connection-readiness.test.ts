import { describe, expect, it } from "vitest";
import type { ServiceConnectionSummary } from "@orcasynapse/contracts";
import { connectionReadiness } from "./connection-readiness.js";

function connection(overrides: Partial<ServiceConnectionSummary>): ServiceConnectionSummary {
  return {
    id: "7a637968-7ace-4ebf-8c15-44b9c3dbe409",
    kind: "INFERENCE",
    displayName: "AI Inference",
    slug: "ai-inference",
    baseUrl: "http://inference.internal:8080",
    environment: "DEVELOPMENT",
    enabled: true,
    status: "NOT_TESTED",
    configuration: {},
    secretFieldNames: [],
    activeRevision: 1,
    lastHealthcheckAt: null,
    lastHealthcheckMessage: null,
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("connectionReadiness", () => {
  it("uses the canonical lifecycle labels", () => {
    expect(connectionReadiness(undefined)).toMatchObject({ label: "Not configured", tone: "unconfigured" });
    expect(connectionReadiness(connection({ enabled: false }))).toMatchObject({ label: "Configured", tone: "configured" });
    expect(connectionReadiness(connection({ status: "NOT_TESTED" }))).toMatchObject({ label: "Needs validation", tone: "validation" });
    expect(connectionReadiness(connection({ status: "HEALTHY" }))).toMatchObject({ label: "Ready", tone: "ready", ready: true });
    expect(connectionReadiness(connection({ status: "DEGRADED" }))).toMatchObject({ label: "Degraded", tone: "degraded" });
    expect(connectionReadiness(connection({ status: "UNREACHABLE" }))).toMatchObject({ label: "Blocked", tone: "blocked" });
  });
});
