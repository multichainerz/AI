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

  it("registers document conversion and OCR handlers when the pipeline is configured", async () => {
    const queue: WorkerQueueRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      registerSystemProbeWorker: vi.fn(async () => "probe-worker"),
      registerDocumentConversionWorker: vi.fn(async () => "convert-worker"),
      registerDocumentOcrWorker: vi.fn(async () => "ocr-worker"),
    };
    const registry: WorkerRegistry = {
      markStarted: vi.fn(async () => undefined),
      markAlive: vi.fn(async () => undefined),
      markStopped: vi.fn(async () => undefined),
    };
    const handlers = {
      convert: vi.fn(async () => ({ converted: true })),
      runOcr: vi.fn(async () => ({ extracted: true })),
    };
    const runtime = new WorkerRuntime(
      queue,
      registry,
      identity,
      { info: vi.fn(), error: vi.fn() },
      60_000,
      handlers,
    );

    await runtime.start();

    expect(queue.registerDocumentConversionWorker).toHaveBeenCalledWith(identity.id, expect.any(Function));
    expect(queue.registerDocumentOcrWorker).toHaveBeenCalledWith(identity.id, expect.any(Function));
    await runtime.stop();
  });

  it("registers the memory synchronization handler when configured", async () => {
    const queue: WorkerQueueRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      registerSystemProbeWorker: vi.fn(async () => "probe-worker"),
      registerMemoryIndexWorker: vi.fn(async () => "memory-worker"),
    };
    const registry: WorkerRegistry = {
      markStarted: vi.fn(async () => undefined),
      markAlive: vi.fn(async () => undefined),
      markStopped: vi.fn(async () => undefined),
    };
    const memoryHandler = { process: vi.fn(async () => ({ synchronized: true })) };
    const runtime = new WorkerRuntime(
      queue,
      registry,
      identity,
      { info: vi.fn(), error: vi.fn() },
      60_000,
      undefined,
      memoryHandler,
    );

    await runtime.start();

    expect(queue.registerMemoryIndexWorker).toHaveBeenCalledWith(identity.id, expect.any(Function));
    await runtime.stop();
  });

  it("registers the Hermes run handler when configured", async () => {
    const queue: WorkerQueueRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      registerSystemProbeWorker: vi.fn(async () => "probe-worker"),
      registerAgentRunWorker: vi.fn(async () => "agent-worker"),
    };
    const registry: WorkerRegistry = {
      markStarted: vi.fn(async () => undefined), markAlive: vi.fn(async () => undefined), markStopped: vi.fn(async () => undefined),
    };
    const agentHandler = { process: vi.fn(async () => ({ completed: true })) };
    const runtime = new WorkerRuntime(
      queue, registry, identity, { info: vi.fn(), error: vi.fn() }, 60_000,
      undefined, undefined, agentHandler,
    );

    await runtime.start();

    expect(queue.registerAgentRunWorker).toHaveBeenCalledWith(identity.id, expect.any(Function));
    await runtime.stop();
  });
});
