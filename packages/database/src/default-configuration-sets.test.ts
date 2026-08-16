import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing.js";
import { DEFAULT_SKILL_SET_SLUG, DEFAULT_TOOL_SET_SLUG } from "./drizzle/migrate.js";
import { agentProfileVersion, skillSet, toolSet } from "./drizzle/schema.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);

/*
 * `createTestDatabase` runs `runMigrations`, which is what seeds these. So this
 * file exercises a real fresh install rather than a fixture standing in for one,
 * which matters here: the bug this guards against only appears on an install
 * where nothing has been admitted yet, and that is precisely a fresh database.
 */
describe("the default configuration sets seeded at installation", () => {
  it("seeds one of each, marked as tracking rather than fixed", async () => {
    const [tools] = await context.database
      .select().from(toolSet).where(eq(toolSet.slug, DEFAULT_TOOL_SET_SLUG)).limit(1);
    const [skills] = await context.database
      .select().from(skillSet).where(eq(skillSet.slug, DEFAULT_SKILL_SET_SLUG)).limit(1);

    expect(tools).toMatchObject({ displayName: "Default tool set", status: "ACTIVE", tracksAdmission: true });
    expect(skills).toMatchObject({ displayName: "Default skill set", status: "ACTIVE", tracksRuntime: true });
  });

  /*
   * The failure this exists to catch, and the reason the flag is not cosmetic.
   *
   * `RuntimeToolsetAdmission` is empty at install -- nothing is admitted until
   * an operator admits it, and no node has enrolled to report anything. A
   * default set built by snapshotting "everything admitted right now" would
   * therefore be an empty list, and would be indistinguishable on screen from a
   * profile deliberately permitted no tools at all.
   *
   * So an empty member list is asserted *together with* the tracking flag: empty
   * is correct only because the flag says the emptiness is not the answer. Drop
   * the flag to a snapshot and this fails, which is the whole point.
   */
  it("means everything, not nothing, despite listing no members yet", async () => {
    const [tools] = await context.database
      .select().from(toolSet).where(eq(toolSet.slug, DEFAULT_TOOL_SET_SLUG)).limit(1);

    expect(tools?.toolsetNames).toEqual([]);
    expect(tools?.tracksAdmission).toBe(true);
  });

  /*
   * The backfill. Without it the seeded profile ships with no sets at all, and
   * the first thing an operator sees on a fresh install is a profile the API
   * would refuse to recreate.
   */
  it("points every existing profile version at both defaults", async () => {
    const versions = await context.database
      .select({ toolSetId: agentProfileVersion.toolSetId, skillSetId: agentProfileVersion.skillSetId })
      .from(agentProfileVersion);

    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version.toolSetId).not.toBeNull();
      expect(version.skillSetId).not.toBeNull();
    }
  });
});
