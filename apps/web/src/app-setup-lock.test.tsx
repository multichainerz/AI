/**
 * @vitest-environment jsdom
 *
 * First-run local-admin sessions stay on Setup until the runtime step is done.
 * These cases hold the shell wiring: the rail, the landing hash, and a deep
 * link that would otherwise open Session.
 */
import type {
  AdministratorSession,
  AgentRuntimeControl,
  ConnectionMonitoringControl,
  HermesRuntimeNode,
  ModelDeployment,
  OnboardingSnapshot,
  PlatformMeta,
  ServiceConnectionSummary,
} from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPlatformMeta: vi.fn(),
  getAdministratorSession: vi.fn(),
  getEnterpriseSession: vi.fn(),
  getConnections: vi.fn(),
  getConnectionMonitoring: vi.fn(),
  getChatMetrics: vi.fn(),
  getAgentMetrics: vi.fn(),
  getToolMetrics: vi.fn(),
  getAgentRuntime: vi.fn(),
  getAgentProfiles: vi.fn(),
  getHermesRuntimeNodes: vi.fn(),
  getModelDeployments: vi.fn(),
  getOnboardingSnapshot: vi.fn(),
  getGatewayUsage: vi.fn(),
  getAgentRuns: vi.fn(),
  getOperationalIncidents: vi.fn(),
  revokeAdministratorSession: vi.fn(),
  revokeEnterpriseSession: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, ...api };
});

const { default: App } = await import("./app.js");

const session = {
  role: "PLATFORM_ADMIN",
  scopes: ["connections:write", "connections:test", "models:manage", "readiness:manage", "chat:use"],
  passwordChangeRequired: false,
} as unknown as AdministratorSession;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getPlatformMeta.mockResolvedValue({ bootstrapState: "READY", version: "9.8.1" } as PlatformMeta);
  api.getAdministratorSession.mockResolvedValue(session);
  api.getEnterpriseSession.mockRejectedValue(new Error("no enterprise session"));
  api.getConnections.mockResolvedValue({ items: [] });
  api.getConnectionMonitoring.mockResolvedValue({
    enabled: true, intervalSeconds: 300, reason: null, updatedAt: "2026-08-15T00:00:00.000Z", updatedBy: null,
  } as ConnectionMonitoringControl);
  api.getChatMetrics.mockResolvedValue({
    conversations: 0, responses: 0, completed: 0, failed: 0, cancelled: 0,
    totalTokens: 0, averageLatencyMs: 0, failureRate: 0,
    windowStartedAt: "2026-08-22T00:00:00.000Z",
    feedback: { helpful: 0, notHelpful: 0 },
  });
  api.getAgentMetrics.mockResolvedValue({
    profiles: 0, activeProfiles: 0, queuedRuns: 0, runningRuns: 0, completedRuns: 0, failedRuns: 0,
  });
  api.getToolMetrics.mockResolvedValue({
    activeTools: 0, activeGrants: 0, pendingApprovals: 0,
    executingCalls: 0, completedCalls: 0, deniedCalls: 0, failedCalls: 0,
  });
  api.getAgentRuntime.mockResolvedValue({ enabled: false } as AgentRuntimeControl);
  api.getAgentProfiles.mockResolvedValue({ items: [] });
  api.getHermesRuntimeNodes.mockResolvedValue({ items: [] });
  api.getModelDeployments.mockResolvedValue({ items: [] });
  api.getOnboardingSnapshot.mockResolvedValue({
    generatedAt: "2026-08-22T00:00:00.000Z",
    architecture: { topologyMode: "COMPACT", targetEnvironment: "DEVELOPMENT", reason: "Pilot", revision: 1 },
  } as OnboardingSnapshot);
  api.getGatewayUsage.mockReturnValue(new Promise(() => undefined));
  api.getAgentRuns.mockReturnValue(new Promise(() => undefined));
  api.getOperationalIncidents.mockReturnValue(new Promise(() => undefined));
  api.revokeAdministratorSession.mockResolvedValue(undefined);
  api.revokeEnterpriseSession.mockResolvedValue(undefined);
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"), media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.location.hash = "";
});

afterEach(cleanup);

describe("the first-run Setup lock", () => {
  it("lands a fresh administrator on Setup and hides the rest of the rail", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("region", { name: /^Step 1:/ })).toBeTruthy(), { timeout: 3_000 });
    expect(screen.getByRole("button", { name: /^Settings/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Dashboard/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Agents/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Access$/ })).toBeNull();
  });

  it("replaces a Session deep link with Setup while the runtime is not ready", async () => {
    window.location.hash = "#session";
    render(<App />);
    await waitFor(() => expect(screen.getByRole("region", { name: /^Step 1:/ })).toBeTruthy(), { timeout: 3_000 });
    expect(window.location.hash).toMatch(/#settings\/setup/);
    expect(screen.queryByRole("button", { name: /^Session/ })).toBeNull();
  });

  it("returns the full rail once the runtime step is done", async () => {
    api.getConnections.mockResolvedValue({
      items: [
        { id: "inference-connection", kind: "INFERENCE", enabled: true, status: "HEALTHY" },
        { id: "hermes-connection", kind: "HERMES", enabled: true, status: "HEALTHY" },
      ] as ServiceConnectionSummary[],
    });
    api.getHermesRuntimeNodes.mockResolvedValue({
      items: [{
        status: "ONLINE",
        revokedAt: null,
        lastSeenAt: new Date().toISOString(),
        enrolledAt: "2026-08-15T00:00:00.000Z",
      } as HermesRuntimeNode],
    });
    api.getModelDeployments.mockResolvedValue({
      items: [{
        workload: "AGENT",
        status: "ACTIVE",
        isDefault: true,
        connection: { id: "inference-connection" },
      } as ModelDeployment],
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Session/ })).toBeTruthy(), { timeout: 3_000 });
    expect(screen.getByRole("button", { name: /^Dashboard/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Step 1:/ })).toBeNull();
  });
});
