import type { AIHubPrismaClient } from "@aihub/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaOperationsManager } from "./prisma-operations-manager.js";

afterEach(() => vi.useRealTimers());

function emptyGroups() { return vi.fn(async () => []); }

describe("PrismaOperationsManager", () => {
  it("prunes stale executor history when starting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const prisma = { workerNode: { deleteMany } } as unknown as AIHubPrismaClient;
    await new PrismaOperationsManager(prisma).start();
    expect(deleteMany).toHaveBeenCalledWith({ where: { lastSeenAt: { lt: new Date("2026-06-30T12:00:00.000Z") } } });
  });

  it("reports durable domain workload counts and executor liveness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const prisma = {
      document: { groupBy: vi.fn(async () => [{ status: "QUEUED", _count: { _all: 2 } }]) },
      documentMemoryPublication: { groupBy: emptyGroups() },
      agentRun: { groupBy: vi.fn(async () => [{ status: "RUNNING", _count: { _all: 1 } }]) },
      toolActionDispatch: { groupBy: emptyGroups() },
      workerNode: { findMany: vi.fn(async () => [{
        id: "runtime-1", name: "runtime.local", version: "0.1.0", status: "ONLINE", workloads: ["documents", "agents", "legacy"],
        startedAt: new Date("2026-07-29T11:00:00.000Z"), lastSeenAt: new Date("2026-07-29T11:59:50.000Z"),
      }]) },
    } as unknown as AIHubPrismaClient;
    const snapshot = await new PrismaOperationsManager(prisma).snapshot();
    expect(snapshot).toMatchObject({
      engine: "postgresql-state", status: "ONLINE",
      workloads: expect.arrayContaining([
        expect.objectContaining({ name: "documents", pendingCount: 2 }),
        expect.objectContaining({ name: "memory" }),
        expect.objectContaining({ name: "agents", activeCount: 1 }),
      ]),
      executors: [{ id: "runtime-1", status: "ONLINE", workloads: ["documents", "agents"] }],
    });
  });

  it("degrades without a current runtime executor heartbeat", async () => {
    const prisma = {
      document: { groupBy: emptyGroups() }, documentMemoryPublication: { groupBy: emptyGroups() },
      agentRun: { groupBy: emptyGroups() }, toolActionDispatch: { groupBy: emptyGroups() },
      workerNode: { findMany: vi.fn(async () => []) },
    } as unknown as AIHubPrismaClient;
    const snapshot = await new PrismaOperationsManager(prisma).snapshot();
    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.statusReasons[0]).toContain("No online PostgreSQL runtime executor");
  });
});
