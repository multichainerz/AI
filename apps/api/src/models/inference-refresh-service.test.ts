import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelDeployment, ModelObservationList, ServiceConnectionSummary } from "@orcasynapse/contracts";
import { InferenceRefreshService, ModelRefreshError } from "./inference-refresh-service.js";
import type { ModelManager, ObservationSyncResult } from "./model-manager.js";
import type { ObservedModelSnapshot } from "./observed-catalogue.js";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";

afterEach(() => vi.unstubAllGlobals());

const CONNECTION_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const principal = { id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "platform-admin" } as never;

const healthy: ServiceConnectionSummary = {
  id: CONNECTION_ID,
  slug: "inference-primary",
  displayName: "Primary vLLM",
  kind: "INFERENCE",
  environment: "PRODUCTION",
  baseUrl: "http://gpu.internal:8000",
  enabled: true,
  status: "HEALTHY",
  configuration: {},
  activeRevision: 1,
  secretFieldNames: ["apiKey"],
  lastHealthcheckAt: "2026-08-22T00:00:00.000Z",
  lastHealthcheckMessage: "ok",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

function resolved(over: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: CONNECTION_ID,
    activeRevision: 1,
    kind: "INFERENCE",
    baseUrl: "http://gpu.internal:8000",
    configuration: { modelsPath: "/v1/models" },
    secrets: { apiKey: "stored-secret" },
    ...over,
  };
}

function connections(
  items: ServiceConnectionSummary[],
  current: ResolvedConnection,
): ConnectionDiagnosticStore & { list(): Promise<ServiceConnectionSummary[]> } {
  return {
    list: async () => items,
    resolveForDiagnostic: async (id) => {
      if (id !== current.id) throw new Error("missing");
      return current;
    },
    recordDiagnostic: async () => true,
  };
}

function models(over: Partial<ModelManager> = {}): ModelManager {
  let stored: ModelObservationList = { connectionId: CONNECTION_ID, refreshedAt: null, items: [] };
  return {
    list: vi.fn(async () => ({ items: [] })),
    listObservations: vi.fn(async () => stored),
    replaceObservations: vi.fn(async (_id: string, snapshots: ObservedModelSnapshot[], seenAt: Date) => {
      stored = {
        connectionId: CONNECTION_ID,
        refreshedAt: seenAt.toISOString(),
        items: snapshots.map((snapshot, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          connectionId: CONNECTION_ID,
          alias: snapshot.alias,
          displayName: snapshot.displayName,
          observedContextWindowTokens: snapshot.observedContextWindowTokens,
          observedMaxOutputTokens: snapshot.observedMaxOutputTokens,
          inputModalities: snapshot.inputModalities,
          ownedBy: snapshot.ownedBy,
          lastSeenAt: seenAt.toISOString(),
          missingFromUpstream: false,
          admittedWorkloads: [],
        })),
      };
      return { upserted: snapshots.length, vanished: 0 } satisfies ObservationSyncResult;
    }),
    maybeBackfillLegacyAlias: vi.fn(async () => null),
    create: vi.fn(async () => ({}) as ModelDeployment),
    update: vi.fn(async () => ({}) as ModelDeployment),
    activate: vi.fn(async () => ({}) as ModelDeployment),
    suspend: vi.fn(async () => ({}) as ModelDeployment),
    ...over,
  };
}

describe("InferenceRefreshService", () => {
  it("uses the stored endpoint and key, not a pasted OpenRouter credential", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "hermes-agent" }] }));
    const manager = models();
    const service = new InferenceRefreshService(
      connections([healthy], resolved()),
      manager,
      fetchMock as typeof fetch,
    );

    const result = await service.refresh(principal, CONNECTION_ID);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://gpu.internal:8000/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: "Bearer stored-secret" },
    });
    expect(result.items).toEqual([expect.objectContaining({
      alias: "hermes-agent",
      observedContextWindowTokens: null,
      inputModalities: [],
    })]);
    expect(manager.maybeBackfillLegacyAlias).toHaveBeenCalled();
  });

  it("maps an OpenRouter catalogue through the stored OpenRouter endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      data: [{
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        context_length: 200_000,
        architecture: { input_modalities: ["text", "image", "file"] },
        top_provider: { max_completion_tokens: 8_192 },
      }],
    }));
    const openrouter = {
      ...healthy,
      baseUrl: "https://openrouter.ai",
      displayName: "OpenRouter",
    };
    const service = new InferenceRefreshService(
      connections([openrouter], resolved({
        baseUrl: "https://openrouter.ai",
        configuration: {},
      })),
      models(),
      fetchMock as typeof fetch,
    );

    const result = await service.refresh(principal, CONNECTION_ID);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/models");
    expect(result.items[0]).toMatchObject({
      alias: "anthropic/claude-sonnet-4",
      observedContextWindowTokens: 200_000,
      observedMaxOutputTokens: 8_192,
      inputModalities: ["text", "image", "file"],
    });
  });

  it("refuses refresh when inference is not a unique healthy connection", async () => {
    const service = new InferenceRefreshService(
      connections([healthy, { ...healthy, id: "11111111-1111-4111-8111-111111111111", slug: "second" }], resolved()),
      models(),
      vi.fn() as unknown as typeof fetch,
    );
    await expect(service.refresh(principal, CONNECTION_ID)).rejects.toMatchObject({
      name: "ModelRefreshError",
      code: "NOT_CONFIGURED",
    });
  });

  it("does not treat a 401 as a successful refresh", async () => {
    const service = new InferenceRefreshService(
      connections([healthy], resolved()),
      models(),
      vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch,
    );
    await expect(service.refresh(principal, CONNECTION_ID)).rejects.toBeInstanceOf(ModelRefreshError);
  });
});
