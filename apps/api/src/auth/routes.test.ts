import type { AdministratorSession } from "@orcasynapse/contracts";
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

  // Declared nullable to match the interface: a test overrides it with a
  // refusal, which is the only way to reach the wrong-password branch.
  async changeLocalPassword(): Promise<IssuedAdminSession | null> {
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

  it("says the session expired rather than blaming the password", async () => {
    // The first screen a new installation shows. An operator copying a
    // generated password out of a vault, told "the current password is
    // incorrect" when the session merely timed out, retypes the same correct
    // password and concludes the product is broken.
    const { app } = await sessionApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/session/password",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${"x".repeat(43)}` },
      payload: { currentPassword: "temporary-password", newPassword: "replacement-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "SESSION_EXPIRED" });
    expect(response.json().message).toMatch(/sign in again/i);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("still refuses a wrong current password on a live session", async () => {
    const sessionManager = new MemorySessionManager();
    sessionManager.changeLocalPassword = vi.fn(async () => null);
    const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager } });
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/session/password",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { currentPassword: "not-the-temporary-password", newPassword: "replacement-password" },
    });

    expect(response.statusCode).toBe(401);
    // A live session that fails is the password, and now says so.
    expect(response.json()).toMatchObject({ error: "UNAUTHORIZED" });
    expect(response.json().message).toMatch(/current password is incorrect/i);
  });

  /*
   * One locked platform, one answer.
   *
   * `sessionManager` is absent for exactly one reason: the process came up
   * without a usable database URL, master key or Installation Key, so
   * bootstrapState is LOCKED and no credential of any kind can be checked. Each
   * of these four routes used to describe that state differently -- "the
   * username or password is incorrect", "OrcaSynapse installation trust is not
   * ready", and twice "a valid ... is required" -- and the operator reading
   * them is on the first screen of an install, typing a password that is
   * correct, out of a file the installer just wrote. Three of those four
   * answers send them to check their typing; only the 423 sends them to the
   * service.
   */
  it("answers every session route with PLATFORM_LOCKED while the platform is locked", async () => {
    const app = await createApp({ logger: false, runtime: { bootstrapState: "LOCKED" } });
    apps.push(app);
    const requests = [
      { method: "POST" as const, url: "/api/v1/admin/session/local", payload: { username: "admin", password: "temporary-password" } },
      { method: "POST" as const, url: "/api/v1/admin/session/installation-key", payload: { installationKey: "a-secure-installation-key-with-more-than-32-characters" } },
      { method: "PUT" as const, url: "/api/v1/admin/session/password", payload: { currentPassword: "temporary-password", newPassword: "replacement-password" } },
      { method: "PUT" as const, url: "/api/v1/admin/session/recovery", payload: { username: "admin", newPassword: "replacement-password" } },
    ];

    const answers = await Promise.all(requests.map((request) => app.inject(request)));

    for (const [index, answer] of answers.entries()) {
      expect({ url: requests[index]!.url, status: answer.statusCode, error: answer.json().error })
        .toEqual({ url: requests[index]!.url, status: 423, error: "PLATFORM_LOCKED" });
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
  });

  /*
   * The locked answer must not swallow the ordinary one. A running platform
   * still tells a caller its body is malformed rather than that the service is
   * unavailable.
   */
  it("still refuses a malformed body on a running platform", async () => {
    const { app } = await sessionApp();

    const local = await app.inject({ method: "POST", url: "/api/v1/admin/session/local", payload: { username: "admin" } });
    const recovery = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/session/recovery",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { username: "admin" },
    });

    expect(local.statusCode).toBe(401);
    expect(local.json()).toMatchObject({ error: "UNAUTHORIZED" });
    expect(recovery.statusCode).toBe(400);
    expect(recovery.json()).toMatchObject({ error: "INVALID_RECOVERY_REQUEST" });
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
