import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime, type WorkerQueueRuntime } from "./worker-runtime.js";
import type { WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

const identity: WorkerIdentity = {
  id: "worker-1",
  name: "worker.local",
  version: "0.1.0",
  queues: ["aihub.system.probe"],
};

describe("WorkerRuntime", () => {
  it("registers the worker and records a clean shutdown", async () => {
    const queue: WorkerQueueRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      registerSystemProbeWorker: vi.fn(async () => "pg-boss-worker-id"),
    };
    const registry: WorkerRegistry = {
      markStarted: vi.fn(async () => undefined),
      markAlive: vi.fn(async () => undefined),
      markStopped: vi.fn(async () => undefined),
    };
    const runtime = new WorkerRuntime(
      queue,
      registry,
      identity,
      { info: vi.fn(), error: vi.fn() },
      60_000,
    );

    await runtime.start();
    await runtime.stop();

    expect(queue.start).toHaveBeenCalledOnce();
    expect(queue.registerSystemProbeWorker).toHaveBeenCalledWith(identity.id);
    expect(registry.markStarted).toHaveBeenCalledWith(identity);
    expect(registry.markStopped).toHaveBeenCalledWith(identity.id);
    expect(queue.stop).toHaveBeenCalledOnce();
  });

  it("marks the worker stopped when handler registration fails", async () => {
    const queue: WorkerQueueRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      registerSystemProbeWorker: vi.fn(async () => {
        throw new Error("registration failed");
      }),
    };
    const registry: WorkerRegistry = {
      markStarted: vi.fn(async () => undefined),
      markAlive: vi.fn(async () => undefined),
      markStopped: vi.fn(async () => undefined),
    };
    const runtime = new WorkerRuntime(
      queue,
      registry,
      identity,
      { info: vi.fn(), error: vi.fn() },
      60_000,
    );

    await expect(runtime.start()).rejects.toThrow("registration failed");

    expect(registry.markStopped).toHaveBeenCalledWith(identity.id);
    expect(queue.stop).toHaveBeenCalledOnce();
  });
});
