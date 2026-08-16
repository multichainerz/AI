import { DEFAULT_AGENT_PROFILE } from "@orcasynapse/contracts";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing.js";
import { defaultAgentProfileDigest, runMigrations } from "./drizzle/migrate.js";
import { agentProfile, agentProfileVersion } from "./drizzle/schema.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);

/*
 * Puts the seeded profile back to how an install that predates a prompt change
 * looks: one version, carrying a digest this build no longer ships.
 *
 * `createTestDatabase` has already migrated, so version 1 holds the *current*
 * content -- exactly the fresh-install case, where the upgrade must do nothing.
 * Reproducing the case it exists for means ageing the row deliberately.
 */
async function profileId(): Promise<string> {
  const [profile] = await context.database.select({ id: agentProfile.id })
    .from(agentProfile).where(eq(agentProfile.slug, DEFAULT_AGENT_PROFILE.slug)).limit(1);
  return profile!.id;
}

/*
 * Back to what a fresh install looks like.
 *
 * `context.reset()` is not usable here: it truncates `SchemaMetadata` too, and
 * the next `runMigrations` then refuses the database for having no epoch. These
 * tests only ever touch the profile rows, so restoring those is both sufficient
 * and honest about what is being isolated.
 */
async function restoreFreshInstall(): Promise<string> {
  const id = await profileId();
  // Every version above the first, not just version 2. Deleting only 2 left the
  // gap test's version 3 behind for whatever ran next, which showed up as the
  // fresh-install case finding two versions on a database that should have one.
  await context.database.delete(agentProfileVersion)
    .where(and(eq(agentProfileVersion.profileId, id), gt(agentProfileVersion.version, 1)));
  await context.database.update(agentProfileVersion)
    .set({ instructions: DEFAULT_AGENT_PROFILE.instructions, distributionDigest: defaultAgentProfileDigest() })
    .where(eq(agentProfileVersion.profileId, id));
  await context.database.update(agentProfile)
    .set({ currentVersion: 1, activeVersion: 1 }).where(eq(agentProfile.id, id));
  return id;
}

/** How an install that predates the prompt change looks: a digest we no longer ship. */
async function ageToPreviousRelease(): Promise<string> {
  const id = await restoreFreshInstall();
  await context.database.update(agentProfileVersion)
    .set({
      instructions: "MEMORY\n- You can write notes with `remember` and search them with `recall`.",
      distributionDigest: "0".repeat(64),
    })
    .where(eq(agentProfileVersion.profileId, id));
  return id;
}

/** Re-runs the seeders the way a deployment restarting on a new release does. */
async function upgrade(): Promise<void> {
  await runMigrations(context.connectionString);
}

async function versions(profileId: string) {
  return context.database
    .select({ version: agentProfileVersion.version, instructions: agentProfileVersion.instructions })
    .from(agentProfileVersion)
    .where(eq(agentProfileVersion.profileId, profileId))
    .orderBy(asc(agentProfileVersion.version));
}

/*
 * The gap this closes.
 *
 * The profile seed is `ON CONFLICT DO NOTHING`, correctly -- it must never
 * overwrite an operator's prompt. The consequence is that a *correction* to the
 * shipped default reaches new installs only, which is the wrong half: an
 * existing deployment is precisely the one carrying the defect.
 */
describe("carrying a changed default profile to an existing install", () => {
  beforeEach(async () => { await restoreFreshInstall(); });

  it("mints and activates a second version when the install never customised it", async () => {
    const profileId = await ageToPreviousRelease();

    await upgrade();

    const all = await versions(profileId);
    expect(all.map(({ version }) => version)).toEqual([1, 2]);
    expect(all[1]?.instructions).toBe(DEFAULT_AGENT_PROFILE.instructions);
    // Activated, not merely present: a version nothing points at would leave the
    // defect in place while looking as though it had been fixed.
    const [profile] = await context.database.select().from(agentProfile).where(eq(agentProfile.id, profileId));
    expect(profile?.activeVersion).toBe(2);
    expect(profile?.currentVersion).toBe(2);
  });

  /*
   * Version 1 is immutable, and this is the assertion that keeps it so. A past
   * run reproduces the prompt it was given; rewriting it in place would make a
   * completed transcript unexplainable by the configuration it names.
   */
  it("leaves version 1 exactly as it was", async () => {
    const profileId = await ageToPreviousRelease();

    await upgrade();

    const all = await versions(profileId);
    expect(all[0]?.instructions).toContain("`remember`");
    expect(all[0]?.instructions).not.toBe(DEFAULT_AGENT_PROFILE.instructions);
  });

  /*
   * The one that decides whether this is safe to run on every startup. An
   * operator who wrote their own prompt has taken ownership, and a well-meant
   * upgrade replacing it would be the worst outcome available here -- worse
   * than the defect, because it destroys work rather than failing to fix it.
   */
  it("does not touch a profile the operator has already customised", async () => {
    const profileId = await ageToPreviousRelease();
    await context.database.insert(agentProfileVersion).values({
      profileId, version: 2, displayName: "House assistant", purpose: "Answer with our own policy.",
      instructions: "Follow the internal handbook and nothing else.", soulMd: "You are ours.",
      modelAlias: "hermes-agent", maxTurns: 1, timeoutSeconds: 60, maxConcurrentRuns: 1, safeMode: true,
    });
    await context.database.update(agentProfile)
      .set({ currentVersion: 2, activeVersion: 2 }).where(eq(agentProfile.id, profileId));

    await upgrade();

    const all = await versions(profileId);
    expect(all).toHaveLength(2);
    expect(all[1]?.instructions).toBe("Follow the internal handbook and nothing else.");
  });

  /*
   * The case that makes the `currentVersion` guard load-bearing, found by
   * mutating it away and watching the test above still pass.
   *
   * That test puts the operator's work on version 2, so removing the guard is
   * harmless there: the insert hits `ON CONFLICT DO NOTHING` and the update's
   * own `currentVersion = 1` predicate refuses. The conflict was doing the
   * protecting, and the test could not tell the difference.
   *
   * A profile whose history skips 2 -- a version deleted, or renumbered -- has
   * no conflict to hit. Without the guard an upgrade inserts a version 2 that
   * belongs to nobody, in the middle of somebody else's history.
   */
  it("adds nothing to a customised profile whose history has a gap at 2", async () => {
    const id = await ageToPreviousRelease();
    await context.database.insert(agentProfileVersion).values({
      profileId: id, version: 3, displayName: "House assistant", purpose: "Answer with our own policy.",
      instructions: "Follow the internal handbook and nothing else.", soulMd: "You are ours.",
      modelAlias: "hermes-agent", maxTurns: 1, timeoutSeconds: 60, maxConcurrentRuns: 1, safeMode: true,
    });
    await context.database.update(agentProfile)
      .set({ currentVersion: 3, activeVersion: 3 }).where(eq(agentProfile.id, id));

    await upgrade();

    expect((await versions(id)).map(({ version }) => version)).toEqual([1, 3]);
  });

  it("does nothing on a fresh install, which is already current", async () => {
    const id = await profileId();

    await upgrade();

    expect(await versions(id)).toHaveLength(1);
  });
});
