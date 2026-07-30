import type { AIHubPrismaClient } from "@aihub/database";
import { describe, expect, it, vi } from "vitest";
import { ConnectionMonitorRuntime } from "./connection-monitor.js";
import type { ConnectionTestService } from "./diagnostics/connection-test-service.js";

const CONNECTION_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";

function harness(options: { enabled?: boolean; testError?: Error; releaseError?: Error } = {}) {
  let claimToken = "";
  const serviceUpdateMany = vi.fn(async () => {
    if (options.releaseError) throw options.releaseError;
    return { count: 1 };
  });
  const auditCreate = vi.fn(async () => ({}));
  const prismaBase: any = {
    connectionMonitoringControl: {
      findUnique: vi.fn(async () => ({
        id: "global",
        enabled: options.enabled ?? true,
        intervalSeconds: 300,
        reason: "Pilot monitoring",
        updatedBy: SESSION_ID,
        updatedAt: new Date("2026-07-30T00:00:00.000Z"),
      })),
      upsert: vi.fn(async ({ update }: any) => ({
        id: "global",
        ...update,
        updatedAt: new Date("2026-07-30T00:00:00.000Z"),
      })),
    },
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const query = parts.join(" ");
      return query.includes('FROM "ConnectionMonitoringControl"')
        ? [{ enabled: options.enabled ?? true, intervalSeconds: 300 }]
        : [{ id: CONNECTION_ID }];
    }),
    serviceConnection: {
      update: vi.fn(async ({ data }: any) => {
        claimToken = data.monitoringClaimToken;
        return { id: CONNECTION_ID };
      }),
      updateMany: serviceUpdateMany,
    },
    auditEvent: { create: auditCreate },
  };
  prismaBase.$transaction = vi.fn(async (callback: (transaction: any) => Promise<unknown>) => callback(prismaBase));
  const tester = {
    test: options.testError
      ? vi.fn(async () => { throw options.testError; })
      : vi.fn(async () => ({ connectionId: CONNECTION_ID, status: "HEALTHY" })),
  } as unknown as ConnectionTestService;
  const logger = { error: vi.fn() };
  return {
    monitor: new ConnectionMonitorRuntime(
      prismaBase as AIHubPrismaClient,
      tester,
      logger,
      "monitor-1",
      60_000,
    ),
    prismaBase,
    tester,
    serviceUpdateMany,
    auditCreate,
    claimToken: () => claimToken,
  };
}

describe("ConnectionMonitorRuntime", () => {
  it("does not claim a connection while scheduled monitoring is disabled", async () => {
    const test = harness({ enabled: false });

    await expect(test.monitor.processOneDueConnection()).resolves.toBe(false);

    expect(test.prismaBase.$queryRaw).toHaveBeenCalledTimes(1);
    expect(test.prismaBase.serviceConnection.update).not.toHaveBeenCalled();
    expect(test.tester.test).not.toHaveBeenCalled();
  });

  it("claims one due connection and releases its exact lease after testing", async () => {
    const test = harness();

    await expect(test.monitor.processOneDueConnection()).resolves.toBe(true);

    expect(test.tester.test).toHaveBeenCalledWith(CONNECTION_ID);
    expect(test.claimToken()).toMatch(/^[0-9a-f-]{36}$/i);
    const claimQuery = test.prismaBase.$queryRaw.mock.calls[1][0].join(" ");
    expect(claimQuery).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimQuery).toContain("INTERVAL '2 minutes'");
    expect(test.serviceUpdateMany).toHaveBeenCalledWith({
      where: { id: CONNECTION_ID, monitoringClaimToken: test.claimToken() },
      data: { monitoringClaimedAt: null, monitoringClaimedBy: null, monitoringClaimToken: null },
    });
  });

  it("records a sanitized degraded result and releases the lease when configuration resolution fails", async () => {
    const test = harness({ testError: new Error("private decryption detail") });

    await expect(test.monitor.processOneDueConnection()).resolves.toBe(true);

    expect(test.serviceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CONNECTION_ID, monitoringClaimToken: test.claimToken() },
      data: expect.objectContaining({
        status: "DEGRADED",
        lastHealthcheckMessage: "Automated check could not resolve the stored connection configuration.",
        monitoringClaimToken: null,
      }),
    }));
    expect(JSON.stringify(test.serviceUpdateMany.mock.calls)).not.toContain("private decryption detail");
    expect(test.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "connection.monitor_failed", actorType: "SYSTEM" }),
    }));
  });

  it("does not replace a completed diagnostic when PostgreSQL fails to release its lease", async () => {
    const test = harness({ releaseError: new Error("database unavailable") });

    await expect(test.monitor.processOneDueConnection()).rejects.toThrow("database unavailable");

    expect(test.tester.test).toHaveBeenCalledWith(CONNECTION_ID);
    expect(test.serviceUpdateMany).toHaveBeenCalledTimes(1);
    expect(test.auditCreate).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "connection.monitor_failed" }),
    }));
  });

  it("persists dashboard control changes and clears leases when monitoring is disabled", async () => {
    const test = harness();

    await expect(test.monitor.updateControl(
      { id: SESSION_ID, subject: "platform-admin" },
      { enabled: false, intervalSeconds: 900, reason: "Maintenance window" },
    )).resolves.toMatchObject({ enabled: false, intervalSeconds: 900 });

    expect(test.serviceUpdateMany).toHaveBeenCalledWith({
      where: { monitoringClaimToken: { not: null } },
      data: { monitoringClaimedAt: null, monitoringClaimedBy: null, monitoringClaimToken: null },
    });
    expect(test.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "connection.monitoring_disabled", actorId: SESSION_ID }),
    }));
  });
});
