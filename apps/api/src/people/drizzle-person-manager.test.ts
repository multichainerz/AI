import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  division,
  enterpriseUser,
  enterpriseUserSession,
  localUser,
  type TestDatabase,
} from "@orcasynapse/database";
import { verifyLocalPassword } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DrizzlePersonManager,
  LOCAL_ISSUER,
  PersonConflictError,
  PersonNotFoundError,
} from "./drizzle-person-manager.js";
import type { AdminPrincipal } from "../auth/admin-session.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const principal = { id: randomUUID(), subject: "local-admin:operator" } as AdminPrincipal;
const password = "correct-horse-battery";

function manager() {
  return new DrizzlePersonManager(context.database);
}

function personInput(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Ayu Pratama",
    username: `ayu-${randomUUID().slice(0, 8)}`,
    password,
    ...overrides,
  } as never;
}

async function liveSession(userId: string) {
  await context.database.insert(enterpriseUserSession).values({
    tokenHash: Buffer.from(randomUUID()),
    userId,
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    absoluteExpiresAt: new Date(Date.now() + 36_000_000),
    lastSeenAt: new Date(),
  });
}

describe("DrizzlePersonManager", () => {
  /*
   * The whole reason this increment exists: before it, an EnterpriseUser row
   * could only appear when somebody arrived through an identity provider, so a
   * deployment with no IdP had a division boundary and nobody to apply it to.
   */
  it("creates a person who has never signed in", async () => {
    const created = await manager().create(principal, personInput());

    expect(created).toMatchObject({
      displayName: "Ayu Pratama", credential: "LOCAL", enabled: true,
      lastLoginAt: null, passwordChangeRequired: true, divisionId: null,
    });
    const [row] = await context.database.select().from(enterpriseUser)
      .where(eq(enterpriseUser.id, created.id)).limit(1);
    expect(row?.issuer).toBe(LOCAL_ISSUER);
  });

  it("stores the password hashed, never in the clear", async () => {
    const created = await manager().create(principal, personInput());

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, created.id)).limit(1);
    expect(credential?.passwordHash).toBeDefined();
    expect(credential!.passwordHash).not.toContain(password);
    await expect(verifyLocalPassword(password, credential!.passwordHash)).resolves.toBe(true);
  });

  it("rejects a duplicate username", async () => {
    const input = personInput();
    await manager().create(principal, input);

    await expect(manager().create(principal, input)).rejects.toBeInstanceOf(PersonConflictError);
  });

  it("refuses a password below the local policy", async () => {
    await expect(manager().create(principal, personInput({ password: "short" })))
      .rejects.toBeInstanceOf(PersonConflictError);
  });

  it("puts a person in a division, and refuses a suspended one", async () => {
    const [active] = await context.database.insert(division)
      .values({ slug: "finance", displayName: "Finance" }).returning();
    const [suspended] = await context.database.insert(division)
      .values({ slug: "retired", displayName: "Retired", status: "SUSPENDED" }).returning();

    const created = await manager().create(principal, personInput({ divisionId: active!.id }));
    expect(created.divisionId).toBe(active!.id);

    await expect(manager().create(principal, personInput({ divisionId: suspended!.id })))
      .rejects.toBeInstanceOf(PersonConflictError);
  });

  /*
   * Disabling somebody has to end the session they are already in.
   *
   * Otherwise the account is disabled for the next sign-in and unchanged for
   * the one already open -- the opposite of what an administrator means by
   * disabling a person, and the gap lasts as long as the session's absolute
   * lifetime.
   */
  it("revokes every live session when a person is disabled", async () => {
    const created = await manager().create(principal, personInput());
    await liveSession(created.id);

    await manager().update(principal, created.id, { enabled: false });

    const sessions = await context.database.select().from(enterpriseUserSession)
      .where(eq(enterpriseUserSession.userId, created.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt).not.toBeNull();
  });

  /* A reset is the intended way out of a lockout, so it must clear one. */
  it("resets a password, clears the lockout, and ends live sessions", async () => {
    const created = await manager().create(principal, personInput());
    await context.database.update(localUser)
      .set({ failedLoginCount: 9, lockedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(localUser.userId, created.id));
    await liveSession(created.id);

    await manager().resetPassword(principal, created.id, "another-valid-passphrase");

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, created.id)).limit(1);
    expect(credential).toMatchObject({ failedLoginCount: 0, lockedUntil: null, passwordChangeRequired: true });
    await expect(verifyLocalPassword("another-valid-passphrase", credential!.passwordHash)).resolves.toBe(true);
    const [session] = await context.database.select().from(enterpriseUserSession)
      .where(eq(enterpriseUserSession.userId, created.id)).limit(1);
    expect(session?.revokedAt).not.toBeNull();
  });

  /*
   * A federated person has no password this product holds, so "reset" has no
   * meaning for them. Saying so beats failing with a null dereference or,
   * worse, appearing to succeed.
   */
  it("explains that a federated person has no password here", async () => {
    const [user] = await context.database.insert(enterpriseUser).values({
      issuer: "https://idp.example", subject: "federated-person",
      displayName: "Federated Person", lastLoginAt: new Date(),
    }).returning();

    await expect(manager().resetPassword(principal, user!.id, "another-valid-passphrase"))
      .rejects.toBeInstanceOf(PersonNotFoundError);
    expect((await manager().list()).items.find(({ id }) => id === user!.id)?.credential).toBe("FEDERATED");
  });
});
