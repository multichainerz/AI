import type { AdministratorSession, RuntimeOperationsSnapshot } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { OperationsManager } from "./operations-manager.js";

const SESSION_TOKEN = "a".repeat(43);
const principal: AdministratorSession = {
  id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb", subject: "test-operator", role: "PLATFORM_ADMIN",
  scopes: ["connections:read", "operations:read"], createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T00:15:00.000Z", absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

class MemorySessionManager implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === SESSION_TOKEN ? principal : null; }
  async revoke() { return false; }
}

class MemoryOperationsManager implements OperationsManager {
  readonly start = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  async snapshot(): Promise<RuntimeOperationsSnapshot> {
    const capturedAt = new Date().toISOString();
    return {
      engine: "postgresql-state", status: "ONLINE", statusReasons: [], capturedAt,
      workloads: [{ name: "agents", displayName: "Hermes runs", pendingCount: 0, activeCount: 1, failedCount: 0, totalCount: 1 }],
      executors: [{ id: "runtime-1", name: "runtime.local", status: "ONLINE", startedAt: capturedAt, lastSeenAt: capturedAt, version: "0.1.0", workloads: ["agents"] }],
    };
  }
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function operationsApp() {
  const manager = new MemoryOperationsManager();
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new MemorySessionManager(), operationsManager: manager } });
  apps.push(app);
  return { app, manager };
}

describe("administrator runtime operations routes", () => {
  it("fails closed without administrator authentication", async () => {
    const { app } = await operationsApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/operations/runtime" })).statusCode).toBe(401);
  });

  it("returns PostgreSQL workload and executor health", async () => {
    const { app, manager } = await operationsApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/operations/runtime", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` } });
    expect(manager.start).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ engine: "postgresql-state", workloads: [{ name: "agents" }], executors: [{ status: "ONLINE" }] });
  });
});
