import type { AIHubPrismaClient } from "@aihub/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrismaOperationsManager,
  type JobQueueOperations,
} from "./prisma-operations-manager.js";

afterEach(() => vi.useRealTimers());

describe("PrismaOperationsManager", () => {
  it("prunes worker history older than retention before starting queue operations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const prisma = { workerNode: { deleteMany } } as unknown as AIHubPrismaClient;
    const queue: JobQueueOperations = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => []),
      sendSystemProbe: vi.fn(async () => "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d"),
      retry: vi.fn(async () => undefined),
      redriveDeadLetters: vi.fn(async () => 0),
    };

    await new PrismaOperationsManager(prisma, queue).start();

    expect(deleteMany).toHaveBeenCalledWith({
      where: { lastSeenAt: { lt: new Date("2026-06-30T12:00:00.000Z") } },
    });
    expect(queue.start).toHaveBeenCalledOnce();
  });

  it("classifies worker liveness and limits the visible history window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const findMany = vi.fn(async () => [
      {
        id: "worker-online",
        name: "worker-01",
        version: "0.1.0",
        status: "ONLINE" as const,
        queues: ["aihub.system.probe", "unknown.queue"],
        startedAt: new Date("2026-07-29T11:00:00.000Z"),
        lastSeenAt: new Date("2026-07-29T11:59:50.000Z"),
      },
      {
        id: "worker-stale",
        name: "worker-02",
        version: "0.1.0",
        status: "ONLINE" as const,
        queues: ["aihub.system.probe"],
        startedAt: new Date("2026-07-29T10:00:00.000Z"),
        lastSeenAt: new Date("2026-07-29T11:58:00.000Z"),
      },
    ]);
    const prisma = {
      workerNode: { findMany },
    } as unknown as AIHubPrismaClient;
    const queue: JobQueueOperations = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => []),
      sendSystemProbe: vi.fn(async () => "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d"),
      retry: vi.fn(async () => undefined),
      redriveDeadLetters: vi.fn(async () => 0),
    };

    const snapshot = await new PrismaOperationsManager(prisma, queue).snapshot();

    expect(snapshot.status).toBe("ONLINE");
    expect(snapshot.workers).toEqual([
      expect.objectContaining({ id: "worker-online", status: "ONLINE", queues: ["aihub.system.probe"] }),
      expect.objectContaining({ id: "worker-stale", status: "STALE" }),
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { lastSeenAt: { gte: new Date("2026-07-28T12:00:00.000Z") } },
      take: 50,
    }));
  });

  it("degrades the snapshot when a required queue is missing", async () => {
    const capturedAt = new Date().toISOString();
    const prisma = {
      workerNode: {
        findMany: vi.fn(async () => [{
          id: "worker-online",
          name: "worker-01",
          version: "0.1.0",
          status: "ONLINE" as const,
          queues: ["aihub.system.probe"],
          startedAt: new Date(),
          lastSeenAt: new Date(),
        }]),
      },
    } as unknown as AIHubPrismaClient;
    const queue: JobQueueOperations = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => [{
        name: "aihub.system.probe" as const,
        displayName: "System probe",
        configured: false,
        readyCount: 0,
        deferredCount: 0,
        activeCount: 0,
        failedCount: 0,
        totalCount: 0,
        capturedAt,
      }]),
      sendSystemProbe: vi.fn(async () => "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d"),
      retry: vi.fn(async () => undefined),
      redriveDeadLetters: vi.fn(async () => 0),
    };

    const snapshot = await new PrismaOperationsManager(prisma, queue).snapshot();

    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.statusReasons).toContain("System probe queue is not configured.");
  });

  it("degrades when ready work has no advertising online worker", async () => {
    const capturedAt = new Date().toISOString();
    const prisma = {
      workerNode: {
        findMany: vi.fn(async () => [{
          id: "worker-online",
          name: "worker-01",
          version: "0.1.0",
          status: "ONLINE" as const,
          queues: ["aihub.system.probe"],
          startedAt: new Date(),
          lastSeenAt: new Date(),
        }]),
      },
    } as unknown as AIHubPrismaClient;
    const queue: JobQueueOperations = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => [{
        name: "aihub.documents.ocr" as const,
        displayName: "Document OCR",
        configured: true,
        readyCount: 2,
        deferredCount: 0,
        activeCount: 0,
        failedCount: 0,
        totalCount: 2,
        capturedAt,
      }]),
      sendSystemProbe: vi.fn(async () => "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d"),
      retry: vi.fn(async () => undefined),
      redriveDeadLetters: vi.fn(async () => 0),
    };

    const snapshot = await new PrismaOperationsManager(prisma, queue).snapshot();

    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.statusReasons).toContain(
      "Document OCR has 2 ready jobs but no online worker.",
    );
  });
});
