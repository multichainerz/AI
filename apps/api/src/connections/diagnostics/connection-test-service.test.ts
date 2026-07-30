import type { ConnectionTestResult } from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionTestService } from "./connection-test-service.js";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "./types.js";

class MemoryDiagnosticStore implements ConnectionDiagnosticStore {
  recorded?: ConnectionTestResult;
  expectedRevision: number | undefined;

  constructor(private readonly connection: ResolvedConnection) {}

  async resolveForDiagnostic() {
    return this.connection;
  }

  async recordDiagnostic(result: ConnectionTestResult, _actor?: unknown, expectedRevision?: number) {
    this.recorded = result;
    this.expectedRevision = expectedRevision;
    return true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("ConnectionTestService", () => {
  it("records a configuration failure without making a network request", async () => {
    const store = new MemoryDiagnosticStore({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      activeRevision: 1,
      kind: "SUPERMEMORY",
      baseUrl: null,
      configuration: {},
      secrets: {},
    });
    const adapter = { test: vi.fn() };

    const result = await new ConnectionTestService(store, () => adapter).test(
      "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
    );

    expect(result).toMatchObject({
      status: "DEGRADED",
      message: "Connection endpoint URL is not configured.",
      details: { failure: "configuration" },
    });
    expect(adapter.test).not.toHaveBeenCalled();
    expect(store.recorded).toEqual(result);
    expect(store.expectedRevision).toBe(1);
  });

  it("persists an unreachable result without exposing network error details", async () => {
    const store = new MemoryDiagnosticStore({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      activeRevision: 1,
      kind: "VLLM",
      baseUrl: "https://vllm.mpm.internal",
      configuration: {},
      secrets: { apiKey: "private-token" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private DNS detail")));

    const result = await new ConnectionTestService(store).test(
      "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
    );

    expect(result).toMatchObject({
      status: "UNREACHABLE",
      message: "Service could not be reached with the configured endpoint.",
      details: { failure: "network" },
    });
    expect(JSON.stringify(result)).not.toContain("private DNS detail");
    expect(store.recorded).toEqual(result);
  });

  it("classifies an S3 authentication rejection as degraded rather than unreachable", async () => {
    const store = new MemoryDiagnosticStore({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      activeRevision: 1,
      kind: "SEAWEEDFS",
      baseUrl: "https://s3.mpm.internal",
      configuration: {},
      secrets: { accessKeyId: "key", secretAccessKey: "secret" },
    });
    const rejected = Object.assign(new Error("Forbidden"), {
      $metadata: { httpStatusCode: 403 },
    });
    const service = new ConnectionTestService(store, () => ({
      test: async () => Promise.reject(rejected),
    }));

    const result = await service.test("8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d");

    expect(result).toMatchObject({
      status: "DEGRADED",
      message: "Service is reachable but rejected the configured credentials or request.",
      details: { failure: "rejected", httpStatus: 403 },
    });
    expect(store.recorded).toEqual(result);
  });
});
