import { createHash } from "node:crypto";
import { ADMIN_SCOPES, type AdministratorSession, type PromptTemplate } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { PromptManager } from "./prompt-manager.js";

const TOKEN = "a".repeat(43);
const PROMPT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const CONTENT = "You are the approved OrcaSynapse assistant. State uncertainty and protect private data.";
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};
const activePrompt: PromptTemplate = {
  id: PROMPT_ID,
  slug: "orcasynapse-chat-system",
  displayName: "OrcaSynapse chat system",
  description: "Approved employee chat behavior.",
  purpose: "CHAT_SYSTEM",
  version: "1.0.0",
  status: "ACTIVE",
  content: CONTENT,
  contentChecksum: createHash("sha256").update(CONTENT).digest("hex"),
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

function manager(): PromptManager {
  const draft: PromptTemplate = { ...activePrompt, status: "DRAFT", firstActivatedAt: null, revision: 1 };
  const suspended: PromptTemplate = { ...activePrompt, status: "SUSPENDED" };
  return {
    list: vi.fn(async () => ({ items: [activePrompt] })),
    create: vi.fn(async () => draft),
    update: vi.fn(async () => activePrompt),
    activate: vi.fn(async () => activePrompt),
    suspend: vi.fn(async () => suspended),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function promptApp(promptManager = manager()) {
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions(), promptManager } });
  apps.push(app);
  return { app, promptManager };
}

describe("prompt control routes", () => {
  it("requires an authenticated prompt reader", async () => {
    const { app } = await promptApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/prompts" })).statusCode).toBe(401);
  });

  it("lists prompts and validates activation decisions", async () => {
    const { app, promptManager } = await promptApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/prompts", headers })).json()).toMatchObject({ items: [{ slug: "orcasynapse-chat-system" }] });
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/prompts/${PROMPT_ID}/activate`, headers, payload: { expectedRevision: 1, reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/prompts/${PROMPT_ID}/activate`, headers, payload: { expectedRevision: 1, reason: "Pilot approval" } })).statusCode).toBe(200);
    expect(promptManager.activate).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), PROMPT_ID, expect.objectContaining({ reason: "Pilot approval" }));
  });

  it("rejects malformed identifiers before manager access", async () => {
    const { app, promptManager } = await promptApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/prompts/not-a-uuid/activate",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: { expectedRevision: 1, reason: "Pilot approval" },
    });
    expect(response.statusCode).toBe(400);
    expect(promptManager.activate).not.toHaveBeenCalled();
  });
});
