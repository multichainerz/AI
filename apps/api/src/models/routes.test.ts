import { ADMIN_SCOPES, type AdministratorSession, type ModelDeployment } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { ModelManager } from "./model-manager.js";

const TOKEN = "a".repeat(43);
const MODEL_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const CONNECTION_ID = "5277951c-7d22-4cec-8d46-fad3afba37dd";
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};
const route: ModelDeployment = {
  id: MODEL_ID,
  slug: "laguna-hermes",
  displayName: "Laguna Hermes",
  modelAlias: "hermes-agent",
  workload: "AGENT",
  status: "ACTIVE",
  connection: { id: CONNECTION_ID, displayName: "Inference Primary", kind: "INFERENCE", environment: "PRODUCTION", enabled: true, status: "HEALTHY" },
  version: "2.1-nvfp4",
  license: null,
  contextWindowTokens: 131_072,
  maxOutputTokens: 8_192,
  maxConcurrentRequests: 2,
  isDefault: true,
  firstActivatedAt: "2026-07-30T00:00:00.000Z",
  revision: 2,
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  observedContextWindowTokens: null,
  observedMaxOutputTokens: null,
  inputModalities: [],
  missingFromUpstream: false,
  lastSeenAt: null,
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return false; }
}

function manager(): ModelManager {
  return {
    list: vi.fn(async () => ({ items: [route] })),
    listObservations: vi.fn(async () => ({ connectionId: CONNECTION_ID, refreshedAt: null, items: [] })),
    replaceObservations: vi.fn(async () => ({ upserted: 0, vanished: 0 })),
    maybeBackfillLegacyAlias: vi.fn(async () => null),
    create: vi.fn(async (): Promise<ModelDeployment> => ({ ...route, status: "DRAFT", isDefault: false, firstActivatedAt: null, revision: 1 })),
    update: vi.fn(async () => route),
    activate: vi.fn(async () => route),
    suspend: vi.fn(async (): Promise<ModelDeployment> => ({ ...route, status: "SUSPENDED", isDefault: false })),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function modelApp(modelManager = manager()) {
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions(), modelManager } });
  apps.push(app);
  return { app, modelManager };
}

describe("model catalogue routes", () => {
  it("requires an authenticated model reader", async () => {
    const { app } = await modelApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/models" })).statusCode).toBe(401);
  });

  it("lists routes and validates activation decisions", async () => {
    const { app, modelManager } = await modelApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/models", headers })).json()).toMatchObject({ items: [{ slug: "laguna-hermes" }] });
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/models/${MODEL_ID}/activate`, headers, payload: { expectedRevision: 1, reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/models/${MODEL_ID}/activate`, headers, payload: { expectedRevision: 1, reason: "Pilot approval", makeDefault: true } })).statusCode).toBe(200);
    expect(modelManager.activate).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), MODEL_ID, expect.objectContaining({ makeDefault: true }));
  });

  it("lists observations for a connection", async () => {
    const { app, modelManager } = await modelApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/admin/models/observations?connectionId=${CONNECTION_ID}`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ connectionId: CONNECTION_ID, refreshedAt: null, items: [] });
    expect(modelManager.listObservations).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it("rejects malformed model identifiers before database access", async () => {
    const { app, modelManager } = await modelApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/models/not-a-uuid/activate",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: { expectedRevision: 1, reason: "Pilot approval", makeDefault: true },
    });

    expect(response.statusCode).toBe(400);
    expect(modelManager.activate).not.toHaveBeenCalled();
  });
});
