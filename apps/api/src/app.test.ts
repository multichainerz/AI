import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import type { OrcaSynapseDatabase } from "@orcasynapse/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationsManager } from "./operations/operations-manager.js";
import { createApp } from "./app.js";

/**
 * One patch above whatever this build is, derived rather than written down.
 *
 * The release-check case used to hardcode the shipped version and a literal
 * successor, so every version bump failed a test that had found nothing wrong —
 * the release ritual and the test disagreed once per release, by construction.
 */
const NEWER_RELEASE_TAG = (() => {
  // Tolerates the retired `ai-` prefix for the same reason the parser does.
  // Deriving the successor is not enough on its own: the first version of this
  // helper hardcoded the prefix in its own pattern, so the moment the prefix was
  // dropped it silently matched nothing, returned the current version unchanged,
  // and asserted that a release was newer than itself.
  const match = /^(?:ai-)?v(\d+)\.(\d+)\.(\d+)$/.exec(ORCASYNAPSE_VERSION);
  if (!match) throw new Error(`ORCASYNAPSE_VERSION '${ORCASYNAPSE_VERSION}' is not a release tag.`);
  const [, major, minor, patch] = match;
  return `v${major}.${minor}.${Number(patch) + 1}`;
})();

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("OrcaSynapse API", () => {
  it("reports service health", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "REQUIRED" } });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "orcasynapse-api" });
  });

  it("reports that dashboard configuration is enabled", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "REQUIRED" } });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/platform" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      product: "OrcaSynapse",
      configurationMode: "dashboard",
    });
  });

  it("proxies release checks without giving the dashboard host control", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify([
      { name: NEWER_RELEASE_TAG },
      { name: ORCASYNAPSE_VERSION },
    ]), { status: 200 }));
    const app = await createApp({ logger: false, runtime: { bootstrapState: "READY" } });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/platform/update" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      currentVersion: ORCASYNAPSE_VERSION,
      latestVersion: NEWER_RELEASE_TAG,
      updateAvailable: true,
      automaticUpdateSupported: false,
    });
  });

  it("separates process liveness from database-backed readiness", async () => {
    const unavailable = await createApp({ logger: false, runtime: { bootstrapState: "LOCKED" } });
    apps.push(unavailable);
    const locked = await unavailable.inject({ method: "GET", url: "/readyz" });
    expect(locked.statusCode).toBe(503);
    expect(locked.json()).toMatchObject({ status: "degraded", service: "orcasynapse-api-readiness" });

    const query = vi.fn(async () => ({ rows: [{ ready: 1 }] }));
    const database = { execute: query } as unknown as OrcaSynapseDatabase;
    const ready = await createApp({ logger: false, runtime: { bootstrapState: "READY", database } });
    apps.push(ready);
    const response = await ready.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "orcasynapse-api-readiness" });
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(query).toHaveBeenCalledOnce();
  });

  it("releases runtime resources when job operations fail to start", async () => {
    const stop = vi.fn(async () => undefined);
    const closeDatabase = vi.fn(async () => undefined);
    const operationsManager = {
      start: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      stop,
    } as unknown as OperationsManager;
    await expect(createApp({
      logger: false,
      runtime: { bootstrapState: "READY", operationsManager, closeDatabase },
    })).rejects.toThrow("queue unavailable");

    expect(stop).toHaveBeenCalledOnce();
    // The single pool must be released when startup fails partway through.
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("answers 400 rather than 500 for unparseable JSON", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "READY" } });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/local",
      headers: { "content-type": "application/json" },
      payload: Buffer.from("{", "utf8"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).not.toMatchObject({ error: "INTERNAL_ERROR" });
  });
});
