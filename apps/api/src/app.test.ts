import type { AIHubPrismaClient } from "@aihub/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationsManager } from "./operations/operations-manager.js";
import { createApp } from "./app.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("AIHub API", () => {
  it("reports service health", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "REQUIRED" } });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "aihub-api" });
  });

  it("reports that dashboard configuration is enabled", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "REQUIRED" } });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/platform" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      product: "MPM AIHub",
      configurationMode: "dashboard",
    });
  });

  it("separates process liveness from database-backed readiness", async () => {
    const unavailable = await createApp({ logger: false, runtime: { bootstrapState: "LOCKED" } });
    apps.push(unavailable);
    const locked = await unavailable.inject({ method: "GET", url: "/readyz" });
    expect(locked.statusCode).toBe(503);
    expect(locked.json()).toMatchObject({ status: "degraded", service: "aihub-api-readiness" });

    const query = vi.fn(async () => [{ ready: 1 }]);
    const disconnect = vi.fn(async () => undefined);
    const prisma = { $queryRaw: query, $disconnect: disconnect } as unknown as AIHubPrismaClient;
    const ready = await createApp({ logger: false, runtime: { bootstrapState: "READY", prisma } });
    apps.push(ready);
    const response = await ready.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "aihub-api-readiness" });
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(query).toHaveBeenCalledOnce();
  });

  it("releases runtime resources when job operations fail to start", async () => {
    const stop = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const operationsManager = {
      start: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      stop,
    } as unknown as OperationsManager;
    const prisma = { $disconnect: disconnect } as unknown as AIHubPrismaClient;

    await expect(createApp({
      logger: false,
      runtime: { bootstrapState: "READY", operationsManager, prisma },
    })).rejects.toThrow("queue unavailable");

    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
