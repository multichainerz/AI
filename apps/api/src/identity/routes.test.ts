import { type EnterpriseSession } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  ENTERPRISE_SESSION_COOKIE,
  EnterpriseIdentityError,
  type EnterpriseIdentityManager,
  type EnterprisePrincipal,
} from "./enterprise-session.js";

const SESSION_TOKEN = "u".repeat(43);
const SESSION_ID = "584944cd-0f35-4d77-a416-c381e5199210";
const USER_ID = "fb8c1e58-10d6-4ac7-aafe-e259763a6f63";

const session: EnterpriseSession = {
  id: SESSION_ID,
  identityMode: "ENTERPRISE",
  user: { id: USER_ID, displayName: "Pilot User", email: "pilot@orcasynapse.example", divisionName: null },
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
    signInWithPassword: vi.fn(async () => { throw new Error("Not used"); }) as never,
    changeLocalPassword: vi.fn(async () => { throw new Error("Not used"); }) as never,
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

  it("refuses an oversized sign-in body before it can reach the audit trail", async () => {
    /*
     * A failed sign-in writes `metadata: { username }` into `AuditEvent`, and
     * nothing prunes that table. This route parsed its body by hand with no
     * ceiling, so an unauthenticated caller could store as much text per attempt
     * as they cared to send -- while the administrator route next door had been
     * bounded by its contract all along.
     *
     * Refused before the manager is reached, which is the assertion that matters:
     * no hash is computed and no audit row is written.
     */
    const manager = memoryIdentityManager();
    const app = await identityApp(manager);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local/login",
      payload: { username: "a".repeat(65), password: "a-long-enough-password" },
    });

    expect(response.statusCode).toBe(400);
    expect(manager.signInWithPassword).not.toHaveBeenCalled();
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
