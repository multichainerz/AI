import type { AdministratorSession } from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  ADMIN_SESSION_COOKIE,
  type AdminSessionManager,
  type IssuedAdminSession,
} from "./admin-session.js";

const SESSION_TOKEN = "s".repeat(43);
const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const principal: AdministratorSession = {
  id: SESSION_ID,
  subject: "bootstrap-administrator",
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
  readonly revoke = vi.fn(async () => true);

  async createBootstrapSession(token: string | undefined): Promise<IssuedAdminSession | null> {
    return token === "a-secure-bootstrap-token-with-more-than-32-characters"
      ? { token: SESSION_TOKEN, principal }
      : null;
  }

  async authenticate(token: string | undefined) {
    return token === SESSION_TOKEN ? principal : null;
  }
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function sessionApp() {
  const sessionManager = new MemorySessionManager();
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager },
  });
  apps.push(app);
  return { app, sessionManager };
}

describe("administrator session routes", () => {
  it("exchanges the bootstrap token for a protected opaque session cookie", async () => {
    const { app } = await sessionApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/bootstrap",
      payload: { token: "a-secure-bootstrap-token-with-more-than-32-characters" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["set-cookie"]).toContain(`${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ id: SESSION_ID, role: "PLATFORM_ADMIN" });
  });

  it("rejects an invalid bootstrap token without setting a cookie", async () => {
    const { app } = await sessionApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/bootstrap",
      payload: { token: "this-token-is-long-enough-but-is-not-correct" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("returns and revokes the current administrator session", async () => {
    const { app, sessionManager } = await sessionApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/admin/session",
      headers,
    });
    const revoked = await app.inject({
      method: "DELETE",
      url: "/api/v1/admin/session",
      headers,
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ subject: "bootstrap-administrator" });
    expect(revoked.statusCode).toBe(204);
    expect(revoked.headers["set-cookie"]).toContain("Max-Age=0");
    expect(sessionManager.revoke).toHaveBeenCalledWith(SESSION_TOKEN);
  });
});
