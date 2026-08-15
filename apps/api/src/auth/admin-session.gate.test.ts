import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_SCOPES, type AdministratorSession } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "./admin-session.js";

/*
 * The forced-rotation gate, tested once for every surface that has to apply it.
 *
 * The installer prints the temporary password to a terminal and a log, so a
 * session still holding it is a credential in transit rather than an
 * administrator. Connections, models, prompts and guardrails always refused it
 * through the shared `requireAdmin`; agents, chat and tooling resolve their own
 * principal because they also accept a non-administrator identity, and two of
 * those three had simply never repeated the check. The temporary password could
 * flip the agent-execution kill switch, activate a profile and run a real turn.
 *
 * The per-route cases below are the behaviour. The inventory case at the end is
 * the part that keeps this closed: it fails when a new module resolves a
 * session without going through `authenticateAdministrator`.
 */

const SESSION_TOKEN = "s".repeat(43);
const session: AdministratorSession = {
  id: "8b1f4a0e-2d5c-4a71-9f3e-6c0b7d2a5e91",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T01:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

/** A session whose holder has not yet replaced the installer's password. */
class UnrotatedSessions implements AdminSessionManager {
  async createInstallationKeySession() {
    return null;
  }

  async authenticate(token: string | undefined) {
    return token === SESSION_TOKEN ? { ...session, passwordChangeRequired: true } : null;
  }

  async revoke() {
    return true;
  }
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function unrotatedApp() {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new UnrotatedSessions() },
  });
  apps.push(app);
  return app;
}

const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` };

describe("the forced password-change gate", () => {
  it("refuses an unrotated session on the agent execution kill switch", async () => {
    const app = await unrotatedApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/agents/runtime",
      headers,
      payload: { enabled: true, reason: "the installer password must not reach this" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
  });

  it("refuses an unrotated session on agent profile reads", async () => {
    const app = await unrotatedApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/agents/profiles", headers });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
  });

  it("refuses an unrotated session on chat, rather than letting it start a turn", async () => {
    const app = await unrotatedApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/chat/conversations", headers });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
  });

  it("refuses an unrotated session on governed tooling", async () => {
    const app = await unrotatedApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/tooling/tools", headers });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
  });

  it("still answers 401 when there is no session at all", async () => {
    const app = await unrotatedApp();

    // The gate must not turn "no session" into "rotate your password" — the
    // dashboard routes on the difference.
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/agents/profiles" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "UNAUTHORIZED" });
  });

  /*
   * The inventory guard.
   *
   * `AdminSessionManager.authenticate` returns a principal whose password
   * change is still pending — deliberately, because the change and recovery
   * endpoints have to accept exactly that session. Every other caller has to
   * apply the gate, and the way that was forgotten twice was by calling the
   * manager directly. So: the manager is callable from two places, and adding a
   * third fails here rather than in production.
   */
  it("leaves the session manager callable only from the endpoints that must accept a pending change", () => {
    const source = dirname(fileURLToPath(import.meta.url));
    const root = join(source, "..");
    const permitted = new Set(["auth/routes.ts", "auth/admin-session.ts"]);

    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          if (/sessionManager\??\.authenticate\(|manager\.authenticate\(adminSessionToken/.test(readFileSync(full, "utf8"))) {
            offenders.push(relative(root, full).replaceAll("\\", "/"));
          }
        }
      }
    };
    walk(root);

    // Proves the scan reaches real files rather than passing on an empty walk.
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.filter((file) => !permitted.has(file))).toEqual([]);
  });
});
