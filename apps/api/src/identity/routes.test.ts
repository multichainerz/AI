import { ADMIN_SCOPES, type EnterpriseSession, type OidcStatus } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE } from "../auth/admin-session.js";
import {
  ENTERPRISE_SESSION_COOKIE,
  EnterpriseIdentityError,
  OIDC_STATE_COOKIE,
  type EnterpriseIdentityManager,
  type EnterprisePrincipal,
} from "./enterprise-session.js";

const STATE = "s".repeat(43);
const SESSION_TOKEN = "u".repeat(43);
const SESSION_ID = "584944cd-0f35-4d77-a416-c381e5199210";
const USER_ID = "fb8c1e58-10d6-4ac7-aafe-e259763a6f63";

const session: EnterpriseSession = {
  id: SESSION_ID,
  identityMode: "ENTERPRISE",
  user: { id: USER_ID, displayName: "Pilot User", email: "pilot@orcasynapse.example" },
  scopes: ["chat:use", "agents:use"],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T08:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
};

const principal: EnterprisePrincipal = {
  id: SESSION_ID,
  subject: `user:${USER_ID}`,
  identityMode: "ENTERPRISE",
  displayName: session.user.displayName,
  email: session.user.email,
  scopes: ["chat:use", "agents:use"], divisionId: null,
  session,
};

function memoryIdentityManager(): EnterpriseIdentityManager {
  return {
    status: vi.fn(async (): Promise<OidcStatus> => ({
      configured: true,
      administratorSignIn: true,
      message: "Enterprise sign-in is configured.",
    })),
    signInWithPassword: vi.fn(async () => { throw new Error("Not used"); }) as never,
    changeLocalPassword: vi.fn(async () => { throw new Error("Not used"); }) as never,
    startLogin: vi.fn(async () => ({
      authorizationUrl: "https://identity.orcasynapse.example/authorize?client_id=orcasynapse",
      stateToken: STATE,
    })),
    completeLogin: vi.fn(async () => ({
      token: SESSION_TOKEN,
      returnTo: "/#chat",
      principal,
    })),
    authenticate: vi.fn(async (token) => token === SESSION_TOKEN ? principal : null),
    revoke: vi.fn(async (token) => token === SESSION_TOKEN),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function identityApp(manager: EnterpriseIdentityManager = memoryIdentityManager()) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", identityManager: manager },
  });
  apps.push(app);
  return app;
}

describe("enterprise identity routes", () => {
  it("reports whether enterprise sign-in is configured", async () => {
    const app = await identityApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      administratorSignIn: true,
      message: "Enterprise sign-in is configured.",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("starts authorization with a browser-bound HttpOnly state cookie", async () => {
    const manager = memoryIdentityManager();
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start?returnTo=%2F%23chat",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("https://identity.orcasynapse.example/authorize");
    expect(response.headers["set-cookie"]).toContain(`${OIDC_STATE_COOKIE}=${STATE}`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(manager.startLogin).toHaveBeenCalledWith("/#chat", expect.any(Object));
  });

  it("rejects an external return target before it reaches the manager", async () => {
    const manager = memoryIdentityManager();
    const app = await identityApp(manager);
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start?returnTo=%2F%2Fevil.example",
    });
    expect(manager.startLogin).toHaveBeenCalledWith("/", expect.any(Object));
  });

  it("rejects backslash forms that browsers resolve off-site", async () => {
    // Blocking `//host` alone was not enough: browsers treat `/\host` as
    // scheme-relative, so `new URL("/\\evil.example", origin)` yields
    // https://evil.example/. That redirect fires the instant a user completes a
    // genuine corporate SSO, which is the ideal setup for credential replay.
    for (const hostile of ["%2F%5Cevil.example", "%2F%5C%5Cevil.example", "%2F%5C%2Fevil.example"]) {
      const manager = memoryIdentityManager();
      const app = await identityApp(manager);
      await app.inject({ method: "GET", url: `/api/v1/auth/oidc/start?returnTo=${hostile}` });
      expect(manager.startLogin, `returnTo=${hostile}`).toHaveBeenCalledWith("/", expect.any(Object));
      await app.close();
    }
  });

  it("rejects a tab-smuggled return target", async () => {
    // WHATWG URL parsing strips TAB, CR and LF before resolving, but Node only
    // refuses CR and LF in a header value. `/<TAB>/evil.example` therefore
    // survived as a Location header and the browser resolved it to
    // https://evil.example/ -- the same off-site post-SSO redirect the
    // backslash forms above were closed for.
    for (const hostile of ["%2F%09%2Fevil.example", "%2F%09%5Cevil.example", "%2F%09%09%2Fevil.example"]) {
      const manager = memoryIdentityManager();
      const app = await identityApp(manager);
      await app.inject({ method: "GET", url: `/api/v1/auth/oidc/start?returnTo=${hostile}` });
      expect(manager.startLogin, `returnTo=${hostile}`).toHaveBeenCalledWith("/", expect.any(Object));
      await app.close();
    }
  });

  it("refuses to redirect to a tab-smuggled target the provider hands back", async () => {
    const manager = memoryIdentityManager();
    manager.completeLogin = vi.fn(async () => ({
      token: SESSION_TOKEN,
      returnTo: "/\t/evil.example",
      principal,
    }));
    const app = await identityApp(manager);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=approved&state=${STATE}`,
      headers: { cookie: `${OIDC_STATE_COOKIE}=${STATE}` },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(new URL(String(response.headers.location), "https://orcasynapse.example").origin)
      .toBe("https://orcasynapse.example");
  });

  it("still accepts an ordinary in-app path", async () => {
    const manager = memoryIdentityManager();
    const app = await identityApp(manager);
    await app.inject({ method: "GET", url: "/api/v1/auth/oidc/start?returnTo=%2Fchat%3Ftab%3D1" });
    expect(manager.startLogin).toHaveBeenCalledWith("/chat?tab=1", expect.any(Object));
  });

  it("exchanges the callback for an opaque enterprise session cookie", async () => {
    const manager = memoryIdentityManager();
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=approved&state=${STATE}`,
      headers: { cookie: `${OIDC_STATE_COOKIE}=${STATE}` },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/#chat");
    const cookies = response.headers["set-cookie"];
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringContaining(`${OIDC_STATE_COOKIE}=`),
      expect.stringContaining(`${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}`),
    ]));
    expect(manager.completeLogin).toHaveBeenCalledWith(
      "approved",
      STATE,
      STATE,
      expect.any(Object),
    );
  });

  it("sets a separate scoped administrator cookie for an OIDC administrator group", async () => {
    const manager = memoryIdentityManager();
    const administratorToken = "a".repeat(43);
    manager.completeLogin = vi.fn(async () => ({
      token: SESSION_TOKEN,
      returnTo: "/#deployment",
      principal,
      administratorSession: {
        token: administratorToken,
        principal: {
          id: "49df7682-56bf-4be5-a95f-d69887e6496c",
          subject: `oidc:${"b".repeat(64)}`,
          role: "PLATFORM_ADMIN" as const,
          scopes: [...ADMIN_SCOPES],
          createdAt: "2026-07-30T00:00:00.000Z",
          idleExpiresAt: "2026-07-30T00:15:00.000Z",
          absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
        },
      },
    }));
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=approved&state=${STATE}`,
      headers: { cookie: `${OIDC_STATE_COOKIE}=${STATE}` },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining(`${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}`),
      expect.stringContaining(`${ADMIN_SESSION_COOKIE}=${administratorToken}`),
    ]));
  });

  it("signs in a locally created person and sets the enterprise session cookie", async () => {
    const manager = memoryIdentityManager();
    manager.signInWithPassword = vi.fn(async () => ({
      token: SESSION_TOKEN,
      returnTo: "/",
      principal,
    }));
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local/login",
      payload: { username: "Ayu", password: "a-long-enough-password" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ displayName: "Pilot User" });
    expect(response.headers["set-cookie"]).toContain(`${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}`);
    expect(manager.signInWithPassword).toHaveBeenCalledWith(
      "ayu",
      "a-long-enough-password",
      expect.any(Object),
    );
  });

  it("answers one refusal for a rejected local person sign-in", async () => {
    const manager = memoryIdentityManager();
    manager.signInWithPassword = vi.fn(async () => {
      throw new EnterpriseIdentityError("USER_LOGIN_REJECTED", "That username and password do not match an account.", 401);
    });
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local/login",
      payload: { username: "ayu", password: "wrong-password-here" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "USER_LOGIN_REJECTED",
      message: "That username and password do not match an account.",
    });
  });

  it("restores and revokes an enterprise session", async () => {
    const manager = memoryIdentityManager();
    const app = await identityApp(manager);
    const restored = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}` },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual(session);

    const revoked = await app.inject({
      method: "DELETE",
      url: "/api/v1/session",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}` },
    });
    expect(revoked.statusCode).toBe(204);
    expect(manager.revoke).toHaveBeenCalledWith(SESSION_TOKEN);
  });

  it("replaces a locally created person's password and sets a new session cookie", async () => {
    const manager = memoryIdentityManager();
    const replacement = "v".repeat(43);
    manager.changeLocalPassword = vi.fn(async () => ({
      token: replacement,
      returnTo: "/",
      principal: {
        ...principal,
        session: { ...session, passwordChangeRequired: false },
      },
    }));
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/local/password",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { currentPassword: "temporary-password", newPassword: "a-much-stronger-password" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...session, passwordChangeRequired: false });
    expect(response.headers["set-cookie"]).toContain(`${ENTERPRISE_SESSION_COOKIE}=${replacement}`);
    expect(manager.changeLocalPassword).toHaveBeenCalledWith(
      SESSION_TOKEN,
      "temporary-password",
      "a-much-stronger-password",
      expect.any(Object),
    );
  });

  it("blames an expired cookie before blaming the current password", async () => {
    const manager = memoryIdentityManager();
    manager.authenticate = vi.fn(async () => null);
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/local/password",
      payload: { currentPassword: "temporary-password", newPassword: "a-much-stronger-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "SESSION_EXPIRED",
      message: "This session expired. Sign in again to set a new password.",
    });
    expect(manager.changeLocalPassword).not.toHaveBeenCalled();
  });

  it("reports a wrong current password after the session is confirmed live", async () => {
    const manager = memoryIdentityManager();
    manager.changeLocalPassword = vi.fn(async () => {
      throw new EnterpriseIdentityError("UNAUTHORIZED", "The current password is incorrect.", 401);
    });
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/local/password",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { currentPassword: "not-the-current-one", newPassword: "a-much-stronger-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "UNAUTHORIZED",
      message: "The current password is incorrect.",
    });
  });

  it("refuses a password change whose body fails the contract", async () => {
    const manager = memoryIdentityManager();
    const app = await identityApp(manager);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/local/password",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { currentPassword: "short", newPassword: "also-short" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_PASSWORD_CHANGE" });
    expect(manager.changeLocalPassword).not.toHaveBeenCalled();
  });
});
