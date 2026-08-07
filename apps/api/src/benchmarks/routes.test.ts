import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type BenchmarkRun,
  type BenchmarkSuite,
  type EvaluationRun,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import {
  BenchmarkSuiteNotFoundError,
  BenchmarkTargetUnavailableError,
  type BenchmarkManager,
} from "./benchmark-manager.js";

const TOKEN = "a".repeat(43);
const READER_TOKEN = "b".repeat(43);
const SUITE_ID = "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b";
const RUN_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-08-07T00:00:00.000Z",
  idleExpiresAt: "2026-08-07T01:00:00.000Z",
  absoluteExpiresAt: "2026-08-07T08:00:00.000Z",
};

/** May read the evidence, may not commission or change it. */
const auditor: AdministratorSession = {
  ...session,
  id: "b1d8a1a4-5a4c-4b2f-9d0e-6c7b8a9f0e11",
  subject: "auditor",
  role: "AUDITOR",
  scopes: ["evaluations:read", "audit:read"],
};

const suite: BenchmarkSuite = {
  id: SUITE_ID,
  slug: "chat-baseline",
  displayName: "Chat baseline",
  description: "The questions this installation must keep answering correctly.",
  kind: "CHAT_QUALITY",
  cases: [{
    id: "cites-runbook",
    prompt: "What should we check before promoting?",
    intent: "A promotion question must cite the runbook.",
    assertions: [{ kind: "MUST_INCLUDE", value: "migrations" }],
  }],
  passThreshold: 0.9,
  revision: 1,
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

const queued: BenchmarkRun = {
  id: RUN_ID,
  suiteId: SUITE_ID,
  suiteSlug: "chat-baseline",
  suiteRevision: 1,
  kind: "CHAT_QUALITY",
  status: "QUEUED",
  target: {
    agentProfileId: null,
    agentProfileSlug: null,
    agentProfileVersion: null,
    modelAlias: null,
    ownerSubject: "platform-admin",
  },
  totalCases: 0,
  passedCases: 0,
  passRate: null,
  medianLatencyMs: null,
  results: [],
  failureMessage: null,
  evaluationRunId: null,
  requestedBy: session.id,
  queuedAt: "2026-08-07T09:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) {
    if (token === TOKEN) return session;
    return token === READER_TOKEN ? auditor : null;
  }
  async revoke() { return false; }
}

function manager(): BenchmarkManager {
  return {
    listSuites: vi.fn(async () => ({ items: [suite] })),
    createSuite: vi.fn(async () => suite),
    updateSuite: vi.fn(async () => ({ ...suite, revision: 2 })),
    deleteSuite: vi.fn(async () => undefined),
    startRun: vi.fn(async () => queued),
    listRuns: vi.fn(async () => ({ items: [queued] })),
    getRun: vi.fn(async () => queued),
    cancelRun: vi.fn(async () => ({ ...queued, status: "CANCELLED" as const })),
    attachEvidence: vi.fn(async () => evaluation),
  };
}

const evaluation: EvaluationRun = {
  id: "5c1e0b6a-2f3d-4a7b-8c9d-0e1f2a3b4c5d",
  name: "chat-baseline — revision 1",
  targetType: "AGENT",
  targetReference: "support-analyst",
  targetVersion: "v3",
  status: "PASSED",
  minimumPassRate: 0.9,
  requiredCategories: ["CHAT"],
  results: [{
    category: "CHAT",
    totalCases: 10,
    passedCases: 10,
    criticalFailures: 0,
    passRate: 1,
    status: "PASSED",
    evidenceRefs: ["benchmark:chat-baseline@1:7c9e6679-7425-40de-944b-e07fc1f90ae7"],
  }],
  totalCases: 10,
  passedCases: 10,
  criticalFailures: 0,
  passRate: 1,
  createdAt: "2026-08-07T10:00:00.000Z",
  completedAt: "2026-08-07T10:00:00.000Z",
  promotedAt: null,
  promotionReason: null,
};

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function benchmarkApp(benchmarkManager = manager()) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(), benchmarkManager },
  });
  apps.push(app);
  return { app, benchmarkManager };
}

const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
const readerHeaders = { cookie: `${ADMIN_SESSION_COOKIE}=${READER_TOKEN}` };

describe("benchmark suite routes", () => {
  it("requires an authenticated reader", async () => {
    const { app } = await benchmarkApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/benchmarks/suites" })).statusCode).toBe(401);
  });

  it("lets an auditor read suites but never author or run them", async () => {
    const { app, benchmarkManager } = await benchmarkApp();

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/benchmarks/suites", headers: readerHeaders })).json())
      .toMatchObject({ items: [{ slug: "chat-baseline" }] });

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/admin/benchmarks/runs",
      headers: readerHeaders,
      payload: { suiteId: SUITE_ID },
    });
    expect(denied.statusCode).toBe(403);
    expect(benchmarkManager.startRun).not.toHaveBeenCalled();
  });

  it("rejects a suite whose cases assert nothing before the manager sees it", async () => {
    const { app, benchmarkManager } = await benchmarkApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/benchmarks/suites",
      headers,
      payload: { ...suite, cases: [{ ...suite.cases[0]!, assertions: [] }] },
    });
    expect(response.statusCode).toBe(400);
    expect(benchmarkManager.createSuite).not.toHaveBeenCalled();
  });

  it("requires the expected revision on an edit", async () => {
    const { app, benchmarkManager } = await benchmarkApp();

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/benchmarks/suites/${SUITE_ID}`,
      headers,
      payload: { displayName: "Renamed" },
    });
    expect(stale.statusCode).toBe(400);
    expect(benchmarkManager.updateSuite).not.toHaveBeenCalled();

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/benchmarks/suites/${SUITE_ID}`,
      headers,
      payload: { expectedRevision: 1, displayName: "Renamed" },
    });
    expect(ok.json()).toMatchObject({ revision: 2 });
  });

  it("reports a missing suite as 404 rather than a server error", async () => {
    const benchmarkManager = manager();
    benchmarkManager.updateSuite = vi.fn(async () => { throw new BenchmarkSuiteNotFoundError("No such suite."); });
    const { app } = await benchmarkApp(benchmarkManager);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/benchmarks/suites/${SUITE_ID}`,
      headers,
      payload: { expectedRevision: 1, displayName: "Renamed" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("benchmark run routes", () => {
  it("accepts a run for later rather than executing it on the request", async () => {
    // 202: a suite of forty cases is minutes of inference, and tying the result
    // to an open browser tab would lose it when the tab closes.
    const { app } = await benchmarkApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/benchmarks/runs",
      headers,
      payload: { suiteId: SUITE_ID },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "QUEUED", passRate: null });
  });

  it("refuses to queue a run with nothing to measure, instead of scoring it zero", async () => {
    // A queued run with no active Profile would complete at 0% and enter the
    // history as a regression the model never caused.
    const benchmarkManager = manager();
    benchmarkManager.startRun = vi.fn(async () => {
      throw new BenchmarkTargetUnavailableError("No active Agent Profile to benchmark.");
    });
    const { app } = await benchmarkApp(benchmarkManager);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/benchmarks/runs",
      headers,
      payload: { suiteId: SUITE_ID },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "BENCHMARK_TARGET_UNAVAILABLE" });
  });

  it("keeps run results out of shared caches", async () => {
    // Results carry prompts and answer excerpts.
    const { app } = await benchmarkApp();
    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/benchmarks/runs", headers: readerHeaders });
    expect(listed.headers["cache-control"]).toBe("no-store");
    const single = await app.inject({ method: "GET", url: `/api/v1/admin/benchmarks/runs/${RUN_ID}`, headers: readerHeaders });
    expect(single.headers["cache-control"]).toBe("no-store");
  });

  it("validates the page size before querying", async () => {
    const { app, benchmarkManager } = await benchmarkApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/benchmarks/runs?limit=5000", headers });
    expect(response.statusCode).toBe(400);
    expect(benchmarkManager.listRuns).not.toHaveBeenCalled();
  });

  it("lets an operator stop a run that is already going", async () => {
    const { app } = await benchmarkApp();
    const response = await app.inject({ method: "POST", url: `/api/v1/admin/benchmarks/runs/${RUN_ID}/cancel`, headers });
    expect(response.json()).toMatchObject({ status: "CANCELLED" });
  });

  it("records a completed run in the evaluation ledger", async () => {
    const { app } = await benchmarkApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/benchmarks/runs/${RUN_ID}/evaluation`,
      headers,
      payload: {
        name: "chat-baseline — revision 1",
        category: "CHAT",
        targetType: "AGENT",
        targetReference: "support-analyst",
        targetVersion: "v3",
        minimumPassRate: 0.9,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: "PASSED", requiredCategories: ["CHAT"] });
  });

  it("lets an auditor read the evidence but never enter it as a gate", async () => {
    const { app, benchmarkManager } = await benchmarkApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/benchmarks/runs/${RUN_ID}/evaluation`,
      headers: readerHeaders,
      payload: { name: "Gate", category: "CHAT", targetType: "AGENT", targetReference: "a", targetVersion: "1", minimumPassRate: 0.9 },
    });
    expect(response.statusCode).toBe(403);
    expect(benchmarkManager.attachEvidence).not.toHaveBeenCalled();
  });

  it("locks the surface when benchmark services are not ready", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions() } });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/benchmarks/suites", headers })).statusCode).toBe(423);
  });
});
