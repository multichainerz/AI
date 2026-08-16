import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentProfile,
  createTestDatabase,
  division,
  enterpriseUser,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleDivisionManager } from "./drizzle-division-manager.js";
import { DivisionConflictError, DivisionNotFoundError } from "./division-manager.js";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { profileVisibleTo } from "../agents/profile-visibility.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const principal = { id: randomUUID(), subject: "local-admin:operator" } as AdminPrincipal;

function manager() {
  return new DrizzleDivisionManager(context.database);
}

async function seedProfile() {
  const [row] = await context.database.insert(agentProfile)
    .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning();
  return row!;
}

describe("DrizzleDivisionManager", () => {
  it("creates a division with any name the administrator chooses", async () => {
    const created = await manager().create(principal, {
      slug: "jakarta-operations", displayName: "Jakarta Operations",
    });

    expect(created).toMatchObject({
      slug: "jakarta-operations", displayName: "Jakarta Operations",
      status: "ACTIVE", profileCount: 0, userCount: 0, revision: 1,
    });
  });

  it("rejects a duplicate slug", async () => {
    await manager().create(principal, { slug: "finance", displayName: "Finance" });

    await expect(manager().create(principal, { slug: "finance", displayName: "Finance again" }))
      .rejects.toBeInstanceOf(DivisionConflictError);
  });

  it("refuses a stale revision", async () => {
    const created = await manager().create(principal, { slug: "legal", displayName: "Legal" });
    await manager().update(principal, created.id, { displayName: "Legal team", expectedRevision: created.revision });

    await expect(manager().update(principal, created.id, {
      displayName: "Second writer", expectedRevision: created.revision,
    })).rejects.toBeInstanceOf(DivisionConflictError);
  });

  /*
   * The counts exist so an administrator can see the blast radius before making
   * a change, which means they have to follow the rows rather than a stored
   * number that can drift from them.
   */
  it("counts what a division holds, from the rows", async () => {
    const created = await manager().create(principal, { slug: "support", displayName: "Support" });
    const profile = await seedProfile();
    await manager().assignProfile(principal, profile.id, created.id, profile.currentVersion);
    await context.database.insert(enterpriseUser).values({
      issuer: "https://idp.example", subject: `user-${randomUUID().slice(0, 8)}`,
      displayName: "Member", lastLoginAt: new Date(), divisionId: created.id,
    });

    const [listed] = (await manager().list(false)).items;
    expect(listed).toMatchObject({ id: created.id, profileCount: 1, userCount: 1 });
  });

  /*
   * Deleting a division that still holds things would orphan them silently.
   * The refusal names what is in the way and points at suspension, because an
   * administrator who is told only "in use" has no next step.
   */
  it("refuses to delete a division that still holds a profile, and says what to do instead", async () => {
    const created = await manager().create(principal, { slug: "finance", displayName: "Finance" });
    const profile = await seedProfile();
    await manager().assignProfile(principal, profile.id, created.id, profile.currentVersion);

    await expect(manager().remove(principal, created.id))
      .rejects.toThrow("Finance still holds 1 agent profile. Move them elsewhere, or suspend the division instead of deleting it.");
  });

  it("deletes an empty division", async () => {
    const created = await manager().create(principal, { slug: "spare", displayName: "Spare" });

    await manager().remove(principal, created.id);

    const [row] = await context.database.select().from(division).where(eq(division.id, created.id)).limit(1);
    expect(row).toBeUndefined();
  });

  /*
   * A suspended division is one taken out of use, so moving work *into* it
   * would create profiles nobody can reach. Moving work out is always allowed,
   * which is why only the target is checked.
   */
  it("refuses to assign a profile into a suspended division, but allows moving out", async () => {
    const created = await manager().create(principal, { slug: "retired", displayName: "Retired" });
    const profile = await seedProfile();
    await manager().assignProfile(principal, profile.id, created.id, profile.currentVersion);
    await manager().update(principal, created.id, { status: "SUSPENDED", expectedRevision: created.revision });

    const other = await seedProfile();
    await expect(manager().assignProfile(principal, other.id, created.id, other.currentVersion))
      .rejects.toBeInstanceOf(DivisionConflictError);

    // Out is fine: nothing is stranded by returning a profile to deployment-wide.
    await expect(manager().assignProfile(principal, profile.id, null, profile.currentVersion))
      .resolves.toBeUndefined();
  });

  it("answers 404 for a division that does not exist", async () => {
    await expect(manager().remove(principal, randomUUID()))
      .rejects.toBeInstanceOf(DivisionNotFoundError);
    const profile = await seedProfile();
    await expect(manager().assignProfile(principal, profile.id, randomUUID(), profile.currentVersion))
      .rejects.toBeInstanceOf(DivisionNotFoundError);
  });

  /*
   * The whole point, end to end: what an administrator does through this
   * manager is what the visibility rule then enforces. Asserted against the
   * real predicate rather than a restatement of it, so the two cannot drift.
   */
  it("makes an assignment the visibility rule actually acts on", async () => {
    const alpha = await manager().create(principal, { slug: "alpha", displayName: "Alpha" });
    const beta = await manager().create(principal, { slug: "beta", displayName: "Beta" });
    const profile = await seedProfile();

    const member = { identityMode: "ENTERPRISE" as const, scopes: [], divisionId: alpha.id };

    // Deployment-wide to begin with: visible from anywhere.
    const before = await context.database.select().from(agentProfile).where(eq(agentProfile.id, profile.id)).limit(1);
    expect(profileVisibleTo(member, before[0])).toBe(true);

    await manager().assignProfile(principal, profile.id, beta.id, profile.currentVersion);

    const after = await context.database.select().from(agentProfile).where(eq(agentProfile.id, profile.id)).limit(1);
    expect(profileVisibleTo(member, after[0])).toBe(false);
    expect(profileVisibleTo({ ...member, divisionId: beta.id }, after[0])).toBe(true);
  });
});
