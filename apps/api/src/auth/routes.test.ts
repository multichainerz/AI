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
  subject: `local-admin:${SESSION_ID}`,
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
  authenticationMethod: "LOCAL_PASSWORD",
  passwordChangeRequired: false,
};

class MemorySessionManager implements AdminSessionManager {
  readonly revoke = vi.fn(async () => true);

  async createInstallationKeySession(installationKey: string | undefined): Promise<IssuedAdminSession | null> {
    return installationKey === "a-secure-installation-key-with-more-than-32-characters"
      ? { token: SESSION_TOKEN, principal: {
          ...principal,
          subject: "installation-key-administrator",
          authenticationMethod: "INSTALLATION_KEY_RECOVERY",
          passwordChangeRequired: true,
        } }
      : null;
  }

  async createLocalPasswordSession(username: string, password: string): Promise<IssuedAdminSession | null> {
    return username === "admin" && password === "temporary-password"
      ? { token: SESSION_TOKEN, principal }
      : null;
  }

  async changeLocalPassword() {
    return { token: SESSION_TOKEN, principal };
  }

  async recoverLocalAdministrator() {
    return { token: SESSION_TOKEN, principal };
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
  it("uses the PostgreSQL-backed local account for routine login", async () => {
    const { app } = await sessionApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/local",
      payload: { username: "admin", password: "temporary-password" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["set-cookie"]).toContain(`${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}`);
    expect(response.json()).toMatchObject({ authenticationMethod: "LOCAL_PASSWORD", passwordChangeRequired: false });
  });

  it("exchanges the Installation Key for a protected recovery-only session cookie", async () => {
    const { app } = await sessionApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/installation-key",
      payload: { installationKey: "a-secure-installation-key-with-more-than-32-characters" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["set-cookie"]).toContain(`${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      id: SESSION_ID,
      role: "PLATFORM_ADMIN",
      authenticationMethod: "INSTALLATION_KEY_RECOVERY",
      passwordChangeRequired: true,
    });
  });

  it("rejects an invalid Installation Key without setting a cookie", async () => {
    const { app } = await sessionApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/installation-key",
      payload: { installationKey: "this-key-is-long-enough-but-is-not-correct" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rotates the session after changing or recovering the local password", async () => {
    const { app } = await sessionApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };
    const changed = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/session/password",
      headers,
      payload: { currentPassword: "temporary-password", newPassword: "replacement-password" },
    });
    const recovered = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/session/recovery",
      headers,
      payload: { username: "admin", newPassword: "replacement-password" },
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.headers["set-cookie"]).toContain(`${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}`);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers["set-cookie"]).toContain(`${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}`);
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
    expect(current.json()).toMatchObject({ subject: `local-admin:${SESSION_ID}` });
    expect(revoked.statusCode).toBe(204);
    expect(revoked.headers["set-cookie"]).toContain("Max-Age=0");
    expect(sessionManager.revoke).toHaveBeenCalledWith(SESSION_TOKEN);
  });
});
