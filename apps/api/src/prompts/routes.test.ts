import { ADMIN_SCOPES, type AdministratorSession } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { PromptManager } from "./prompt-manager.js";

const TOKEN = "a".repeat(43);
const PROMPT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return false; }
}

function manager(): PromptManager {
  return {
    list: vi.fn(async () => ({ items: [] })),
    create: vi.fn(),
    update: vi.fn(),
    activate: vi.fn(),
    suspend: vi.fn(),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("prompt control routes", () => {
  it("no longer serves prompt HTTP beside Models", async () => {
    const promptManager = manager();
    const app = await createApp({
      logger: false,
      runtime: { bootstrapState: "READY", sessionManager: new Sessions(), promptManager },
    });
    apps.push(app);
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/platform" })).statusCode).toBe(200);
    for (const [method, url] of [
      ["GET", "/api/v1/admin/prompts"],
      ["POST", "/api/v1/admin/prompts"],
      ["POST", `/api/v1/admin/prompts/${PROMPT_ID}/activate`],
      ["POST", `/api/v1/admin/prompts/${PROMPT_ID}/suspend`],
    ] as const) {
      expect((await app.inject({ method, url, headers, payload: {} })).statusCode).toBe(404);
    }
    expect(promptManager.list).not.toHaveBeenCalled();
    expect(promptManager.activate).not.toHaveBeenCalled();
  });
});
