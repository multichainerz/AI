import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  createTestDatabase,
  runtimeToolsetAdmission,
  skillSet,
  toolSet,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleConfigurationSetManager } from "./drizzle-configuration-set-manager.js";
import {
  ConfigurationSetConflictError,
  ConfigurationSetNotFoundError,
} from "./configuration-set-manager.js";
import type { AdminPrincipal } from "../auth/admin-session.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const principal = { id: randomUUID(), subject: "local-admin:operator" } as AdminPrincipal;

function manager() {
  return new DrizzleConfigurationSetManager(context.database);
}

async function admit(...names: string[]) {
  await context.database.insert(runtimeToolsetAdmission)
    .values(names.map((toolsetName) => ({ toolsetName, admitted: true, admittedBy: principal.id, reason: "Admitted for tests." })));
}

/*
 * `context.reset()` truncates every table, including the rows `runMigrations`
 * seeds, so these suites rebuild the tracking defaults rather than inheriting
 * them. The seed itself is covered where it belongs -- against a database that
 * has not been truncated -- in
 * `packages/database/src/default-configuration-sets.test.ts`.
 */
async function seedTrackingDefaults() {
  const [tools] = await context.database.insert(toolSet)
    .values({ slug: "default-tool-set", displayName: "Default tool set", tracksAdmission: true })
    .returning();
  const [skills] = await context.database.insert(skillSet)
    .values({ slug: "default-skill-set", displayName: "Default skill set", tracksRuntime: true })
    .returning();
  return { toolSetId: tools!.id, skillSetId: skills!.id };
}

/** A profile version holding both defaults, which is what blocks their delete. */
async function seedProfileHolding(sets: { toolSetId: string; skillSetId: string }) {
  const [profile] = await context.database.insert(agentProfile)
    .values({ slug: `support-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning();
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id, version: 1, displayName: "Support agent",
    purpose: "Help operators.", instructions: "Answer precisely.", soulMd: "Careful.",
    modelAlias: "hermes-agent", maxTurns: 1, timeoutSeconds: 120, maxConcurrentRuns: 1, safeMode: true,
    toolSetId: sets.toolSetId, skillSetId: sets.skillSetId,
  });
  return profile!.slug;
}

describe("DrizzleConfigurationSetManager", () => {
  /*
   * The seeded default is the reason `tracksAdmission` exists, so its behaviour
   * is pinned before anything an operator creates.
   *
   * At install nothing is admitted, so a snapshot-based default would be an
   * empty list. This asserts the opposite property: the *stored* member list
   * stays empty while the *resolved* one follows admission, so admitting a
   * toolset later widens the default without anyone editing it.
   */
  it("resolves the tracking default against admission, not a frozen list", async () => {
    await seedTrackingDefaults();
    const before = (await manager().listToolSets(false)).items
      .find(({ tracksAdmission }) => tracksAdmission);
    expect(before?.toolsetNames).toEqual([]);
    expect(before?.resolvedToolsetNames).toEqual([]);

    await admit("clarify", "bfl");

    const after = (await manager().listToolSets(false)).items
      .find(({ tracksAdmission }) => tracksAdmission);
    expect(after?.toolsetNames).toEqual([]);
    expect(after?.resolvedToolsetNames).toEqual(["bfl", "clarify"]);
  });

  /*
   * A set that names its own members must be distinguishable from one that
   * tracks. Null rather than a copy of its own list: a caller that cannot tell
   * the two apart would show "these toolsets" for a set that actually means
   * "whatever is admitted", and would then be wrong the moment admission moves.
   */
  it("leaves resolvedToolsetNames null on a set that names its members", async () => {
    await admit("clarify");
    const created = await manager().createToolSet(principal, {
      slug: `finance-${randomUUID().slice(0, 8)}`,
      displayName: "Finance tools",
      toolsetNames: ["clarify"],
    });

    expect(created.tracksAdmission).toBe(false);
    expect(created.resolvedToolsetNames).toBeNull();
    expect(created.toolsetNames).toEqual(["clarify"]);
  });

  it("refuses to give the tracking default a fixed member list", async () => {
    await seedTrackingDefaults();
    const seeded = (await manager().listToolSets(false)).items
      .find(({ tracksAdmission }) => tracksAdmission)!;

    await expect(manager().updateToolSet(principal, seeded.id, {
      toolsetNames: ["clarify"],
      expectedRevision: seeded.revision,
    })).rejects.toBeInstanceOf(ConfigurationSetConflictError);
  });

  it("refuses a stale revision", async () => {
    const created = await manager().createToolSet(principal, {
      slug: `stale-${randomUUID().slice(0, 8)}`, displayName: "Stale", toolsetNames: [],
    });
    await manager().updateToolSet(principal, created.id, {
      displayName: "First writer", expectedRevision: created.revision,
    });

    await expect(manager().updateToolSet(principal, created.id, {
      displayName: "Second writer", expectedRevision: created.revision,
    })).rejects.toBeInstanceOf(ConfigurationSetConflictError);
  });

  /*
   * Deleting a set a profile version depends on would silently rewrite what
   * that version was, which is the one thing an immutable version must never
   * do. The message names the profile because "in use" leaves an operator with
   * no next step.
   */
  it("refuses to delete a set a profile version references, naming the profile", async () => {
    const sets = await seedTrackingDefaults();
    const slug = await seedProfileHolding(sets);

    await expect(manager().deleteToolSet(principal, sets.toolSetId))
      .rejects.toThrow(`This set is used by ${slug}. Point it at another set first.`);
  });

  it("deletes a set nothing references", async () => {
    const created = await manager().createToolSet(principal, {
      slug: `spare-${randomUUID().slice(0, 8)}`, displayName: "Spare", toolsetNames: [],
    });

    await manager().deleteToolSet(principal, created.id);

    const [row] = await context.database.select().from(toolSet).where(eq(toolSet.id, created.id)).limit(1);
    expect(row).toBeUndefined();
  });

  it("answers 404 for a set that does not exist", async () => {
    await expect(manager().deleteToolSet(principal, randomUUID()))
      .rejects.toBeInstanceOf(ConfigurationSetNotFoundError);
  });

  it("retires a set without deleting it, and hides it unless asked", async () => {
    const created = await manager().createToolSet(principal, {
      slug: `retired-${randomUUID().slice(0, 8)}`, displayName: "Retired", toolsetNames: [],
    });
    await manager().updateToolSet(principal, created.id, {
      status: "RETIRED", expectedRevision: created.revision,
    });

    expect((await manager().listToolSets(false)).items.map(({ id }) => id)).not.toContain(created.id);
    expect((await manager().listToolSets(true)).items.map(({ id }) => id)).toContain(created.id);
  });

  it("keeps skill sets on the same rules", async () => {
    const sets = await seedTrackingDefaults();
    await seedProfileHolding(sets);
    const seeded = (await manager().listSkillSets(false)).items
      .find(({ tracksRuntime }) => tracksRuntime)!;
    expect(seeded.skills).toEqual([]);

    await expect(manager().updateSkillSet(principal, seeded.id, {
      skills: [], expectedRevision: seeded.revision,
    })).rejects.toBeInstanceOf(ConfigurationSetConflictError);
    await expect(manager().deleteSkillSet(principal, seeded.id))
      .rejects.toBeInstanceOf(ConfigurationSetConflictError);
  });

});
