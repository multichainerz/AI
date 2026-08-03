import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime } from "./worker-runtime.js";
import type { WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

const identity: WorkerIdentity = {
  id: "runtime-1",
  name: "runtime.local",
  version: "0.1.0",
  workloads: ["hermes-runs"],
};

function prisma(agentWork: Array<{ id: string; jobId: string }> = []) {
  return {
    agentRun: {
      // Mirrors the exclusion and page size the runtime relies on so slot
      // accounting is exercised rather than assumed.
      findMany: vi.fn(async (query?: { where?: { id?: { notIn?: string[] } }; take?: number }) => {
        const excluded = query?.where?.id?.notIn ?? [];
        const available = agentWork.filter((item) => !excluded.includes(item.id));
        return typeof query?.take === "number" ? available.slice(0, query.take) : available;
      }),
    },
  } as unknown as OrcaSynapsePrismaClient;
}

function registry(): WorkerRegistry {
  return {
    markStarted: vi.fn(async () => undefined),
    markAlive: vi.fn(async () => undefined),
    markStopped: vi.fn(async () => undefined),
  };
}

describe("WorkerRuntime", () => {
  it("registers the PostgreSQL executor and records a clean shutdown", async () => {
    const records = registry();
    const runtime = new WorkerRuntime(prisma(), records, identity, { info: vi.fn(), error: vi.fn() }, 60_000);

    await runtime.start();
    await runtime.stop();

    expect(records.markStarted).toHaveBeenCalledWith(identity);
    expect(records.markStopped).toHaveBeenCalledWith(identity.id);
  });

  it("reconciles durable Hermes run state when the runtime starts", async () => {
    const agentHandler = { process: vi.fn(async () => ({ completed: true })) };
    const database = prisma([{
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      jobId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
    }]);
    const runtime = new WorkerRuntime(database, registry(), identity, { info: vi.fn(), error: vi.fn() }, 60_000, agentHandler);

    await runtime.start();
    expect(database.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ processorLeaseExpiresAt: null }, { processorLeaseExpiresAt: { lt: expect.any(Date) } }],
      }),
    }));
    expect(agentHandler.process).toHaveBeenCalledWith(
      { runId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d" },
      "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      identity.id,
    );
    await runtime.stop();
  });

  it("rediscovers a run left waiting on an approval decision by a stopped worker", async () => {
    const agentHandler = { process: vi.fn(async () => ({ completed: true })) };
    const database = prisma();
    const runtime = new WorkerRuntime(database, registry(), identity, { info: vi.fn(), error: vi.fn() }, 60_000, agentHandler);

    await runtime.start();

    expect(database.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"] },
      }),
    }));
    await runtime.stop();
  });

  it("drains every leased run before shutdown even when one of them fails", async () => {
    const failing = "1f1b6c02-9a1e-4a52-9a1a-0c0f5a2b9d31";
    const slow = "2b2c7d13-8b2f-4b63-8b2b-1d1e6b3c8e42";
    let slowFinished = false;
    const agentHandler = {
      process: vi.fn(async ({ runId }: { runId: string }) => {
        if (runId === failing) throw new Error("Hermes execution failed.");
        await new Promise((resolve) => setTimeout(resolve, 20));
        slowFinished = true;
        return { completed: true };
      }),
    };
    const error = vi.fn();
    const database = prisma([
      { id: failing, jobId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb" },
      { id: slow, jobId: "7df7df2c-b9d7-4e88-c7bb-12ae46999bdc" },
    ]);
    const runtime = new WorkerRuntime(database, registry(), identity, { info: vi.fn(), error }, 60_000, agentHandler);

    await runtime.start();
    await runtime.stop();

    expect(slowFinished).toBe(true);
    expect(error).toHaveBeenCalled();
  });

  it("starts newly queued work while an earlier run is still executing", async () => {
    const blocked = "3c3d8e24-a1c3-4c74-9c3c-2e2f7c4d0f53";
    const queuedLater = "4d4e9f35-b2d4-4d85-ad4d-3f307d5e1a64";
    let releaseBlocked: (() => void) | undefined;
    const available = [{ id: blocked, jobId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb" }];
    const agentHandler = {
      process: vi.fn(async ({ runId }: { runId: string }) => {
        if (runId === blocked) await new Promise<void>((resolve) => { releaseBlocked = resolve; });
        return { completed: true };
      }),
    };
    const runtime = new WorkerRuntime(
      prisma(available), registry(), identity, { info: vi.fn(), error: vi.fn() }, 60_000, agentHandler, 1_000, 2,
    );

    await runtime.start();
    expect(agentHandler.process).toHaveBeenCalledTimes(1);

    // A second conversation arrives while the first run is still mid-flight.
    available.push({ id: queuedLater, jobId: "7df7df2c-b9d7-4e88-8c7b-12ae46999bdc" });
    await (runtime as unknown as { dispatchAgents(): Promise<void> }).dispatchAgents();

    expect(agentHandler.process).toHaveBeenCalledTimes(2);
    expect(agentHandler.process).toHaveBeenLastCalledWith(
      { runId: queuedLater },
      "7df7df2c-b9d7-4e88-8c7b-12ae46999bdc",
      identity.id,
    );

    releaseBlocked?.();
    await runtime.stop();
  });

  it("admits no more than the configured number of concurrent runs", async () => {
    const gate: Array<() => void> = [];
    const agentHandler = {
      process: vi.fn(() => new Promise<object>((resolve) => { gate.push(() => resolve({ completed: true })); })),
    };
    const database = prisma([
      { id: "5e5fa046-c3e5-4f96-be5e-40418e6f2b75", jobId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb" },
      { id: "6f6ab157-d4f6-4a07-cf6f-51529f703c86", jobId: "7df7df2c-b9d7-4e88-8c7b-12ae46999bdc" },
      { id: "7a7bc268-e5a7-4b18-da7a-6263a0814d97", jobId: "8ea8ea3d-cae8-4f99-9d8c-23bf57aaacde" },
    ]);
    const runtime = new WorkerRuntime(
      database, registry(), identity, { info: vi.fn(), error: vi.fn() }, 60_000, agentHandler, 1_000, 2,
    );

    await runtime.start();

    expect(agentHandler.process).toHaveBeenCalledTimes(2);
    expect(database.agentRun.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 2 }));

    for (const release of gate) release();
    await runtime.stop();
  });
});
