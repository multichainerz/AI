import { afterEach, describe, expect, it, vi } from "vitest";
import { SupermemoryAdapter, SUPERMEMORY_LOCAL_READY_PATH } from "./supermemory-adapter.js";
import type { ResolvedConnection } from "./types.js";

const connection = (healthPath: string): ResolvedConnection => ({
  id: "d8233908-bf42-4d72-b2dc-9dcaac226de6",
  activeRevision: 1,
  kind: "SUPERMEMORY",
  baseUrl: "http://10.147.94.155:6767",
  configuration: { healthPath },
  secrets: { apiKey: "sm_test_key" },
});

afterEach(() => vi.unstubAllGlobals());

describe("SupermemoryAdapter", () => {
  it("recovers legacy /health connections through the Local readiness contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new SupermemoryAdapter().test(connection("/health"), new AbortController().signal))
      .resolves.toMatchObject({
        status: "HEALTHY",
        details: { healthPath: SUPERMEMORY_LOCAL_READY_PATH, legacyHealthPathRecovered: true },
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://10.147.94.155:6767/health",
      "http://10.147.94.155:6767/v4/openapi",
    ]);
  });

  it("does not hide authentication failures behind the compatibility fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new SupermemoryAdapter().test(connection("/health"), new AbortController().signal))
      .resolves.toMatchObject({ status: "DEGRADED", details: { authentication: "rejected" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
