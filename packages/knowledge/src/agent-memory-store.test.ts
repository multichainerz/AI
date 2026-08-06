import { eq } from "drizzle-orm";
import {
  agentMemory,
  agentProfile,
  agentProfileVersion,
  createTestDatabase,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentMemoryStore } from "./agent-memory-store.js";
import { APPROVED_EMBEDDING_DIMENSIONS, APPROVED_EMBEDDING_MODEL } from "./embedding.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

function store() {
  return new AgentMemoryStore(context.database, APPROVED_EMBEDDING_MODEL);
}

/** Deterministic and separable: each seed produces its own direction. */
function vector(seed: number): number[] {
  return Array.from({ length: APPROVED_EMBEDDING_DIMENSIONS }, (_, index) =>
    Math.sin(seed * 7.3 + index * 0.017) / 24);
}

async function profileFor(slug: string): Promise<string> {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning({ id: agentProfile.id });
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id,
    version: 1,
    displayName: slug,
    purpose: "A bounded test agent.",
    instructions: "Answer precisely.",
    modelAlias: "hermes-agent",
    maxTurns: 1,
    timeoutSeconds: 600,
    maxConcurrentRuns: 1,
    safeMode: true,
  });
  return profile!.id;
}

const ALL = { limit: 10, minimumScore: -1 };

describe("AgentMemoryStore", () => {
  it("recalls what an owner told this agent", async () => {
    const profileId = await profileFor("analyst");
    await store().remember("user-a", profileId, [
      { content: "Prefers metric units and Bahasa Indonesia summaries.", embedding: vector(1) },
    ]);

    const hits = await store().recall("user-a", profileId, "units", vector(1), ALL);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("metric units");
  });

  it("stops recalling a fact once a later one supersedes it", async () => {
    // The case a similarity floor cannot catch: "loves Adidas" and "switching
    // to Puma" are not near-duplicates, but the second retires the first.
    const profileId = await profileFor("assistant");
    await store().remember("user-a", profileId, [
      { content: "The user loves Adidas sneakers.", embedding: vector(11), scope: "STATIC" },
    ]);
    const [existing] = await store().list("user-a", profileId);

    await store().remember("user-a", profileId, [{
      content: "The user prefers Puma sneakers.",
      embedding: vector(12),
      scope: "STATIC",
      replaces: [existing!.id],
    }]);

    // Recall returns the current answer only, whichever vector is asked for.
    const hits = await store().recall("user-a", profileId, "sneakers", vector(11), ALL);
    expect(hits.map(({ content }) => content)).toEqual(["The user prefers Puma sneakers."]);
    // And the profile follows, since it is the same current-facts predicate.
    expect((await store().profile("user-a", profileId)).map(({ content }) => content))
      .toEqual(["The user prefers Puma sneakers."]);
  });

  it("keeps the retired fact, with a reason, rather than deleting it", async () => {
    // History is the point: "what did it used to believe, and when did that
    // change" has to stay answerable after a correction.
    const profileId = await profileFor("assistant");
    await store().remember("user-a", profileId, [
      { content: "The user works in Jakarta.", embedding: vector(13), scope: "STATIC" },
    ]);
    const [original] = await store().list("user-a", profileId);
    await store().remember("user-a", profileId, [{
      content: "The user works in Bandung.", embedding: vector(14), scope: "STATIC", replaces: [original!.id],
    }]);

    const rows = await context.database.select().from(agentMemory);
    expect(rows).toHaveLength(2);
    const retired = rows.find((row) => row.id === original!.id);
    expect(retired?.isLatest).toBe(false);
    expect(retired?.supersededAt).not.toBeNull();
    expect(retired?.supersededReason).toContain("Bandung");
  });

  it("cannot retire another owner's fact by naming its id", async () => {
    // Supersession is scoped by the same predicate as everything else, so a
    // borrowed id from another owner does nothing.
    const profileId = await profileFor("assistant");
    await store().remember("user-b", profileId, [
      { content: "Belongs to user B.", embedding: vector(15), scope: "STATIC" },
    ]);
    const [theirs] = await store().list("user-b", profileId);

    await store().remember("user-a", profileId, [{
      content: "The user prefers Puma.", embedding: vector(16), scope: "STATIC", replaces: [theirs!.id],
    }]);

    expect((await store().profile("user-b", profileId)).map(({ content }) => content))
      .toEqual(["Belongs to user B."]);
  });

  it("never returns another owner's memory, whatever the query vector", async () => {
    const profileId = await profileFor("analyst");
    await store().remember("user-a", profileId, [{ content: "User A salary is confidential.", embedding: vector(2) }]);

    // The same vector that matches for user-a must return nothing for user-b:
    // the owner boundary is a predicate in the statement, not a ranking effect.
    expect(await store().recall("user-b", profileId, "salary", vector(2), ALL)).toEqual([]);
  });

  it("keeps one agent's memory out of another agent's recall", async () => {
    const [analyst, drafter] = [await profileFor("analyst"), await profileFor("drafter")];
    await store().remember("user-a", analyst, [{ content: "Reviews finance decks on Fridays.", embedding: vector(3) }]);

    expect(await store().recall("user-a", drafter, "finance", vector(3), ALL)).toEqual([]);
    expect(await store().recall("user-a", analyst, "finance", vector(3), ALL)).toHaveLength(1);
  });

  it("hides expired memory without deleting it, and prunes it on the next write", async () => {
    const profileId = await profileFor("analyst");
    await store().remember("user-a", profileId, [{ content: "A temporary preference.", embedding: vector(4) }], {
      retentionUntil: new Date(Date.now() - 1_000),
    });
    await store().remember("user-a", profileId, [{ content: "A lasting preference.", embedding: vector(5) }]);

    const hits = await store().recall("user-a", profileId, "preference", vector(4), ALL);
    expect(hits.map(({ content }) => content)).toEqual(["A lasting preference."]);

    const pruned = await store().prune("user-a", profileId, 100);
    expect(pruned).toBe(1);
    expect(await store().countFor("user-a", profileId)).toBe(1);
  });

  it("trims the oldest beyond the cap so one owner cannot grow without bound", async () => {
    const profileId = await profileFor("analyst");
    for (let index = 0; index < 5; index += 1) {
      await store().remember("user-a", profileId, [{ content: `Observation number ${index}.`, embedding: vector(index) }]);
    }

    expect(await store().prune("user-a", profileId, 3)).toBe(2);
    const remaining = await store().list("user-a", profileId);
    expect(remaining).toHaveLength(3);
    // Newest survive: the oldest observations are the ones dropped.
    expect(remaining[0]?.content).toBe("Observation number 4.");
  });

  it("forgets only within the caller's own scope", async () => {
    const profileId = await profileFor("analyst");
    await store().remember("user-a", profileId, [{ content: "Belongs to user A.", embedding: vector(6) }]);
    const [item] = await store().list("user-a", profileId);

    // A stray id from another session must not reach across owners.
    expect(await store().forget("user-b", item!.id)).toBe(false);
    expect(await store().countFor("user-a", profileId)).toBe(1);
    expect(await store().forget("user-a", item!.id)).toBe(true);
    expect(await store().countFor("user-a", profileId)).toBe(0);
  });

  it("purges an owner across every agent when asked", async () => {
    const [analyst, drafter] = [await profileFor("analyst"), await profileFor("drafter")];
    await store().remember("user-a", analyst, [{ content: "Analyst observation.", embedding: vector(7) }]);
    await store().remember("user-a", drafter, [{ content: "Drafter observation.", embedding: vector(8) }]);
    await store().remember("user-b", analyst, [{ content: "Another person entirely.", embedding: vector(9) }]);

    expect(await store().purge("user-a")).toBe(2);
    expect(await store().countFor("user-a", analyst)).toBe(0);
    expect(await store().countFor("user-b", analyst)).toBe(1);
  });

  it("drops an agent's memory when the profile is deleted", async () => {
    const profileId = await profileFor("analyst");
    await store().remember("user-a", profileId, [{ content: "Tied to this profile.", embedding: vector(10) }]);

    await context.database.delete(agentProfile).where(eq(agentProfile.id, profileId));

    expect(await store().countFor("user-a", profileId)).toBe(0);
  });
});

