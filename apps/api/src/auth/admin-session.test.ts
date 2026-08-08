import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  administratorSession,
  auditEvent,
  createTestDatabase,
  installationCredential,
  localAdministrator,
  type TestDatabase,
} from "@orcasynapse/database";
import { hashLocalPassword } from "@orcasynapse/security";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallationKeyAuthenticator, type InstallationKeyVerifier } from "./installation-key-auth.js";
import {
  ADMIN_SESSION_IDLE_MS,
  ADMIN_SESSION_TOUCH_INTERVAL_MS,
  DrizzleAdminSessionManager,
  LOCAL_LOGIN_FAILURE_LIMIT,
  requireAdmin,
  type AdminSessionManager,
} from "./admin-session.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });
afterEach(() => vi.useRealTimers());

const INSTALLATION_KEY = "a-secure-permanent-installation-key";
const ROTATED_KEY = "an-entirely-different-installation-key";
/** The real authenticator, so the mounted key and the stored hash agree. */
const acceptsInstallationKey: InstallationKeyVerifier = new InstallationKeyAuthenticator(INSTALLATION_KEY);
/** Stands in for an installation whose mounted key matches nothing on record. */
const rejectsInstallationKey: InstallationKeyVerifier = { verify: () => false, matchesDigest: () => false };

function manager(authenticator: InstallationKeyVerifier = rejectsInstallationKey) {
  return new DrizzleAdminSessionManager(context.database, authenticator);
}

/** The one hash every local-password test reuses; hashing is deliberately slow. */
let sharedPasswordHash: string;
beforeAll(async () => { sharedPasswordHash = await hashLocalPassword("temporary-password"); }, 30_000);

async function seedLocalAdministrator(overrides: Record<string, unknown> = {}) {
  const [account] = await context.database
    .insert(localAdministrator)
    .values({
      username: "admin",
      displayName: "Local Administrator",
      passwordHash: sharedPasswordHash,
      role: "PLATFORM_ADMIN",
      passwordChangeRequired: true,
      ...overrides,
    })
    .returning();
  return account!;
}

async function storedSessions() {
  return context.database.select().from(administratorSession);
}

describe("requireAdmin", () => {
  it("blocks recovery and temporary-password sessions from operational scopes", async () => {
    const recoveryPrincipal = {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "installation-key-administrator",
      role: "PLATFORM_ADMIN" as const,
      scopes: ["sessions:manage" as const],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T00:15:00.000Z",
      absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
      authenticationMethod: "INSTALLATION_KEY_RECOVERY" as const,
      passwordChangeRequired: true,
    };
    const fake = {
      createInstallationKeySession: vi.fn(async () => null),
      authenticate: vi.fn(async () => recoveryPrincipal),
      revoke: vi.fn(async () => true),
    } satisfies AdminSessionManager;
    const send = vi.fn(async () => undefined);
    const reply = { code: vi.fn(() => ({ send })) };

    const result = await requireAdmin({ headers: {} } as never, reply as never, fake, "connections:read");

    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: "PASSWORD_CHANGE_REQUIRED" }));
  });
});

describe("DrizzleAdminSessionManager installation key", () => {
  it("issues a 256-bit opaque token and stores only its digest", async () => {
    const issued = await manager(acceptsInstallationKey)
      .createInstallationKeySession(INSTALLATION_KEY, { sourceIp: "127.0.0.1", userAgent: "OrcaSynapse test" });

    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued?.principal).toMatchObject({
      role: "PLATFORM_ADMIN",
      authenticationMethod: "INSTALLATION_KEY_RECOVERY",
      passwordChangeRequired: true,
    });
    // Recovery is deliberately crippled: it may only manage its own session.
    expect(issued?.principal.scopes).toEqual(["sessions:manage"]);

    const [stored] = await storedSessions();
    expect(stored?.tokenHash).toBeInstanceOf(Uint8Array);
    expect(stored?.tokenHash.byteLength).toBe(32);
    expect(Buffer.from(stored!.tokenHash).toString("utf8")).not.toContain(issued!.token);
    expect(Buffer.from(stored!.tokenHash)).toEqual(createHash("sha256").update(issued!.token).digest());

    const [credential] = await context.database.select().from(installationCredential);
    expect(credential?.lastSessionId).toBe(stored!.id);
    expect(credential?.activatedAt).not.toBeNull();
    expect(await context.database.select().from(auditEvent)).toHaveLength(1);
  });

  it("refuses a key the offline verifier does not accept", async () => {
    await expect(manager().createInstallationKeySession(INSTALLATION_KEY, {})).resolves.toBeNull();
    expect(await storedSessions()).toHaveLength(0);
  });

  it("reuses the offline Installation Key for a new bounded recovery session", async () => {
    const first = await manager(acceptsInstallationKey).createInstallationKeySession(INSTALLATION_KEY, {});
    const [firstCredential] = await context.database.select().from(installationCredential);

    const second = await manager(acceptsInstallationKey).createInstallationKeySession(INSTALLATION_KEY, {});

    expect(second?.token).not.toBe(first?.token);
    const [credential] = await context.database.select().from(installationCredential);
    // The same key keeps its original activation stamp; only the session pointer moves.
    expect(credential?.activatedAt?.toISOString()).toBe(firstCredential?.activatedAt?.toISOString());
    expect(credential?.lastSessionId).not.toBe(firstCredential?.lastSessionId);
    // The earlier recovery session survives a re-login with the same key.
    expect((await storedSessions()).filter(({ revokedAt }) => revokedAt === null)).toHaveLength(2);
  });

  it("revokes outstanding recovery sessions when the mounted key is rotated", async () => {
    const first = await manager(acceptsInstallationKey).createInstallationKeySession(INSTALLATION_KEY, {});

    const afterRotation = new InstallationKeyAuthenticator(ROTATED_KEY);
    const rotated = await manager(afterRotation).createInstallationKeySession(ROTATED_KEY, {});

    expect(rotated).not.toBeNull();
    expect(await manager(afterRotation).authenticate(first!.token, "sessions:manage")).toBeNull();
    expect(await manager(afterRotation).authenticate(rotated!.token, "sessions:manage")).not.toBeNull();
  });

  it("revokes an outstanding recovery session on the next use of the rotated key alone", async () => {
    // The leak response an operator actually performs: write a new key file and
    // restart. Nobody presents the new key, so nothing rewrites the stored
    // hash, and the attacker's recovery row used to keep working for its full
    // absolute lifetime -- long enough to reset the local administrator.
    await seedLocalAdministrator();
    const stolen = await manager(acceptsInstallationKey).createInstallationKeySession(INSTALLATION_KEY, {});
    const restarted = () => manager(new InstallationKeyAuthenticator(ROTATED_KEY));

    expect(
      await restarted().recoverLocalAdministrator(stolen!.token, "admin", "a-much-stronger-password", {}),
    ).toBeNull();
    expect(await restarted().authenticate(stolen!.token, "sessions:manage")).toBeNull();

    // The password the attacker tried to replace is untouched.
    expect(await manager().createLocalPasswordSession("admin", "a-much-stronger-password", {})).toBeNull();
    expect(await manager().createLocalPasswordSession("admin", "temporary-password", {})).not.toBeNull();
  }, 60_000);

  it("records a rejected Installation Key so break-glass probing shows up in audit", async () => {
    expect(
      await manager().createInstallationKeySession("a-long-enough-but-entirely-wrong-key", { sourceIp: "203.0.113.9" }),
    ).toBeNull();

    const failures = (await context.database.select().from(auditEvent))
      .filter(({ outcome }) => outcome === "FAILED");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      action: "administrator.installation_key_login_failed",
      resourceType: "InstallationCredential",
      sourceIp: "203.0.113.9",
    });
  });
});

describe("DrizzleAdminSessionManager local password", () => {
  it("authenticates the PostgreSQL-backed local administrator and preserves the first-login password gate", async () => {
    const account = await seedLocalAdministrator();

    const issued = await manager()
      .createLocalPasswordSession("ADMIN", "temporary-password", { sourceIp: "127.0.0.1" });

    expect(issued).toMatchObject({
      principal: {
        subject: `local-admin:${account.id}`,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: true,
      },
    });
    const [refreshed] = await context.database
      .select({ lastLoginAt: localAdministrator.lastLoginAt, failedLoginCount: localAdministrator.failedLoginCount })
      .from(localAdministrator)
      .where(eq(localAdministrator.id, account.id));
    expect(refreshed?.lastLoginAt).not.toBeNull();
    expect(refreshed?.failedLoginCount).toBe(0);
  }, 30_000);

  it("locks the account after the configured run of failures and records each attempt", async () => {
    const account = await seedLocalAdministrator();

    for (let attempt = 0; attempt < LOCAL_LOGIN_FAILURE_LIMIT; attempt += 1) {
      expect(await manager().createLocalPasswordSession("admin", "wrong-password", {})).toBeNull();
    }

    const [locked] = await context.database
      .select({ failedLoginCount: localAdministrator.failedLoginCount, lockedUntil: localAdministrator.lockedUntil })
      .from(localAdministrator)
      .where(eq(localAdministrator.id, account.id));
    expect(locked?.failedLoginCount).toBe(LOCAL_LOGIN_FAILURE_LIMIT);
    expect(locked?.lockedUntil).not.toBeNull();

    // The correct password must not open a locked account.
    expect(await manager().createLocalPasswordSession("admin", "temporary-password", {})).toBeNull();

    const failures = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "administrator.local_login_failed");
    expect(failures).toHaveLength(LOCAL_LOGIN_FAILURE_LIMIT + 1);
  }, 60_000);

  it("refuses a disabled account without leaking that it exists", async () => {
    await seedLocalAdministrator({ disabledAt: new Date() });

    expect(await manager().createLocalPasswordSession("admin", "temporary-password", {})).toBeNull();
    expect(await manager().createLocalPasswordSession("nobody", "temporary-password", {})).toBeNull();
  }, 30_000);

  it("replaces every session for the subject when the password changes", async () => {
    const account = await seedLocalAdministrator();
    const first = await manager().createLocalPasswordSession("admin", "temporary-password", {});
    const second = await manager().createLocalPasswordSession("admin", "temporary-password", {});

    const replacement = await manager()
      .changeLocalPassword(first!.token, "temporary-password", "a-much-stronger-password", {});

    expect(replacement?.principal.passwordChangeRequired).toBe(false);
    expect(replacement?.token).not.toBe(first!.token);
    // Both prior tokens die, including the one that requested the change.
    expect(await manager().authenticate(first!.token)).toBeNull();
    expect(await manager().authenticate(second!.token)).toBeNull();
    expect(await manager().authenticate(replacement!.token)).not.toBeNull();

    const [updated] = await context.database
      .select({ passwordChangeRequired: localAdministrator.passwordChangeRequired })
      .from(localAdministrator)
      .where(eq(localAdministrator.id, account.id));
    expect(updated?.passwordChangeRequired).toBe(false);
  }, 60_000);

  it("burns an outstanding recovery session when the password changes", async () => {
    // Recovery sessions carry the subject `installation-key-administrator`, so
    // revoking by subject alone left the break-glass way in open behind an
    // administrator who had just responded to a suspected compromise by
    // changing the password.
    await seedLocalAdministrator();
    const recovery = await manager(acceptsInstallationKey).createInstallationKeySession(INSTALLATION_KEY, {});
    const local = await manager(acceptsInstallationKey).createLocalPasswordSession("admin", "temporary-password", {});

    await manager(acceptsInstallationKey)
      .changeLocalPassword(local!.token, "temporary-password", "a-much-stronger-password", {});

    expect(await manager(acceptsInstallationKey).authenticate(recovery!.token, "sessions:manage")).toBeNull();
  }, 60_000);

  it("refuses a password change that reuses the current password", async () => {
    await seedLocalAdministrator();
    const issued = await manager().createLocalPasswordSession("admin", "temporary-password", {});

    await expect(
      manager().changeLocalPassword(issued!.token, "temporary-password", "temporary-password", {}),
    ).resolves.toBeNull();
  }, 30_000);

  it("refuses a password change presented by a recovery session", async () => {
    await seedLocalAdministrator();
    const recovery = await manager(acceptsInstallationKey).createInstallationKeySession(INSTALLATION_KEY, {});

    await expect(
      manager().changeLocalPassword(recovery!.token, "temporary-password", "a-much-stronger-password", {}),
    ).resolves.toBeNull();
  }, 30_000);
});

describe("DrizzleAdminSessionManager recovery", () => {
  it("resets the local password and burns every other way in", async () => {
    await seedLocalAdministrator();
    const localSession = await manager().createLocalPasswordSession("admin", "temporary-password", {});
    const recovery = await manager(acceptsInstallationKey).createInstallationKeySession(INSTALLATION_KEY, {});

    const replacement = await manager(acceptsInstallationKey)
      .recoverLocalAdministrator(recovery!.token, "ADMIN", "a-much-stronger-password", {});

    expect(replacement?.principal.authenticationMethod).toBe("LOCAL_PASSWORD");
    expect(replacement?.principal.passwordChangeRequired).toBe(false);
    expect(await manager().authenticate(localSession!.token)).toBeNull();
    expect(await manager().authenticate(recovery!.token, "sessions:manage")).toBeNull();
    expect(await manager().authenticate(replacement!.token)).not.toBeNull();
    expect(await manager().createLocalPasswordSession("admin", "a-much-stronger-password", {})).not.toBeNull();
  }, 60_000);

  it("refuses recovery presented by an ordinary local session", async () => {
    await seedLocalAdministrator();
    const localSession = await manager().createLocalPasswordSession("admin", "temporary-password", {});

    await expect(
      manager().recoverLocalAdministrator(localSession!.token, "admin", "a-much-stronger-password", {}),
    ).resolves.toBeNull();
  }, 30_000);
});

describe("DrizzleAdminSessionManager authentication", () => {
  it("issues a scoped administrator session for a verified federated subject", async () => {
    const subject = `oidc:${"b".repeat(64)}`;

    const issued = await manager().issueFederatedSession(subject, "AUDITOR", { sourceIp: "127.0.0.1" });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.principal.role).toBe("AUDITOR");
    expect(issued.principal.scopes).toContain("audit:read");
    expect(issued.principal.scopes).not.toContain("connections:write");

    const [recorded] = await context.database
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, issued.principal.id));
    expect(recorded?.metadata).toMatchObject({ role: "AUDITOR", authenticationMethod: "oidc-pkce-group-mapping" });
  });

  it("extends idle expiry without passing the absolute session limit", async () => {
    const issued = await manager().issueFederatedSession("oidc:subject", "PLATFORM_ADMIN", {});
    const [session] = await storedSessions();
    // Park the session five minutes short of its absolute limit; a full idle
    // extension would otherwise outlive it.
    const now = new Date(session!.absoluteExpiresAt.getTime() - 5 * 60 * 1_000);
    await context.database
      .update(administratorSession)
      .set({
        lastSeenAt: new Date(now.getTime() - ADMIN_SESSION_TOUCH_INTERVAL_MS - 1_000),
        idleExpiresAt: new Date(now.getTime() + 60_000),
      })
      .where(eq(administratorSession.id, session!.id));
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const principal = await manager().authenticate(issued.token);

    expect(principal?.idleExpiresAt).toBe(session!.absoluteExpiresAt.toISOString());
    expect(ADMIN_SESSION_IDLE_MS).toBe(15 * 60 * 1_000);
  });

  it("does not rewrite a healthy session on every authenticated request", async () => {
    const issued = await manager().issueFederatedSession("oidc:subject", "PLATFORM_ADMIN", {});
    const [before] = await storedSessions();

    const principal = await manager().authenticate(issued.token);

    const [after] = await storedSessions();
    expect(principal?.id).toBe(before!.id);
    expect(after?.lastSeenAt.toISOString()).toBe(before!.lastSeenAt.toISOString());
  });

  it("fails closed once a session is revoked", async () => {
    const issued = await manager().issueFederatedSession("oidc:subject", "PLATFORM_ADMIN", {});

    expect(await manager().revoke(issued.token)).toBe(true);
    expect(await manager().authenticate(issued.token)).toBeNull();
    // Revocation is not idempotent by design: a second attempt reports no work done.
    expect(await manager().revoke(issued.token)).toBe(false);

    const revocations = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "administrator.session_revoked");
    expect(revocations).toHaveLength(1);
  });

  it("revokes a session that is presented after it expired", async () => {
    const issued = await manager().issueFederatedSession("oidc:subject", "PLATFORM_ADMIN", {});
    await context.database
      .update(administratorSession)
      .set({ idleExpiresAt: new Date(Date.now() - 1_000) });

    expect(await manager().authenticate(issued.token)).toBeNull();

    const [session] = await storedSessions();
    expect(session?.revokedAt).not.toBeNull();
  });

  it("rejects a malformed token before touching PostgreSQL", async () => {
    expect(await manager().authenticate(undefined)).toBeNull();
    expect(await manager().authenticate("short")).toBeNull();
    expect(await manager().revoke("not-a-session-token")).toBe(false);
  });

  it("withholds a scope the role does not carry", async () => {
    const issued = await manager().issueFederatedSession("oidc:subject", "AUDITOR", {});

    expect(await manager().authenticate(issued.token, "audit:read")).not.toBeNull();
    expect(await manager().authenticate(issued.token, "connections:write")).toBeNull();
  });
});
