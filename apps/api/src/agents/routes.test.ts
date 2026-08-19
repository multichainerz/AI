import { ADMIN_SCOPES, type AdministratorSession, type AgentProfile, type AgentRun, type AgentRuntimeControl } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { ENTERPRISE_SESSION_COOKIE, type EnterpriseIdentityManager } from "../identity/enterprise-session.js";
import { AgentRuntimeDisabledError, type AgentManager } from "./agent-manager.js";

const TOKEN = "a".repeat(43);
const ENTERPRISE_TOKEN = "e".repeat(43);
const ENTERPRISE_SESSION_ID = "5f6b0d5f-0a2c-4a0e-8f1b-2a9d3c7e4b10";
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
  divisionId: null,
  version: {
    id: "b41d3534-658b-4cf0-a046-2b20b15f44e5", version: 1, displayName: "Hermes Analyst",
    purpose: "Internal analysis", instructions: "Answer only the authorized request.", modelAlias: "hermes-agent",
    soulMd: "You are a careful internal analyst who follows the approved evidence.",
    maxTurns: 1, timeoutSeconds: 600, maxConcurrentRuns: 2, safeMode: true,
    createdAt: "2026-07-30T00:00:00.000Z", createdBy: session.id,
    distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    toolSetId: null, skillSetId: null,
  },
  activeVersionConfiguration: null,
  createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
};
profile.activeVersionConfiguration = profile.version;
const run: AgentRun = {
  id: RUN_ID, profileId: PROFILE_ID, profileSlug: profile.slug, profileName: profile.version.displayName,
  profileVersion: 1, profileDistributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "QUEUED", input: "Analyze policy", output: null,
  partialOutput: "", modelAlias: "hermes-agent", inputTokens: null, outputTokens: null,
  reasoningTokens: null, totalTokens: null, finishReason: null,
  failureCode: null, failureMessage: null,
  queuedAt: "2026-07-30T00:00:00.000Z", startedAt: null, completedAt: null,
  createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return true; }
}

/*
 * An ordinary enterprise user. Their scopes are `chat:use` and `agents:use` and
 * never an `AdminScope`, which is the whole reason the boundary has to reach
 * them through a route they can actually call.
 */
const enterpriseIdentity: EnterpriseIdentityManager = {
  async signInWithPassword() { throw new Error("Not used"); },
  async changeLocalPassword() { throw new Error("Not used"); },
  async authenticate(token) {
    return token === ENTERPRISE_TOKEN ? {
      id: ENTERPRISE_SESSION_ID,
      subject: "user:2b7f3f2e-4a0d-4f2c-9a71-8c1e6d0b5a34",
      identityMode: "ENTERPRISE",
      displayName: "Pilot User",
      email: "pilot@orcasynapse.example",
      scopes: ["chat:use", "agents:use"], divisionId: null,
      session: {
        id: ENTERPRISE_SESSION_ID,
        identityMode: "ENTERPRISE",
        user: {
          id: "2b7f3f2e-4a0d-4f2c-9a71-8c1e6d0b5a34",
          displayName: "Pilot User",
          email: "pilot@orcasynapse.example",
        },
        scopes: ["chat:use", "agents:use"], divisionId: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        idleExpiresAt: "2026-07-30T08:00:00.000Z",
        absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
      },
    } : null;
  },
  async revoke() { return true; },
};

/*
 * One boundary state per manager, read by both the flag on the profile list and
 * the administrator's own runtime route -- as `DrizzleAgentManager` does, where
 * `listProfiles` derives the flag from `getRuntimeControl()`. A mock that let
 * the two disagree would be able to pass a test the product could not.
 */
const boundaryOff: AgentRuntimeControl = {
  enabled: false, memoryExtractionEnabled: true, reason: "Acceptance pending.", updatedAt: "2026-07-30T00:00:00.000Z", updatedBy: null,
};

function manager(boundary: AgentRuntimeControl = boundaryOff): AgentManager {
  return {
    listProfiles: vi.fn(async () => ({ items: [profile], executionEnabled: boundary.enabled })),
    createProfile: vi.fn(async () => profile),
    updateProfile: vi.fn(async () => profile),
    standbyProfile: vi.fn(async (): Promise<AgentProfile> => ({ ...profile, status: "STANDBY" })),
    activateProfile: vi.fn(async () => profile),
    suspendProfile: vi.fn(async (): Promise<AgentProfile> => ({ ...profile, status: "SUSPENDED" })),
    listRuns: vi.fn(async () => ({ items: [run] })),
    getRun: vi.fn(async () => run),
    listRunEvents: vi.fn(async () => ({ items: [{
      id: "d1fab491-ce72-4efe-8845-4d44150849d6", runId: RUN_ID, type: "SUBAGENT_COMPLETED" as const,
      cursor: "1", delta: null, preview: null, errorCode: null, approvalId: null,
      summary: "Bounded research completed.", status: "completed", toolName: null,
      toolCallKey: null, text: null, contentOffset: null, childSessionId: "child-1",
      durationMs: 1200, inputTokens: 20, outputTokens: 30, reasoningTokens: 5, costUsd: null, occurredAt: "2026-07-30T00:00:01.000Z",
    }] })),
    submitRun: vi.fn(async () => run),
    cancelRun: vi.fn(async (): Promise<AgentRun> => ({ ...run, status: "CANCEL_REQUESTED" })),
    runtimeCatalogue: vi.fn(async () => ({ toolsets: [], skills: [], enabledToolsets: 0 })),
    getRuntimeControl: vi.fn(async () => boundary),
    updateRuntimeControl: vi.fn(async (_principal, input) => ({ enabled: input.enabled, memoryExtractionEnabled: true, reason: input.reason, updatedAt: "2026-07-30T00:00:00.000Z", updatedBy: session.id })),
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

async function enterpriseApp(agentManager = manager()) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(), identityManager: enterpriseIdentity, agentManager },
  });
  apps.push(app);
  return { app, agentManager };
}

const enterpriseHeaders = { cookie: `${ENTERPRISE_SESSION_COOKIE}=${ENTERPRISE_TOKEN}` };

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

  it("keeps the boundary's own route out of an enterprise session's reach", async () => {
    /*
     * The premise of the test below, asserted rather than assumed. An enterprise
     * session holds `agents:use` and no `AdminScope`, and `/admin/agents/runtime`
     * is `adminOnly`, so the dashboard cannot learn the boundary's state from
     * there -- which is how "Open Session" came to be drawn enabled for an
     * enterprise user while execution was switched off.
     */
    const { app } = await enterpriseApp();

    // The same route, answered for an administrator, so the 401 below is about
    // the identity and not about a route that is broken for everyone.
    const asAdmin = await app.inject({ method: "GET", url: "/api/v1/admin/agents/runtime", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` } });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json()).toMatchObject({ enabled: false });

    const asEnterprise = await app.inject({ method: "GET", url: "/api/v1/admin/agents/runtime", headers: enterpriseHeaders });
    expect(asEnterprise.statusCode).toBe(401);
  });

  it("refuses an enterprise session that still owes a password change", async () => {
    const pendingIdentity: EnterpriseIdentityManager = {
      ...enterpriseIdentity,
      async authenticate(token) {
        const principal = await enterpriseIdentity.authenticate(token);
        if (!principal) return null;
        return {
          ...principal,
          session: { ...principal.session, passwordChangeRequired: true },
        };
      },
    };
    const app = await createApp({
      logger: false,
      runtime: {
        bootstrapState: "READY",
        sessionManager: new Sessions(),
        identityManager: pendingIdentity,
        agentManager: manager(),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents/profiles",
      headers: enterpriseHeaders,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
  });

  it("tells an enterprise caller whether execution is switched on at all", async () => {
    /*
     * One deployment-wide boolean the caller is already subject to: their run
     * submission is refused with `AGENT_RUNTIME_DISABLED` when it is false. It
     * rides on the profile list because that is the enterprise-readable route
     * the dashboard already calls before offering a session.
     */
    const off = await enterpriseApp();
    const disabled = await off.app.inject({ method: "GET", url: "/api/v1/agents/profiles", headers: enterpriseHeaders });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ items: [{ slug: "hermes-analyst" }], executionEnabled: false });

    // The other direction, from the same fixture: a flag hardcoded either way
    // would pass one of these two and fail the other.
    const on = await enterpriseApp(manager({
      enabled: true, memoryExtractionEnabled: true, reason: "Boundary verified.", updatedAt: "2026-07-30T00:00:00.000Z", updatedBy: session.id,
    }));
    const enabled = await on.app.inject({ method: "GET", url: "/api/v1/agents/profiles", headers: enterpriseHeaders });
    expect(enabled.json()).toMatchObject({ executionEnabled: true });
  });

  it("gives the enterprise caller the flag and none of the boundary's administrative record", async () => {
    /*
     * Why it was switched off, by whom and when are an administrator's to read
     * behind `agents:read`. The enterprise list carries the one bit that changes
     * what this caller may do and nothing that describes the operator who
     * changed it.
     */
    /* Not `session.id`: that is also the fixture profile's `createdBy`, so a
       search for it would find the author of a Profile the enterprise caller is
       entitled to see and say nothing about the boundary. */
    const switchedOffBy = "1d0a67c4-9b3e-4a52-8f77-0c4e2b6d9a83";
    const { app } = await enterpriseApp(manager({
      enabled: false,
      memoryExtractionEnabled: true,
      reason: "Suspended pending the VM2 acceptance review.",
      updatedAt: "2026-07-30T00:00:00.000Z",
      updatedBy: switchedOffBy,
    }));

    const body = (await app.inject({ method: "GET", url: "/api/v1/agents/profiles", headers: enterpriseHeaders })).json();

    // The administrator's own route still carries all three, so their absence
    // below is a redaction rather than an empty record.
    const boundary = (await app.inject({ method: "GET", url: "/api/v1/admin/agents/runtime", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` } })).json();
    expect(boundary).toMatchObject({
      reason: "Suspended pending the VM2 acceptance review.",
      updatedAt: "2026-07-30T00:00:00.000Z",
      updatedBy: switchedOffBy,
    });

    expect(Object.keys(body).sort()).toEqual(["executionEnabled", "items"]);
    expect(JSON.stringify(body)).not.toContain("Suspended pending the VM2 acceptance review.");
    expect(JSON.stringify(body)).not.toContain(switchedOffBy);
    expect(JSON.stringify(body)).not.toContain("updatedBy");
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
