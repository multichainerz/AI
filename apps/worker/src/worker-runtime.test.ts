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
    agentRun: { findMany: vi.fn(async () => agentWork) },
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
});
