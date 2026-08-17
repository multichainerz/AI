import {
  ADMIN_SCOPES,
  type AdminScope,
  type AdministratorSession,
  type UsageBreakdown,
  type UsageReport,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { UsageManager, UsageReportOptions } from "./usage-manager.js";

const TOKEN = "a".repeat(43);

function sessionWith(scopes: readonly AdminScope[]): AdministratorSession {
  return {
    id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
    subject: "platform-admin",
    role: "PLATFORM_ADMIN",
    scopes: [...scopes],
    createdAt: "2026-08-17T00:00:00.000Z",
    idleExpiresAt: "2026-08-17T01:00:00.000Z",
    absoluteExpiresAt: "2026-08-17T08:00:00.000Z",
  };
}

/**
 * Honours `requiredScope`, unlike the fixtures on screens whose sessions carry
 * every scope. This suite's whole subject is a session that holds one scope and
 * not another, so a fake that ignored the argument would pass either way.
 */
class Sessions implements AdminSessionManager {
  constructor(private readonly scopes: readonly AdminScope[]) {}
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined, requiredScope?: AdminScope) {
    if (token !== TOKEN) return null;
    if (requiredScope && !this.scopes.includes(requiredScope)) return null;
    return sessionWith(this.scopes);
  }
  async revoke() { return false; }
}

const emptyBreakdown: UsageBreakdown = { rows: [], truncated: false, other: null };

const report: UsageReport = {
  window: "24h",
  windowStartedAt: "2026-08-16T00:00:00.000Z",
  generatedAt: "2026-08-17T00:00:00.000Z",
  bucket: "hour",
  totals: {
    runs: 3, completed: 2, failed: 1, cancelled: 0, denied: 0, timedOut: 0,
    inputTokens: 100, outputTokens: 200, reasoningTokens: 0, totalTokens: 300,
    tokensReported: 2, tokensUnreported: 1,
    costUsd: null, costReportedRuns: 0, costUnreportedRuns: 3,
    averageLatencyMs: 1_200, p95LatencyMs: 2_400, averageFirstTokenMs: 300,
    failureRate: 1 / 3,
  },
  series: [],
  byModel: emptyBreakdown,
  byProfile: emptyBreakdown,
  byDivision: emptyBreakdown,
  byUser: { rows: [{
    key: "someone", label: "someone", runs: 3, failed: 1,
    inputTokens: 100, outputTokens: 200, totalTokens: 300,
    costUsd: null, averageLatencyMs: 1_200,
  }], truncated: false, other: null },
  gateway: { requests: 9, rejected: 2, rejectedByPolicy: 1, rejectedByRateLimit: 1 },
  tools: { calls: 0, completed: 0, denied: 0, failed: 0 },
};

function manager() {
  return {
    report: vi.fn(async (options: UsageReportOptions): Promise<UsageReport> => ({
      ...report,
      window: options.window,
      byUser: options.includeUsers ? report.byUser : null,
    })),
  } satisfies UsageManager;
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function usageApp(scopes: readonly AdminScope[], usageManager = manager()) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(scopes), usageManager },
  });
  apps.push(app);
  return { app, usageManager };
}

const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };

describe("gateway usage routes", () => {
  it("refuses an unauthenticated reader", async () => {
    const { app } = await usageApp([...ADMIN_SCOPES]);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage" })).statusCode).toBe(401);
  });

  it("refuses a session without the operations scope", async () => {
    const { app } = await usageApp(["audit:read"]);
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage", headers });
    expect(response.statusCode).not.toBe(200);
  });

  it("defaults to the 24 hour window and validates the ones it accepts", async () => {
    const { app, usageManager } = await usageApp([...ADMIN_SCOPES]);

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage", headers })).statusCode).toBe(200);
    expect(usageManager.report).toHaveBeenCalledWith(expect.objectContaining({ window: "24h" }));

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage?window=30d", headers })).json())
      .toMatchObject({ window: "30d" });

    // A window the contract does not admit is a 400 rather than a silent
    // fallback: reading a different span than the one asked for is worse than
    // being told the request was wrong.
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage?window=90d", headers })).statusCode)
      .toBe(400);
  });

  it("hands the per-person breakdown only to a session holding audit:read", async () => {
    /*
     * The split this route exists to make. `operations:read` is enough for the
     * report -- OPERATIONS_ADMIN holds it -- and not enough to see which named
     * person spent what, which is the audit trail's question and sits behind
     * the audit trail's scope.
     */
    const withAudit = await usageApp([...ADMIN_SCOPES]);
    expect((await withAudit.app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage", headers })).json().byUser)
      .toMatchObject({ rows: [{ label: "someone" }] });
    expect(withAudit.usageManager.report).toHaveBeenCalledWith(expect.objectContaining({ includeUsers: true }));

    const withoutAudit = await usageApp(["operations:read"]);
    const response = await withoutAudit.app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage", headers });
    expect(response.statusCode).toBe(200);
    // Null, not absent and not empty: the contract distinguishes "you may not
    // see this" from "nobody used it", and a `{}` here would erase that.
    expect(response.json().byUser).toBeNull();
    expect(withoutAudit.usageManager.report).toHaveBeenCalledWith(expect.objectContaining({ includeUsers: false }));
  });

  it("reports the control plane as locked rather than empty when the manager is absent", async () => {
    const app = await createApp({
      logger: false,
      runtime: { bootstrapState: "READY", sessionManager: new Sessions([...ADMIN_SCOPES]) },
    });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/gateway/usage", headers })).statusCode).toBe(423);
  });
});
