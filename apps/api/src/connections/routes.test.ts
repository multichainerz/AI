import type {
  CreateServiceConnection,
  AdministratorSession,
  ConnectionMonitoringControl,
  ConfigurationRevisionList,
  RollbackConfigurationResult,
  ServiceConnectionSummary,
  UpdateServiceConnection,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  ADMIN_SESSION_COOKIE,
  type AdminSessionManager,
} from "../auth/admin-session.js";
import type { ConnectionManager } from "./connection-manager.js";
import { ConnectionTestService } from "./diagnostics/connection-test-service.js";
import { InferenceDiscoveryService } from "./diagnostics/inference-discovery-service.js";
import { InferenceCatalogueService } from "./diagnostics/inference-catalogue-service.js";
import type { ConnectionDiagnosticStore } from "./diagnostics/types.js";
import type { ConnectionMonitorService } from "./connection-monitor.js";
import type { InferenceRefreshService } from "../models/inference-refresh-service.js";

const CONNECTION_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const SESSION_TOKEN = "a".repeat(43);
const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";

const principal: AdministratorSession = {
  id: SESSION_ID,
  subject: "test-administrator",
  role: "PLATFORM_ADMIN",
  scopes: [
    "connections:read",
    "connections:write",
    "connections:test",
    "operations:read",
    "operations:execute",
    "audit:read",
    "sessions:manage",
  ],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T00:15:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

class MemorySessionManager implements AdminSessionManager {
  constructor(private readonly session = principal) {}
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) {
    return token === SESSION_TOKEN ? this.session : null;
  }
  async revoke() { return false; }
}

const sessionHeaders = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };

class MemoryConnectionManager implements ConnectionManager {
  readonly items: ServiceConnectionSummary[] = [];

  async list() {
    return this.items;
  }

  async create(input: CreateServiceConnection) {
    const item: ServiceConnectionSummary = {
      id: CONNECTION_ID,
      slug: input.slug,
      displayName: input.displayName,
      kind: input.kind,
      environment: input.environment,
      baseUrl: input.baseUrl,
      enabled: input.enabled,
      status: input.enabled ? "NOT_TESTED" : "DISABLED",
      configuration: input.configuration,
      activeRevision: 1,
      secretFieldNames: Object.keys(input.secrets),
      lastHealthcheckAt: null,
      lastHealthcheckMessage: null,
      updatedAt: new Date().toISOString(),
    };
    this.items.push(item);
    return item;
  }

  async update(id: string, input: UpdateServiceConnection) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("not found");
    if (input.displayName !== undefined) item.displayName = input.displayName;
    if (input.configuration !== undefined) item.configuration = input.configuration;
    item.activeRevision += 1;
    return item;
  }

  async listRevisions(id: string): Promise<ConfigurationRevisionList> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("not found");
    return {
      activeRevision: item.activeRevision,
      items: Array.from({ length: item.activeRevision }, (_, index) => {
        const revision = item.activeRevision - index;
        return {
          id: revision === 1
            ? "e13976da-8ec5-49b1-a307-51e38bfe6950"
            : "19916dd8-7aac-4b1a-b7ed-a165062b4bca",
          revision,
          checksum: "a".repeat(64),
          secretFieldNames: item.secretFieldNames,
          displayName: item.displayName,
          environment: item.environment,
          baseUrl: item.baseUrl,
          enabled: item.enabled,
          configuration: item.configuration,
          createdBy: SESSION_ID,
          createdAt: "2026-07-30T00:00:00.000Z",
          activatedAt: "2026-07-30T00:00:00.000Z",
          active: revision === item.activeRevision,
        };
      }),
    };
  }

  async rollback(
    id: string,
    targetRevision: number,
    expectedActiveRevision: number,
  ): Promise<RollbackConfigurationResult> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("not found");
    item.activeRevision = expectedActiveRevision + 1;
    return {
      connection: item,
      rolledBackFromRevision: expectedActiveRevision,
      targetRevision,
      createdRevision: item.activeRevision,
      preservedSecretFields: item.secretFieldNames,
      message: "Configuration restored; active credentials were preserved.",
    };
  }
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function authenticatedApp(
  manager = new MemoryConnectionManager(),
  tester?: ConnectionTestService,
  sessionManager: AdminSessionManager = new MemorySessionManager(),
  monitor?: ConnectionMonitorService,
  discoverer?: InferenceDiscoveryService,
  cataloguer?: InferenceCatalogueService,
  refresher?: InferenceRefreshService,
) {
  const app = await createApp({
    logger: false,
    runtime: {
      bootstrapState: "READY",
      sessionManager,
      connectionManager: manager,
      ...(tester ? { connectionTestService: tester } : {}),
      ...(monitor ? { connectionMonitor: monitor } : {}),
      ...(discoverer ? { inferenceDiscoveryService: discoverer } : {}),
      ...(cataloguer ? { inferenceCatalogueService: cataloguer } : {}),
      ...(refresher ? { inferenceRefreshService: refresher } : {}),
    },
  });
  apps.push(app);
  return { app, manager };
}

describe("administrator connection routes", () => {
  it("discovers inference compatibility without persisting guessed configuration", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "hermes-primary" }] });
      if (path === "/version") return Response.json({ version: "0.9.2" });
      if (path === "/health") return Response.json({ status: "ok" });
      return Response.json({ error: "not found" }, { status: 404 });
    };
    const discoverer = new InferenceDiscoveryService(undefined, fetchMock as typeof fetch);
    const { app, manager } = await authenticatedApp(
      new MemoryConnectionManager(), undefined, new MemorySessionManager(), undefined, discoverer,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/connections/inference/discover",
      headers: sessionHeaders,
      payload: { baseUrl: "http://gpu.internal:8000/v1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "READY",
      normalizedBaseUrl: "http://gpu.internal:8000",
      backend: "VLLM",
      models: [{ id: "hermes-primary" }],
    });
    expect(manager.items).toHaveLength(0);
  });

  it("loads an OpenRouter catalogue after the key is proven and never returns 401 for a bad key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { label: "pilot" } }))
      .mockResolvedValueOnce(Response.json({
        data: [
          { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
          { id: "~openai/gpt-latest" },
        ],
      }));
    const cataloguer = new InferenceCatalogueService(fetchMock as typeof fetch);
    const { app } = await authenticatedApp(
      new MemoryConnectionManager(), undefined, new MemorySessionManager(), undefined, undefined, cataloguer,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/connections/inference/catalogue",
      headers: sessionHeaders,
      payload: { provider: "openrouter", apiKey: "sk-or-v1-test" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "openrouter",
      models: [{ id: "anthropic/claude-sonnet-4" }],
    });
    expect(response.json().models).not.toEqual(
      expect.arrayContaining([{ id: "~openai/gpt-latest" }]),
    );
  });

  it("returns 400 when OpenRouter rejects the key so the admin session stays intact", async () => {
    const cataloguer = new InferenceCatalogueService(vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 401 }),
    ) as typeof fetch);
    const { app } = await authenticatedApp(
      new MemoryConnectionManager(), undefined, new MemorySessionManager(), undefined, undefined, cataloguer,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/connections/inference/catalogue",
      headers: sessionHeaders,
      payload: { provider: "openrouter", apiKey: "sk-or-bad" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "CATALOGUE_KEY_REJECTED" });
  });

  it("reads and updates the scheduled monitoring control with scoped administration", async () => {
    let control: ConnectionMonitoringControl = {
      enabled: false,
      intervalSeconds: 300,
      reason: "Acceptance pending",
      updatedAt: "2026-07-30T00:00:00.000Z",
      updatedBy: null,
    };
    const monitor: ConnectionMonitorService = {
      start: async () => undefined,
      stop: async () => undefined,
      getControl: async () => control,
      updateControl: async (actor, input) => {
        control = { ...input, updatedAt: "2026-07-30T00:01:00.000Z", updatedBy: actor.id };
        return control;
      },
    };
    const { app } = await authenticatedApp(
      new MemoryConnectionManager(), undefined, new MemorySessionManager(), monitor,
    );

    const before = await app.inject({ method: "GET", url: "/api/v1/admin/connections/monitoring", headers: sessionHeaders });
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/connections/monitoring",
      headers: sessionHeaders,
      payload: { enabled: true, intervalSeconds: 300, reason: "Pilot monitoring approved" },
    });

    expect(before.json()).toMatchObject({ enabled: false, intervalSeconds: 300 });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ enabled: true, reason: "Pilot monitoring approved", updatedBy: SESSION_ID });
  });

  it("lets an operations administrator write scheduled monitoring without connections:write", async () => {
    let control: ConnectionMonitoringControl = {
      enabled: false,
      intervalSeconds: 300,
      reason: "Acceptance pending",
      updatedAt: "2026-07-30T00:00:00.000Z",
      updatedBy: null,
    };
    const monitor: ConnectionMonitorService = {
      start: async () => undefined,
      stop: async () => undefined,
      getControl: async () => control,
      updateControl: async (actor, input) => {
        control = { ...input, updatedAt: "2026-07-30T00:01:00.000Z", updatedBy: actor.id };
        return control;
      },
    };
    const operations: AdministratorSession = {
      ...principal,
      role: "OPERATIONS_ADMIN",
      scopes: ["connections:read", "operations:read", "operations:execute"],
    };
    const { app } = await authenticatedApp(
      new MemoryConnectionManager(), undefined, new MemorySessionManager(operations), monitor,
    );

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/connections/monitoring",
      headers: sessionHeaders,
      payload: { enabled: true, intervalSeconds: 300, reason: "Operations owns Health" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ enabled: true, updatedBy: SESSION_ID });
  });

  it("fails closed without an administrator session", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/connections" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("rejects malformed connection identifiers before database access", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/connections/not-a-uuid",
      headers: sessionHeaders,
      payload: { displayName: "Updated connection" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_CONNECTION" });
  });

  it("enforces role scopes separately from session validity", async () => {
    const readOnlySession: AdministratorSession = {
      ...principal,
      role: "AUDITOR",
      scopes: ["connections:read", "operations:read", "audit:read"],
    };
    const { app } = await authenticatedApp(
      new MemoryConnectionManager(),
      undefined,
      new MemorySessionManager(readOnlySession),
    );

    const read = await app.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: sessionHeaders,
    });
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/admin/connections",
      headers: sessionHeaders,
      payload: {},
    });

    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: "FORBIDDEN" });
  });

  it("creates a connection without returning its secret value", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/connections",
      headers: sessionHeaders,
      payload: {
        slug: "vllm-primary",
        displayName: "vLLM Primary",
        kind: "INFERENCE",
        environment: "PRODUCTION",
        baseUrl: "https://vllm.orcasynapse.internal",
        enabled: true,
        configuration: { modelAlias: "hermes-primary" },
        secrets: { apiKey: "must-never-be-returned" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain("must-never-be-returned");
    expect(response.json()).toMatchObject({
      slug: "vllm-primary",
      configuration: { modelAlias: "hermes-primary" },
      secretFieldNames: ["apiKey"],
    });
  });

  it("rejects operational settings that do not belong to the service kind", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/connections",
      headers: sessionHeaders,
      payload: {
        slug: "vllm-primary",
        displayName: "vLLM Primary",
        kind: "INFERENCE",
        environment: "PRODUCTION",
        baseUrl: "https://vllm.orcasynapse.internal",
        configuration: { memoryTimeoutMs: 300_000 },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_CONNECTION" });
  });

  it("rejects non-HTTP service endpoints", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/connections",
      headers: sessionHeaders,
      payload: {
        slug: "invalid-endpoint",
        displayName: "Invalid Endpoint",
        kind: "OTHER",
        environment: "DEVELOPMENT",
        baseUrl: "file:///etc/passwd",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_CONNECTION" });
  });

  it("tests a configured connection and returns only sanitized diagnostic data", async () => {
    const diagnosticStore: ConnectionDiagnosticStore = {
      resolveForDiagnostic: async () => ({
        id: CONNECTION_ID,
        activeRevision: 1,
        kind: "INFERENCE",
        baseUrl: "https://vllm.orcasynapse.internal",
        configuration: {},
        secrets: { apiKey: "must-never-be-returned" },
      }),
      recordDiagnostic: async () => true,
    };
    const tester = new ConnectionTestService(diagnosticStore, () => ({
      test: async () => ({
        status: "HEALTHY",
        message: "Inference server is reachable and authenticated.",
        details: { modelCount: 1, modelIds: ["hermes-primary"] },
      }),
    }));
    const { app } = await authenticatedApp(new MemoryConnectionManager(), tester);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/connections/${CONNECTION_ID}/test`,
      headers: sessionHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("must-never-be-returned");
    expect(response.json()).toMatchObject({
      connectionId: CONNECTION_ID,
      status: "HEALTHY",
      details: { modelCount: 1, modelIds: ["hermes-primary"] },
    });
  });

  it("lists revisions and restores configuration with an optimistic revision guard", async () => {
    const manager = new MemoryConnectionManager();
    await manager.create({
      slug: "vllm-primary",
      displayName: "vLLM Primary",
      kind: "INFERENCE",
      environment: "PRODUCTION",
      baseUrl: "https://vllm.orcasynapse.internal",
      enabled: true,
      configuration: {},
      secrets: { apiKey: "current-secret" },
    });
    await manager.update(CONNECTION_ID, { displayName: "vLLM Current" });
    const { app } = await authenticatedApp(manager);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/admin/connections/${CONNECTION_ID}/revisions`,
      headers: sessionHeaders,
    });
    const rollback = await app.inject({
      method: "POST",
      url: `/api/v1/admin/connections/${CONNECTION_ID}/revisions/1/rollback`,
      headers: sessionHeaders,
      payload: { expectedActiveRevision: 2 },
    });

    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ activeRevision: 2 });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({
      targetRevision: 1,
      createdRevision: 3,
      preservedSecretFields: ["apiKey"],
    });
    expect(rollback.body).not.toContain("current-secret");
  });

  it("refreshes the observed catalogue from a stored connection", async () => {
    const refresher = {
      refresh: vi.fn(async () => ({
        connectionId: CONNECTION_ID,
        refreshedAt: "2026-08-22T00:00:00.000Z",
        upserted: 1,
        vanished: 0,
        items: [{
          id: CONNECTION_ID,
          connectionId: CONNECTION_ID,
          alias: "hermes-agent",
          displayName: null,
          observedContextWindowTokens: null,
          observedMaxOutputTokens: null,
          inputModalities: [],
          ownedBy: null,
          lastSeenAt: "2026-08-22T00:00:00.000Z",
          missingFromUpstream: false,
          admittedWorkloads: [],
        }],
        backfill: null,
      })),
    } as unknown as InferenceRefreshService;
    const { app } = await authenticatedApp(
      new MemoryConnectionManager(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      refresher,
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/connections/${CONNECTION_ID}/models/refresh`,
      headers: sessionHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ upserted: 1, vanished: 0, backfill: null });
    expect(refresher.refresh).toHaveBeenCalled();
  });
});
