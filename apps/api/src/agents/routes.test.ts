import { ADMIN_SCOPES, type AdministratorSession, type AgentProfile, type AgentRun } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { AgentRuntimeDisabledError, type AgentManager } from "./agent-manager.js";

const TOKEN = "a".repeat(43);
const PROFILE_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const RUN_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T00:15:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};
const profile: AgentProfile = {
  id: PROFILE_ID, slug: "hermes-analyst", status: "ACTIVE", currentVersion: 1, activeVersion: 1,
  version: {
    id: "b41d3534-658b-4cf0-a046-2b20b15f44e5", version: 1, displayName: "Hermes Analyst",
    purpose: "Internal analysis", instructions: "Answer only the authorized request.", modelAlias: "hermes-agent",
    soulMd: "You are a careful internal analyst who follows the approved evidence.", skills: [],
    maxTurns: 1, timeoutSeconds: 600, maxConcurrentRuns: 2, allowPrivateKnowledge: true, safeMode: true,
    createdAt: "2026-07-30T00:00:00.000Z", createdBy: session.id,
    distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  activeVersionConfiguration: null,
  createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
};
profile.activeVersionConfiguration = profile.version;
const run: AgentRun = {
  id: RUN_ID, profileId: PROFILE_ID, profileSlug: profile.slug, profileName: profile.version.displayName,
  profileVersion: 1, profileDistributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "QUEUED", input: "Analyze policy", output: null,
  effectiveCapabilities: ["knowledge:private:read"], sources: [], failureCode: null, failureMessage: null,
  queuedAt: "2026-07-30T00:00:00.000Z", startedAt: null, completedAt: null,
  createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return true; }
}

function manager(): AgentManager {
  return {
    listProfiles: vi.fn(async () => ({ items: [profile] })),
    createProfile: vi.fn(async () => profile),
    updateProfile: vi.fn(async () => profile),
    standbyProfile: vi.fn(async (): Promise<AgentProfile> => ({ ...profile, status: "STANDBY" })),
    activateProfile: vi.fn(async () => profile),
    suspendProfile: vi.fn(async (): Promise<AgentProfile> => ({ ...profile, status: "SUSPENDED" })),
    listRuns: vi.fn(async () => ({ items: [run] })),
    getRun: vi.fn(async () => run),
    listRunEvents: vi.fn(async () => ({ items: [{
      id: "d1fab491-ce72-4efe-8845-4d44150849d6", runId: RUN_ID, type: "SUBAGENT_COMPLETED" as const,
      summary: "Bounded research completed.", status: "completed", toolName: null, childSessionId: "child-1",
      durationMs: 1200, inputTokens: 20, outputTokens: 30, costUsd: null, occurredAt: "2026-07-30T00:00:01.000Z",
    }] })),
    submitRun: vi.fn(async () => run),
    cancelRun: vi.fn(async (): Promise<AgentRun> => ({ ...run, status: "CANCEL_REQUESTED" })),
    getRuntimeControl: vi.fn(async () => ({ enabled: false, reason: "Acceptance pending.", updatedAt: "2026-07-30T00:00:00.000Z", updatedBy: null })),
    updateRuntimeControl: vi.fn(async (_principal, input) => ({ enabled: input.enabled, reason: input.reason, updatedAt: "2026-07-30T00:00:00.000Z", updatedBy: session.id })),
    metrics: vi.fn(async () => ({ generatedAt: "2026-07-30T00:00:00.000Z", profiles: 1, activeProfiles: 1, queuedRuns: 1, runningRuns: 0, completedRuns: 0, failedRuns: 0 })),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function agentApp(agentManager = manager()) {
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions(), agentManager } });
  apps.push(app);
  return { app, agentManager };
}

describe("Hermes agent routes", () => {
  it("fails closed without an authenticated identity", async () => {
    const { app } = await agentApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/agents/profiles" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/agents/runtime" })).statusCode).toBe(401);
  });

  it("exposes administrator profile, runtime, metrics, and run ledgers", async () => {
    const { app } = await agentApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/agents/profiles", headers })).json()).toMatchObject({ items: [{ slug: "hermes-analyst" }] });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/agents/runs", headers })).json()).toMatchObject({ items: [{ status: "QUEUED" }] });
    expect((await app.inject({ method: "GET", url: `/api/v1/admin/agents/runs/${RUN_ID}/events`, headers })).json()).toMatchObject({ items: [{ type: "SUBAGENT_COMPLETED", childSessionId: "child-1" }] });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/agents/metrics", headers })).json()).toMatchObject({ profiles: 1 });
  });

  it("validates and submits a bounded run", async () => {
    const { app, agentManager } = await agentApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    const invalid = await app.inject({ method: "POST", url: "/api/v1/agents/runs", headers, payload: { profileId: PROFILE_ID, input: "" } });
    const queued = await app.inject({ method: "POST", url: "/api/v1/agents/runs", headers, payload: { profileId: PROFILE_ID, input: "Analyze policy" } });
    expect(invalid.statusCode).toBe(400);
    expect(queued.statusCode).toBe(202);
    expect(agentManager.submitRun).toHaveBeenCalledWith(expect.objectContaining({ subject: "platform-admin" }), { profileId: PROFILE_ID, input: "Analyze policy" });
  });

  it("changes runtime state only with a reason", async () => {
    const { app, agentManager } = await agentApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "PATCH", url: "/api/v1/admin/agents/runtime", headers, payload: { enabled: true, reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/admin/agents/runtime", headers, payload: { enabled: true, reason: "Boundary verified." } })).statusCode).toBe(200);
    expect(agentManager.updateRuntimeControl).toHaveBeenCalled();
  });

  it("reports boundary denial with a stable service response", async () => {
    const denied = manager();
    denied.updateRuntimeControl = vi.fn(async () => { throw new AgentRuntimeDisabledError("Hermes boundary verification failed."); });
    const deniedApp = await agentApp(denied);
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    const runtime = await deniedApp.app.inject({ method: "PATCH", url: "/api/v1/admin/agents/runtime", headers, payload: { enabled: true, reason: "Verify zero tools" } });
    expect(runtime.statusCode).toBe(423);
    expect(runtime.json()).toMatchObject({ error: "AGENT_RUNTIME_DISABLED" });
  });
});
