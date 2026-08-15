import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type PlatformReleaseTarget,
  type PlatformUpdate,
  type PlatformUpdateActivity,
} from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import {
  ReleaseTargetConflictError,
  ReleaseTargetUnavailableError,
  ReleaseTargetValidationError,
  type PlatformReleaseTargetManager,
} from "./release-target-manager.js";

const TOKEN = "u".repeat(43);
const PRINCIPAL_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const NOW = "2026-08-15T00:00:00.000Z";
const COMMIT = "3f6a1c9d20b74e5a8c1d0f2b7e4a9c6d5b8e0134";

const session: AdministratorSession = {
  id: PRINCIPAL_ID, subject: "platform-admin", role: "PLATFORM_ADMIN", scopes: [...ADMIN_SCOPES],
  createdAt: NOW, idleExpiresAt: "2026-08-15T00:15:00.000Z", absoluteExpiresAt: "2026-08-15T08:00:00.000Z",
};

/** Every role holds `readiness:read`; only some hold `readiness:approve`. */
const readOnly: AdministratorSession = {
  ...session, role: "OPERATIONS_ADMIN", subject: "operations-admin",
  scopes: ADMIN_SCOPES.filter((scope) => scope !== "readiness:approve"),
};

const target: PlatformReleaseTarget = {
  desiredVersion: "v5.3.0", desiredCommit: COMMIT, approvedBy: PRINCIPAL_ID,
  approvedBySubject: "platform-admin", approvedAt: NOW, revision: 1,
};

const update: PlatformUpdate = {
  currentVersion: "v5.2.2", latestVersion: "v5.3.0", updateAvailable: true,
  releaseUrl: "https://github.com/multichainerz/AI/tree/v5.3.0",
  updateCommand: "curl installer | sudo ORCASYNAPSE_REF=v5.3.0 bash",
  automaticUpdateSupported: false,
  automaticUpdateReason: "The dashboard has no host control.",
  checkedAt: NOW, target: null,
};

const RUN_ID = "6b1f0a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

const activity: PlatformUpdateActivity = {
  agent: {
    phase: "healthy", detail: "this deployment is running v5.3.0",
    installedVersion: "v5.3.0", installedCommit: COMMIT,
    currentRunId: RUN_ID, checkedAt: NOW,
  },
  latest: {
    id: RUN_ID, phase: "healthy", detail: "this deployment is running v5.3.0",
    targetVersion: "v5.3.0", targetCommit: COMMIT,
    installedVersion: "v5.3.0", installedCommit: COMMIT,
    rollback: null, log: "STEP apply migrations\nSTEP verify readiness\n",
    logTruncated: false, startedAt: NOW, apiUnavailableUntil: null,
    completedAt: NOW, recordedAt: NOW,
  },
  recent: [],
};

class Sessions implements AdminSessionManager {
  constructor(private readonly principal: AdministratorSession = session) {}
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? this.principal : null; }
  async revoke() { return true; }
}

function manager(): PlatformReleaseTargetManager {
  return {
    snapshot: vi.fn(async () => update),
    activity: vi.fn(async () => activity),
    approve: vi.fn(async () => target),
    clear: vi.fn(async () => undefined),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function testApp(
  releaseTargetManager: PlatformReleaseTargetManager = manager(),
  principal: AdministratorSession = session,
) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(principal), releaseTargetManager },
  });
  apps.push(app);
  return { app, releaseTargetManager };
}

const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };

describe("approved release target routes", () => {
  it("records an operator's approval and hands back the pinned target", async () => {
    const { app, releaseTargetManager } = await testApp();

    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/updates/target", headers,
      payload: { desiredVersion: "v5.3.0", expectedRevision: 0 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ desiredVersion: "v5.3.0", desiredCommit: COMMIT });
    expect(releaseTargetManager.approve).toHaveBeenCalledWith(
      expect.objectContaining({ id: PRINCIPAL_ID }),
      { desiredVersion: "v5.3.0", expectedRevision: 0 },
    );
  });

  it("refuses an approval without a session, and one without the approve scope", async () => {
    const anonymous = await testApp();
    expect((await anonymous.app.inject({
      method: "POST", url: "/api/v1/admin/updates/target",
      payload: { desiredVersion: "v5.3.0", expectedRevision: 0 },
    })).statusCode).toBe(401);
    expect(anonymous.releaseTargetManager.approve).not.toHaveBeenCalled();

    const unscoped = await testApp(manager(), readOnly);
    const refused = await unscoped.app.inject({
      method: "POST", url: "/api/v1/admin/updates/target", headers,
      payload: { desiredVersion: "v5.3.0", expectedRevision: 0 },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "FORBIDDEN" });
    expect(unscoped.releaseTargetManager.approve).not.toHaveBeenCalled();

    // The same session may still read the check — approving is the privilege.
    expect((await unscoped.app.inject({ method: "GET", url: "/api/v1/admin/updates", headers })).statusCode).toBe(200);
  });

  it("separates a refused version, a stale revision and an unreachable lookup", async () => {
    const refusing = manager();
    refusing.approve = vi.fn(async () => { throw new ReleaseTargetValidationError("main is not a release."); });
    const invalid = await (await testApp(refusing)).app.inject({
      method: "POST", url: "/api/v1/admin/updates/target", headers,
      payload: { desiredVersion: "main", expectedRevision: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "INVALID_RELEASE_TARGET", message: "main is not a release." });

    const conflicting = manager();
    conflicting.approve = vi.fn(async () => { throw new ReleaseTargetConflictError("Refresh and try again."); });
    const conflict = await (await testApp(conflicting)).app.inject({
      method: "POST", url: "/api/v1/admin/updates/target", headers,
      payload: { desiredVersion: "v5.3.0", expectedRevision: 0 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "RELEASE_TARGET_CONFLICT" });

    const offline = manager();
    offline.snapshot = vi.fn(async () => { throw new ReleaseTargetUnavailableError("GitHub returned HTTP 502."); });
    const unavailable = await (await testApp(offline)).app.inject({
      method: "GET", url: "/api/v1/admin/updates", headers,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: "UPDATE_CHECK_UNAVAILABLE" });
  });

  it("rejects a body that names its own commit rather than a tag to resolve", async () => {
    // The commit has to come from the release lookup, or the pin proves nothing.
    const { app, releaseTargetManager } = await testApp();

    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/updates/target", headers,
      payload: { desiredVersion: "v5.3.0", expectedRevision: 0, desiredCommit: "b".repeat(40) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_RELEASE_TARGET" });
    expect(releaseTargetManager.approve).not.toHaveBeenCalled();
  });

  it("withdraws an approved target, and refuses to do so without the approve scope", async () => {
    const { app, releaseTargetManager } = await testApp();
    const cleared = await app.inject({ method: "DELETE", url: "/api/v1/admin/updates/target", headers });
    expect(cleared.statusCode).toBe(204);
    expect(releaseTargetManager.clear).toHaveBeenCalledWith(expect.objectContaining({ id: PRINCIPAL_ID }));

    const unscoped = await testApp(manager(), readOnly);
    expect((await unscoped.app.inject({ method: "DELETE", url: "/api/v1/admin/updates/target", headers })).statusCode).toBe(403);
    expect(unscoped.releaseTargetManager.clear).not.toHaveBeenCalled();
  });

  it("answers the whole screen from one authenticated check", async () => {
    const withTarget = manager();
    withTarget.snapshot = vi.fn(async () => ({ ...update, target }));
    const { app } = await testApp(withTarget);

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/updates", headers });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      latestVersion: "v5.3.0",
      target: { desiredVersion: "v5.3.0", approvedBySubject: "platform-admin" },
    });
  });

  it("keeps the approver's identity off the unauthenticated platform check", async () => {
    /*
     * `/api/v1/platform/update` needs no session, so it must not become a way to
     * read which administrator approved what. The dashboard reads the admin
     * route instead; this one answers the release question and nothing else.
     */
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify([
      { name: "v5.3.0", commit: { sha: COMMIT } },
    ]), { status: 200 }));
    const withTarget = manager();
    withTarget.snapshot = vi.fn(async () => ({ ...update, target }));
    const { app } = await testApp(withTarget);

    const response = await app.inject({ method: "GET", url: "/api/v1/platform/update" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().target).toBeNull();
    expect(response.body).not.toContain("platform-admin");
  });

  it("reports the platform locked when no release-target service is wired", async () => {
    const app = await createApp({
      logger: false,
      runtime: { bootstrapState: "READY", sessionManager: new Sessions() },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/updates/target", headers,
      payload: { desiredVersion: "v5.3.0", expectedRevision: 0 },
    });

    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ error: "PLATFORM_LOCKED" });
  });
});

describe("update activity route", () => {
  it("reports what the host agent did, log and all", async () => {
    const { app } = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/updates/activity", headers });

    expect(response.statusCode).toBe(200);
    const body = response.json() as PlatformUpdateActivity;
    expect(body.agent?.phase).toBe("healthy");
    expect(body.latest?.id).toBe(RUN_ID);
    expect(body.latest?.log).toContain("STEP apply migrations");
  });

  // The screen an operator opens when an upgrade went wrong is not the place to
  // require the scope that performs upgrades.
  it("is readable by a role that cannot approve a release", async () => {
    const { app } = await testApp(manager(), readOnly);

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/updates/activity", headers });

    expect(response.statusCode).toBe(200);
  });

  it("refuses an unauthenticated caller", async () => {
    const { app } = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/updates/activity" });

    expect(response.statusCode).toBe(401);
  });

  it("does not cache, because it is polled while a deployment is changing", async () => {
    const { app } = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/updates/activity", headers });

    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
