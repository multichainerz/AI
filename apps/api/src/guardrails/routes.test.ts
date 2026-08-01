import { ADMIN_SCOPES, type AdministratorSession, type GuardrailPolicy } from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { GuardrailManager } from "./guardrail-manager.js";

const TOKEN = "a".repeat(43);
const POLICY_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const EVALUATION_ID = "de44bc5d-0355-4c3f-872e-1af99f356d19";
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};
const policy: GuardrailPolicy = {
  id: POLICY_ID,
  slug: "chat-safety",
  displayName: "Chat safety",
  description: "Approved chat safety controls.",
  version: "1.0.0",
  status: "ACTIVE",
  maxInputCharacters: 12_000,
  maxOutputCharacters: 200_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
  activationEvaluationId: EVALUATION_ID,
  firstActivatedAt: "2026-07-30T00:00:00.000Z",
  revision: 2,
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return false; }
}

function manager(): GuardrailManager {
  const draftPolicy: GuardrailPolicy = {
    ...policy,
    status: "DRAFT",
    activationEvaluationId: null,
    firstActivatedAt: null,
    revision: 1,
  };
  const suspendedPolicy: GuardrailPolicy = { ...policy, status: "SUSPENDED" };

  return {
    list: vi.fn(async () => ({ items: [policy] })),
    create: vi.fn(async () => draftPolicy),
    update: vi.fn(async () => policy),
    activate: vi.fn(async () => policy),
    suspend: vi.fn(async () => suspendedPolicy),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function policyApp(policyManager = manager()) {
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions(), guardrailManager: policyManager } });
  apps.push(app);
  return { app, policyManager };
}

describe("guardrail policy routes", () => {
  it("requires an authenticated policy reader", async () => {
    const { app } = await policyApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/guardrails" })).statusCode).toBe(401);
  });

  it("lists policies and validates activation decisions", async () => {
    const { app, policyManager } = await policyApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/guardrails", headers })).json()).toMatchObject({ items: [{ slug: "chat-safety" }] });
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/guardrails/${POLICY_ID}/activate`, headers, payload: { expectedRevision: 1, reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/guardrails/${POLICY_ID}/activate`, headers, payload: { expectedRevision: 1, reason: "Pilot approval" } })).statusCode).toBe(200);
    expect(policyManager.activate).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), POLICY_ID, expect.objectContaining({ reason: "Pilot approval" }));
  });

  it("rejects malformed identifiers before manager access", async () => {
    const { app, policyManager } = await policyApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/guardrails/not-a-uuid/activate",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: { expectedRevision: 1, reason: "Pilot approval" },
    });
    expect(response.statusCode).toBe(400);
    expect(policyManager.activate).not.toHaveBeenCalled();
  });
});
