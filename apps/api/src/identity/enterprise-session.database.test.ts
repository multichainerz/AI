import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  auditEvent,
  createTestDatabase,
  enterpriseUser,
  localUser,
  enterpriseUserSession,
  type TestDatabase,
} from "@orcasynapse/database";
import { hashLocalPassword } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleEnterpriseIdentityManager, EnterpriseIdentityError } from "./enterprise-session.js";
import { LOCAL_LOGIN_FAILURE_LIMIT } from "../auth/admin-session.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const ISSUER = "https://login.example";

function tokenDigest(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value, "utf8").digest());
}





function manager() {
  return new DrizzleEnterpriseIdentityManager(context.database);
}


async function seedSession(overrides: Record<string, unknown> = {}) {
  const token = randomBytes(32).toString("base64url");
  const [user] = await context.database
    .insert(enterpriseUser)
    .values({
      issuer: ISSUER,
      subject: `subject-${randomUUID().slice(0, 8)}`,
      email: "user@example.com",
      displayName: "Enterprise User",
      groups: ["orcasynapse-users"],
      lastLoginAt: new Date(),
    })
    .returning({ id: enterpriseUser.id });
  const [session] = await context.database
    .insert(enterpriseUserSession)
    .values({
      tokenHash: tokenDigest(token),
      userId: user!.id,
      lastSeenAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000),
      absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1_000),
      ...overrides,
    })
    .returning({ id: enterpriseUserSession.id });
  return { token, userId: user!.id, sessionId: session!.id };
}

type Transaction = Parameters<Parameters<TestDatabase["database"]["transaction"]>[0]>[0];

/**
 * Holds the session row locked until `concurrency` copies of `call` are queued
 * behind it, so their reads all land before any of their writes.
 *
 * The twin of the helper in auth/admin-session.test.ts, against this module's
 * own table; the note there explains why the interleaving is forced rather than
 * left to the scheduler.
 */
async function whileRowIsLocked<T>(
  sessionId: string,
  concurrency: number,
  call: () => Promise<T>,
  beforeRelease?: (transaction: Transaction) => Promise<void>,
): Promise<T[]> {
  let locked!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { locked = resolve; });
  const queued = new Promise<void>((resolve) => { release = resolve; });
  const holder = context.database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT 1 FROM ${enterpriseUserSession} WHERE ${enterpriseUserSession.id} = ${sessionId} FOR UPDATE`,
    );
    locked();
    await queued;
    if (beforeRelease) await beforeRelease(transaction);
  });
  await Promise.race([reached, holder]);
  const answers = Promise.all(Array.from({ length: concurrency }, () => call()));
  try {
    await vi.waitFor(async () => {
      const { rows } = await context.database.execute<{ waiting: number }>(
        sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      expect(rows[0]?.waiting).toBe(concurrency);
    }, { timeout: 15_000, interval: 25 });
  } finally {
    release();
    await holder;
  }
  return answers;
}

describe("DrizzleEnterpriseIdentityManager sessions", () => {
  it("authenticates a live session and exposes only end-user scopes", async () => {
    const { token, userId } = await seedSession();

    const principal = await manager().authenticate(token);

    expect(principal).toMatchObject({ identityMode: "ENTERPRISE", displayName: "Enterprise User" });
    expect(principal?.scopes).toEqual(["chat:use", "agents:use"]);
    expect(principal?.session.user.id).toBe(userId);
  });

  it("does not rewrite a healthy session on every authenticated request", async () => {
    const { token, sessionId } = await seedSession();
    const [before] = await context.database
      .select({ lastSeenAt: enterpriseUserSession.lastSeenAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));

    await manager().authenticate(token);

    const [after] = await context.database
      .select({ lastSeenAt: enterpriseUserSession.lastSeenAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));
    expect(after?.lastSeenAt.toISOString()).toBe(before!.lastSeenAt.toISOString());
  });

  it("extends idle expiry once the touch interval has passed, capped by the absolute limit", async () => {
    const { token, sessionId } = await seedSession({
      lastSeenAt: new Date(Date.now() - 120_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    });

    const principal = await manager().authenticate(token);

    const [after] = await context.database
      .select({ idleExpiresAt: enterpriseUserSession.idleExpiresAt, absoluteExpiresAt: enterpriseUserSession.absoluteExpiresAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));
    expect(after?.idleExpiresAt.toISOString()).toBe(after!.absoluteExpiresAt.toISOString());
    expect(principal).not.toBeNull();
  });

  /*
   * The same burst the dashboard produces, against the enterprise session.
   *
   * Concurrent touches serialise on the row lock, and every one but the winner
   * re-evaluates its predicate against a tuple whose lastSeenAt no longer
   * satisfies the write throttle. Only the throttle failed there; the session
   * did not, and a signed-in user must not be signed out by it. See the
   * matching test in auth/admin-session.test.ts for why the row is locked from
   * outside rather than left to whatever order the scheduler picks.
   */
  it("authenticates every request in a burst on a session past its touch interval", async () => {
    const { token, sessionId } = await seedSession({ lastSeenAt: new Date(Date.now() - 180_000) });

    const answers = await whileRowIsLocked(sessionId, 4, () => manager().authenticate(token));

    expect(answers.filter((principal) => principal === null)).toEqual([]);
    for (const principal of answers) expect(principal?.identityMode).toBe("ENTERPRISE");
  });

  it("refuses a burst whose session is revoked between the read and the touch", async () => {
    const { token, sessionId } = await seedSession({ lastSeenAt: new Date(Date.now() - 180_000) });

    const answers = await whileRowIsLocked(sessionId, 4, () => manager().authenticate(token), async (transaction) => {
      await transaction
        .update(enterpriseUserSession)
        .set({ revokedAt: new Date() })
        .where(eq(enterpriseUserSession.id, sessionId));
    });

    expect(answers).toEqual([null, null, null, null]);
  });

  it("revokes a session that is presented after it expired", async () => {
    const { token, sessionId } = await seedSession({ idleExpiresAt: new Date(Date.now() - 1_000) });

    expect(await manager().authenticate(token)).toBeNull();

    const [after] = await context.database
      .select({ revokedAt: enterpriseUserSession.revokedAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));
    expect(after?.revokedAt).not.toBeNull();
  });

  it("refuses a session whose user has been disabled", async () => {
    const { token, userId } = await seedSession();
    await context.database.update(enterpriseUser).set({ enabled: false }).where(eq(enterpriseUser.id, userId));

    expect(await manager().authenticate(token)).toBeNull();
  });

  it("revokes exactly once and records the revocation", async () => {
    const { token } = await seedSession();

    expect(await manager().revoke(token)).toBe(true);
    expect(await manager().revoke(token)).toBe(false);
    expect(await manager().authenticate(token)).toBeNull();

    const revocations = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "enterprise.session_revoked");
    expect(revocations).toHaveLength(1);
  });

  it("rejects a malformed token before touching PostgreSQL", async () => {

    expect(await manager().authenticate(undefined)).toBeNull();
    expect(await manager().authenticate("short")).toBeNull();
    expect(await manager().revoke("not-a-session-token")).toBe(false);
  });
});

describe("local sign-in", () => {
  const password = "correct-horse-battery";

  async function seedPerson(overrides: Record<string, unknown> = {}) {
    const [user] = await context.database.insert(enterpriseUser).values({
      issuer: "orcasynapse:local",
      subject: "ayu",
      displayName: "Ayu Pratama",
      lastLoginAt: null,
      ...overrides,
    }).returning();
    await context.database.insert(localUser).values({
      userId: user!.id,
      username: "ayu",
      passwordHash: await hashLocalPassword(password),
    });
    return user!;
  }

  /*
   * The point of the whole increment: a person an administrator created, who
   * has never seen an identity provider, can sign in and gets an ordinary
   * enterprise session -- so their division and `profileVisibleTo` work through
   * the federated path unchanged.
   */
  it("signs in a locally created person and stamps their first login", async () => {
    const user = await seedPerson();

    const issued = await manager().signInWithPassword("ayu", password, {});

    expect(issued.token).toHaveLength(43);
    expect(issued.principal).toMatchObject({ identityMode: "ENTERPRISE", displayName: "Ayu Pratama" });
    expect(issued.principal.session.passwordChangeRequired).toBe(true);
    const [row] = await context.database.select().from(enterpriseUser).where(eq(enterpriseUser.id, user.id)).limit(1);
    expect(row?.lastLoginAt).not.toBeNull();
    // The session it minted authenticates like any other, and still carries
    // the flag — GET /session is what the front page polls while they type.
    await expect(manager().authenticate(issued.token)).resolves.toMatchObject({
      displayName: "Ayu Pratama",
      session: { passwordChangeRequired: true },
    });
  });

  /*
   * Every rejection answers the same way. A different message for "no such
   * user" would turn this endpoint into a username oracle, which matters more
   * here than for administrators: these usernames are handed out by an
   * administrator and are likely to be guessable.
   */
  it("answers identically for a wrong password and an unknown username", async () => {
    await seedPerson();

    const wrongPassword = await manager().signInWithPassword("ayu", "not-the-password-at-all", {})
      .catch((error: Error) => error.message);
    const unknownUser = await manager().signInWithPassword("nobody", password, {})
      .catch((error: Error) => error.message);

    expect(wrongPassword).toBe(unknownUser);
  });

  it("refuses a disabled person", async () => {
    await seedPerson({ enabled: false });

    await expect(manager().signInWithPassword("ayu", password, {}))
      .rejects.toBeInstanceOf(EnterpriseIdentityError);
  });

  /*
   * Lockout, at the same threshold the administrator path uses -- both read
   * LOCAL_LOGIN_FAILURE_LIMIT, so the two credential stores cannot drift into
   * different definitions of "locked out". The correct password is refused
   * while the lock holds, which is the property that makes a lockout worth
   * having.
   */
  it("locks the account after the shared failure limit, and then refuses even the right password", async () => {
    const user = await seedPerson();

    for (let attempt = 0; attempt < LOCAL_LOGIN_FAILURE_LIMIT; attempt += 1) {
      await manager().signInWithPassword("ayu", "wrong-password-here", {}).catch(() => undefined);
    }

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, user.id)).limit(1);
    expect(credential?.failedLoginCount).toBe(LOCAL_LOGIN_FAILURE_LIMIT);
    expect(credential?.lockedUntil).not.toBeNull();
    await expect(manager().signInWithPassword("ayu", password, {}))
      .rejects.toBeInstanceOf(EnterpriseIdentityError);
  });

  /* A successful sign-in clears the count, so failures do not accumulate. */
  it("clears the failure count on success", async () => {
    const user = await seedPerson();
    await manager().signInWithPassword("ayu", "wrong-password-here", {}).catch(() => undefined);

    await manager().signInWithPassword("ayu", password, {});

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, user.id)).limit(1);
    expect(credential?.failedLoginCount).toBe(0);
  });
});

describe("local password change", () => {
  const password = "correct-horse-battery";
  const replacement = "a-much-stronger-password";

  async function seedPerson() {
    const [user] = await context.database.insert(enterpriseUser).values({
      issuer: "orcasynapse:local",
      subject: "ayu",
      displayName: "Ayu Pratama",
      lastLoginAt: null,
    }).returning();
    await context.database.insert(localUser).values({
      userId: user!.id,
      username: "ayu",
      passwordHash: await hashLocalPassword(password),
    });
    return user!;
  }

  it("clears the flag, burns every other session, and authenticates the replacement", async () => {
    const user = await seedPerson();
    const first = await manager().signInWithPassword("ayu", password, {});
    const second = await manager().signInWithPassword("ayu", password, {});

    const issued = await manager()
      .changeLocalPassword(first.token, password, replacement, {});

    expect(issued.principal.session.passwordChangeRequired).toBeUndefined();
    expect(issued.token).not.toBe(first.token);
    expect(await manager().authenticate(first.token)).toBeNull();
    expect(await manager().authenticate(second.token)).toBeNull();
    await expect(manager().authenticate(issued.token)).resolves.toMatchObject({
      displayName: "Ayu Pratama",
    });
    expect((await manager().authenticate(issued.token))?.session.passwordChangeRequired)
      .toBeUndefined();

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, user.id)).limit(1);
    expect(credential?.passwordChangeRequired).toBe(false);
    const changes = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "user.local_password_changed");
    expect(changes).toHaveLength(1);
  });

  it("refuses a wrong current password without burning the session", async () => {
    await seedPerson();
    const issued = await manager().signInWithPassword("ayu", password, {});

    await expect(manager().changeLocalPassword(issued.token, "not-the-password-at-all", replacement, {}))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", statusCode: 401 });
    await expect(manager().authenticate(issued.token)).resolves.not.toBeNull();
  });

  it("refuses a password change that reuses the current password", async () => {
    await seedPerson();
    const issued = await manager().signInWithPassword("ayu", password, {});

    await expect(manager().changeLocalPassword(issued.token, password, password, {}))
      .rejects.toMatchObject({ code: "USER_PASSWORD_INVALID", statusCode: 400 });
  });

  it("blames an expired session rather than the password", async () => {
    await seedPerson();
    const issued = await manager().signInWithPassword("ayu", password, {});
    await context.database.update(enterpriseUserSession).set({
      idleExpiresAt: new Date(Date.now() - 1_000),
    });

    await expect(manager().changeLocalPassword(issued.token, password, replacement, {}))
      .rejects.toMatchObject({ code: "SESSION_EXPIRED", statusCode: 401 });
  });

  it("refuses a federated identity that has no local password", async () => {
    const { token } = await seedSession();

    await expect(manager().changeLocalPassword(token, password, replacement, {}))
      .rejects.toMatchObject({ code: "USER_PASSWORD_UNSUPPORTED", statusCode: 400 });
  });
});
