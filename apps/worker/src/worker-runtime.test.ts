import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { describe, expect, it, vi } from "vitest";
import { WorkerRuntime } from "./worker-runtime.js";
import type { WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

const identity: WorkerIdentity = {
  id: "runtime-1",
  name: "runtime.local",
  version: "0.1.0",
  workloads: ["documents", "memory", "agents", "tool-actions"],
};

function prisma(documentWork: Array<{ documentId: string; generation: number; conversionJobId: string }> = []) {
  return {
    documentProcessingRun: { findMany: vi.fn(async () => documentWork) },
    documentMemoryPublication: { findMany: vi.fn(async () => []) },
    agentRun: { findMany: vi.fn(async () => []) },
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

  it("reconciles durable document state when the runtime starts", async () => {
    const documentHandler = { convert: vi.fn(async () => ({ converted: true })) };
    const runtime = new WorkerRuntime(prisma([{
      documentId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      generation: 2,
      conversionJobId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
    }]), registry(), identity, { info: vi.fn(), error: vi.fn() }, 60_000, documentHandler);

    await runtime.start();
    expect(documentHandler.convert).toHaveBeenCalledWith(
      { documentId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d", generation: 2 },
      "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      identity.id,
    );
    await runtime.stop();
  });
});
