import type { EnterpriseSession, OidcStatus } from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  ENTERPRISE_SESSION_COOKIE,
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
  user: { id: USER_ID, displayName: "Pilot User", email: "pilot@mpm.example" },
  scopes: ["chat:use", "documents:use", "agents:use"],
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
  scopes: ["chat:use", "documents:use", "agents:use"],
  session,
};

function memoryIdentityManager(): EnterpriseIdentityManager {
  return {
    status: vi.fn(async (): Promise<OidcStatus> => ({
      configured: true,
      message: "Enterprise sign-in is configured.",
    })),
    startLogin: vi.fn(async () => ({
      authorizationUrl: "https://identity.mpm.example/authorize?client_id=aihub",
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
    expect(response.headers.location).toContain("https://identity.mpm.example/authorize");
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
});
