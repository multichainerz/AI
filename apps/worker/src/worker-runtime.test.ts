import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime } from "./worker-runtime.js";
import type { PendingRun, PendingRunSource, WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

const identity: WorkerIdentity = {
  id: "runtime-1",
  name: "runtime.local",
  version: "0.1.0",
  workloads: ["hermes-runs"],
};

/**
 * Scheduling is exercised without a database: what belongs here is slot
 * accounting and shutdown draining, not the query that decides what is
 * claimable, which is covered against real PostgreSQL in worker-registry.test.
 */
function source(available: PendingRun[]): PendingRunSource & { claimable: ReturnType<typeof vi.fn> } {
  const claimable = vi.fn(async (limit: number, excludeIds: string[]) =>
    available.filter((run) => !excludeIds.includes(run.id)).slice(0, limit),
  );
  return { claimable };
}

function registry(): WorkerRegistry {
  return {
    markStarted: vi.fn(async () => undefined),
    markAlive: vi.fn(async () => undefined),
    markStopped: vi.fn(async () => undefined),
  };
}

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe("WorkerRuntime", () => {
  it("registers the executor and records a clean shutdown", async () => {
    const records = registry();
    const runtime = new WorkerRuntime(source([]), records, identity, logger(), 60_000);

    await runtime.start();
    await runtime.stop();

    expect(records.markStarted).toHaveBeenCalledWith(identity);
    expect(records.markStopped).toHaveBeenCalledWith(identity.id);
  });

  it("dispatches claimable runs when the runtime starts", async () => {
    const handler = { process: vi.fn(async () => ({ completed: true })) };
    const runs = source([{ id: "run-1", jobId: "job-1" }]);
    const runtime = new WorkerRuntime(runs, registry(), identity, logger(), 60_000, handler);

    await runtime.start();

    expect(handler.process).toHaveBeenCalledWith({ runId: "run-1" }, "job-1", identity.id);
    await runtime.stop();
  });

  it("drains every dispatched run before shutdown even when one of them fails", async () => {
    let slowFinished = false;
    const handler = {
      process: vi.fn(async ({ runId }: { runId: string }) => {
        if (runId === "failing") throw new Error("Hermes execution failed.");
        await new Promise((resolve) => setTimeout(resolve, 20));
        slowFinished = true;
        return { completed: true };
      }),
    };
    const error = vi.fn();
    const runtime = new WorkerRuntime(
      source([{ id: "failing", jobId: "job-1" }, { id: "slow", jobId: "job-2" }]),
      registry(),
      identity,
      { info: vi.fn(), error },
      60_000,
      handler,
    );

    await runtime.start();
    await runtime.stop();

    expect(slowFinished).toBe(true);
    expect(error).toHaveBeenCalled();
  });

  it("drains an in-flight memory sweep before shutdown", async () => {
    /*
     * `stop()` awaited `dispatching` and `inFlight`, and both are populated only
     * by `dispatchAgents` -- so a sweep in progress was simply abandoned. The
     * sweep claims before it extracts: its batch is stamped `memoryExtractedAt`
     * by the claiming UPDATE and the notes are written afterwards, so a shutdown
     * in between left those runs marked done with nothing recorded and nothing
     * to revisit them.
     */
    let sweepFinished = false;
    const handler = {
      process: vi.fn(async () => ({ completed: true })),
      drainMemoryExtraction: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        sweepFinished = true;
        return 1;
      }),
    };
    const runtime = new WorkerRuntime(
      source([]), registry(), identity, logger(), 60_000, handler, 60_000, 5,
      // Sweep immediately, so one is in flight when stop() is called.
      1,
    );

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.stop();

    expect(sweepFinished).toBe(true);
  });

  it("does not start a second sweep on top of one still running", async () => {
    // The claim is atomic so two sweeps cannot take the same run, but they can
    // run more concurrent extractions than the interval was chosen to allow.
    let active = 0;
    let overlapped = false;
    const handler = {
      process: vi.fn(async () => ({ completed: true })),
      drainMemoryExtraction: vi.fn(async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return 1;
      }),
    };
    const runtime = new WorkerRuntime(
      source([]), registry(), identity, logger(), 60_000, handler, 60_000, 5, 1,
    );

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runtime.stop();

    expect(overlapped).toBe(false);
  });

  it("starts newly queued work while an earlier run is still executing", async () => {
    let release: (() => void) | undefined;
    const available: PendingRun[] = [{ id: "blocked", jobId: "job-1" }];
    const runs = source(available);
    const handler = {
      process: vi.fn(async ({ runId }: { runId: string }) => {
        if (runId === "blocked") await new Promise<void>((resolve) => { release = resolve; });
        return { completed: true };
      }),
    };
    const runtime = new WorkerRuntime(runs, registry(), identity, logger(), 60_000, handler, 1_000, 2);

    await runtime.start();
    expect(handler.process).toHaveBeenCalledTimes(1);

    available.push({ id: "later", jobId: "job-2" });
    await (runtime as unknown as { dispatchAgents(): Promise<void> }).dispatchAgents();

    expect(handler.process).toHaveBeenCalledTimes(2);
    expect(handler.process).toHaveBeenLastCalledWith({ runId: "later" }, "job-2", identity.id);

    release?.();
    await runtime.stop();
  });

  it("admits no more than the configured number of concurrent runs", async () => {
    const gate: Array<() => void> = [];
    const handler = {
      process: vi.fn(() => new Promise<object>((resolve) => { gate.push(() => resolve({ completed: true })); })),
    };
    const runs = source([
      { id: "a", jobId: "job-1" },
      { id: "b", jobId: "job-2" },
      { id: "c", jobId: "job-3" },
    ]);
    const runtime = new WorkerRuntime(runs, registry(), identity, logger(), 60_000, handler, 1_000, 2);

    await runtime.start();

    expect(handler.process).toHaveBeenCalledTimes(2);
    expect(runs.claimable).toHaveBeenLastCalledWith(2, []);

    for (const release of gate) release();
    await runtime.stop();
  });

  it("asks for no work once every slot is occupied", async () => {
    const handler = { process: vi.fn(() => new Promise<object>(() => undefined)) };
    const runs = source([{ id: "a", jobId: "job-1" }]);
    const runtime = new WorkerRuntime(runs, registry(), identity, logger(), 60_000, handler, 1_000, 1);

    await runtime.start();
    await (runtime as unknown as { dispatchAgents(): Promise<void> }).dispatchAgents();

    // One slot, one occupant: the second tick must not even ask for work.
    expect(runs.claimable).toHaveBeenCalledTimes(1);
  });

  it("dispatches immediately when woken, without waiting for the tick", async () => {
    const handler = { process: vi.fn(async () => ({ completed: true })) };
    const available: PendingRun[] = [];
    const runs = source(available);
    // A long tick, so anything that runs here can only have come from the wake.
    const runtime = new WorkerRuntime(runs, registry(), identity, logger(), 60_000, handler, 600_000);

    await runtime.start();
    expect(handler.process).not.toHaveBeenCalled();

    available.push({ id: "woken", jobId: "job-1" });
    await runtime.dispatchNow();

    expect(handler.process).toHaveBeenCalledWith({ runId: "woken" }, "job-1", identity.id);
    await runtime.stop();
  });

  it("ignores a wake that arrives after shutdown", async () => {
    const handler = { process: vi.fn(async () => ({ completed: true })) };
    const runtime = new WorkerRuntime(
      source([{ id: "late", jobId: "job-1" }]), registry(), identity, logger(), 60_000, handler, 600_000,
    );

    await runtime.start();
    handler.process.mockClear();
    await runtime.stop();
    await runtime.dispatchNow();

    // A notification in flight during shutdown must not admit new work.
    expect(handler.process).not.toHaveBeenCalled();
  });

});
