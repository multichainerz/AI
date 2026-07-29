import type {
  AdministratorSession,
  JobOperationsSnapshot,
  JobProbeResult,
  JobQueueName,
} from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  ADMIN_SESSION_COOKIE,
  type AdminSessionManager,
} from "../auth/admin-session.js";
import type { OperationsManager } from "./operations-manager.js";

const JOB_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const SESSION_TOKEN = "a".repeat(43);
const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const principal: AdministratorSession = {
  id: SESSION_ID,
  subject: "test-operator",
  role: "PLATFORM_ADMIN",
  scopes: [
    "connections:read",
    "connections:write",
    "connections:test",
    "operations:read",
    "operations:execute",
    "audit:read",
    "sessions:manage",
  ],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T00:15:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

class MemorySessionManager implements AdminSessionManager {
  async createBootstrapSession() { return null; }
  async authenticate(token: string | undefined) {
    return token === SESSION_TOKEN ? principal : null;
  }
  async revoke() { return false; }
}

const sessionHeaders = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };

class MemoryOperationsManager implements OperationsManager {
  readonly start = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly retry = vi.fn(async (_queue: JobQueueName, _jobId: string) => undefined);
  readonly redriveDeadLetters = vi.fn(async (_limit: number) => 2);

  async snapshot(): Promise<JobOperationsSnapshot> {
    const capturedAt = new Date().toISOString();
    return {
      engine: "pg-boss",
      status: "ONLINE",
      statusReasons: [],
      queues: [
        {
          name: "aihub.system.probe",
          displayName: "System probe",
          configured: true,
          readyCount: 0,
          deferredCount: 0,
          activeCount: 0,
          failedCount: 0,
          totalCount: 4,
          capturedAt,
        },
      ],
      workers: [
        {
          id: "worker-1",
          name: "worker.local",
          status: "ONLINE",
          startedAt: capturedAt,
          lastSeenAt: capturedAt,
          version: "0.1.0",
          queues: ["aihub.system.probe"],
        },
      ],
      capturedAt,
    };
  }

  async sendProbe(): Promise<JobProbeResult> {
    return {
      jobId: JOB_ID,
      queue: "aihub.system.probe",
      queuedAt: new Date().toISOString(),
    };
  }
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function operationsApp() {
  const manager = new MemoryOperationsManager();
  const app = await createApp({
    logger: false,
    runtime: {
      bootstrapState: "READY",
      sessionManager: new MemorySessionManager(),
      operationsManager: manager,
    },
  });
  apps.push(app);
  return { app, manager };
}

describe("administrator job operations routes", () => {
  it("fails closed without administrator authentication", async () => {
    const { app } = await operationsApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/operations/jobs" });

    expect(response.statusCode).toBe(401);
  });

  it("returns queue and worker health", async () => {
    const { app, manager } = await operationsApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/jobs",
      headers: sessionHeaders,
    });

    expect(manager.start).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      engine: "pg-boss",
      status: "ONLINE",
      queues: [{ name: "aihub.system.probe" }],
      workers: [{ status: "ONLINE" }],
    });
  });

  it("queues a system probe", async () => {
    const { app } = await operationsApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/operations/jobs/probe",
      headers: sessionHeaders,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ jobId: JOB_ID, queue: "aihub.system.probe" });
  });

  it("validates retry targets and bounds dead-letter redrives", async () => {
    const { app, manager } = await operationsApp();

    const invalidRetry = await app.inject({
      method: "POST",
      url: "/api/v1/admin/operations/jobs/queues/not-a-queue/jobs/not-a-job/retry",
      headers: sessionHeaders,
    });
    const redrive = await app.inject({
      method: "POST",
      url: "/api/v1/admin/operations/jobs/dead-letter/redrive",
      headers: sessionHeaders,
      payload: { limit: 25 },
    });

    expect(invalidRetry.statusCode).toBe(400);
    expect(redrive.statusCode).toBe(202);
    expect(redrive.json()).toMatchObject({ accepted: true, message: "2 dead-letter jobs redriven." });
    expect(manager.redriveDeadLetters).toHaveBeenCalledWith(
      25,
      expect.objectContaining({ id: SESSION_ID, subject: "test-operator" }),
    );
  });
});
