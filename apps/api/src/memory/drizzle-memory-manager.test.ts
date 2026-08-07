import { randomUUID } from "node:crypto";
import { effectiveMemoryMode } from "@orcasynapse/contracts";
import {
  agentMemory,
  agentProfile,
  auditEvent,
  createTestDatabase,
  type TestDatabase,
} from "@orcasynapse/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleMemoryManager } from "./drizzle-memory-manager.js";
import type { ForgetMatcher } from "./forget-matcher.js";
import {
  AgentMemoryNotFoundError,
  ForgetMatchingUnavailableError,
  MemoryPolicyConflictError,
} from "./memory-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

function manager(matcher?: ForgetMatcher) {
  return new DrizzleMemoryManager(context.database, matcher);
}

/** Stands in for the model: matches exactly the facts whose text contains `needle`. */
function matcherMatching(needle: string, options: { succeeded?: boolean; truncated?: boolean } = {}) {
  return {
    match: vi.fn(async (_target: string, candidates: readonly { id: string; content: string }[]) => ({
      matchedIds: candidates.filter((c) => c.content.includes(needle)).map((c) => c.id),
      succeeded: options.succeeded ?? true,
      truncated: options.truncated ?? false,
    })),
  } as unknown as ForgetMatcher;
}

const principalId = randomUUID();
const principal = { id: principalId, subject: "security-admin" } as never;

const draft = {
  slug: "default-memory",
  displayName: "Default memory policy",
  description: "Bounds what every agent may remember.",
  maximumCaptureMode: "LEARN_EXCHANGE" as const,
  retentionDays: 365,
  maximumItemsPerOwner: 500,
  recallLimit: 6,
  recallMinimumScore: 0.4,
  knowledgeRecallLimit: 18,
  knowledgeMinimumScore: 0.35, distillCapture: true,
};

async function seedMemory(ownerSubject: string, slug = `agent-${randomUUID().slice(0, 8)}`) {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning({ id: agentProfile.id });
  const [record] = await context.database
    .insert(agentMemory)
    .values({
      ownerSubject,
      agentProfileId: profile!.id,
      content: `${ownerSubject} prefers concise answers.`,
      characterCount: 40,
      embeddingModel: "Xenova/bge-m3",
      embedding: Array.from({ length: 1024 }, () => 0.01),
    })
    .returning({ id: agentMemory.id });
  return { profileId: profile!.id, memoryId: record!.id };
}

describe("DrizzleMemoryManager policy lifecycle", () => {
  it("creates policies as drafts and activates exactly one", async () => {
    const created = await manager().create(principal, draft);
    expect(created.status).toBe("DRAFT");

    const active = await manager().activate(principal, created.id, { expectedRevision: created.revision, reason: "Approved." });
    expect(active.status).toBe("ACTIVE");
    expect(active.firstActivatedAt).not.toBeNull();

    const second = await manager().create(principal, { ...draft, slug: "stricter-memory" });
    await expect(manager().activate(principal, second.id, { expectedRevision: second.revision, reason: "Approved." }))
      .rejects.toThrow(/Suspend 'default-memory'/);
  });

  it("refuses to edit an active policy, because runs are being measured against it", async () => {
    const created = await manager().create(principal, draft);
    const active = await manager().activate(principal, created.id, { expectedRevision: created.revision, reason: "Approved." });

    await expect(manager().update(principal, created.id, { expectedRevision: active.revision, recallLimit: 10 }))
      .rejects.toThrow(/Suspend the active policy/);

    const suspended = await manager().suspend(principal, created.id, { expectedRevision: active.revision, reason: "Tightening." });
    const updated = await manager().update(principal, created.id, { expectedRevision: suspended.revision, recallLimit: 10 });
    expect(updated.recallLimit).toBe(10);
  });

  it("rejects a stale revision rather than overwriting another session", async () => {
    const created = await manager().create(principal, draft);
    await manager().update(principal, created.id, { expectedRevision: created.revision, recallLimit: 8 });

    await expect(manager().update(principal, created.id, { expectedRevision: created.revision, recallLimit: 9 }))
      .rejects.toBeInstanceOf(MemoryPolicyConflictError);
  });

  it("records the decision reason in the audit trail", async () => {
    const created = await manager().create(principal, draft);
    await manager().activate(principal, created.id, { expectedRevision: created.revision, reason: "Security review passed." });

    const events = await context.database
      .select({ action: auditEvent.action, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, created.id));
    expect(events.map(({ action }) => action)).toContain("memory.policy_activated");
    expect(JSON.stringify(events)).toContain("Security review passed.");
  });
});

describe("effectiveMemoryMode", () => {
  it("lets a policy narrow an agent but never widen it", () => {
    // The ceiling is what makes "stop storing things about people" a single
    // action instead of an edit to every profile.
    expect(effectiveMemoryMode("LEARN_EXCHANGE", "RECALL_ONLY")).toBe("RECALL_ONLY");
    expect(effectiveMemoryMode("LEARN_USER", "DOCUMENTS_ONLY")).toBe("DOCUMENTS_ONLY");
    // A profile that asks for less keeps its own narrower choice.
    expect(effectiveMemoryMode("DOCUMENTS_ONLY", "LEARN_EXCHANGE")).toBe("DOCUMENTS_ONLY");
    expect(effectiveMemoryMode("RECALL_ONLY", "LEARN_EXCHANGE")).toBe("RECALL_ONLY");
    // With no policy at all, the profile governs itself.
    expect(effectiveMemoryMode("LEARN_USER", null)).toBe("LEARN_USER");
  });
});

describe("DrizzleMemoryManager records", () => {
  it("lists stored memory with its provenance", async () => {
    const { profileId } = await seedMemory("user:a", "analyst");

    const { items } = await manager().records({ limit: 50 } as never);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ownerSubject: "user:a", agentProfileId: profileId, agentProfileSlug: "analyst" });
  });

  it("filters to one owner so an operator can answer 'what do you know about me'", async () => {
    await seedMemory("user:a");
    await seedMemory("user:b");

    const { items } = await manager().recordsForOwner("user:a");

    expect(items).toHaveLength(1);
    expect(items[0]?.ownerSubject).toBe("user:a");
  });

  it("lets an owner delete their own memory but not another person's", async () => {
    const mine = await seedMemory("user:a");
    const theirs = await seedMemory("user:b");

    await expect(manager().forget({ id: principalId, ownerSubject: "user:a" }, theirs.memoryId, "Not mine to delete."))
      .rejects.toBeInstanceOf(AgentMemoryNotFoundError);

    await manager().forget({ id: principalId, ownerSubject: "user:a" }, mine.memoryId, "Asked to be forgotten.");
    expect((await manager().recordsForOwner("user:a")).items).toHaveLength(0);
    expect((await manager().recordsForOwner("user:b")).items).toHaveLength(1);
  });

  it("lets an administrator delete across owners and records why", async () => {
    const theirs = await seedMemory("user:b");

    await manager().forget({ id: principalId }, theirs.memoryId, "Retention exception approved.");

    const [event] = await context.database
      .select({ action: auditEvent.action, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, theirs.memoryId));
    expect(event?.action).toBe("memory.deleted");
    // The reason and the owner, never the content that was deleted.
    expect(JSON.stringify(event?.metadata)).toContain("Retention exception approved.");
    expect(JSON.stringify(event?.metadata)).not.toContain("prefers concise answers");
  });

  it("purges one owner across every agent without touching anyone else", async () => {
    await seedMemory("user:a", "analyst");
    await seedMemory("user:a", "drafter");
    await seedMemory("user:b", "auditor");

    const removed = await manager().purge(principal, { ownerSubject: "user:a", reason: "Employee offboarded." });

    expect(removed).toBe(2);
    expect((await manager().recordsForOwner("user:a")).items).toHaveLength(0);
    expect((await manager().recordsForOwner("user:b")).items).toHaveLength(1);
  });
});

describe("forget-matching", () => {
  /** Three facts about one owner, two of them about the same topic. */
  async function seedTopic(ownerSubject = "user:pilot") {
    const [profile] = await context.database
      .insert(agentProfile)
      .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
      .returning({ id: agentProfile.id });
    const contents = [
      "The user leads the Titan migration.",
      "The user works in Jakarta.",
      "The user's Titan deadline is in March.",
    ];
    const ids: string[] = [];
    for (const content of contents) {
      const [row] = await context.database
        .insert(agentMemory)
        .values({
          ownerSubject,
          agentProfileId: profile!.id,
          content,
          characterCount: content.length,
          embeddingModel: "Xenova/bge-m3",
          embedding: Array.from({ length: 1024 }, () => 0.01),
        })
        .returning({ id: agentMemory.id });
      ids.push(row!.id);
    }
    return { profileId: profile!.id, ids };
  }

  const request = {
    ownerSubject: "user:pilot",
    target: "Project Titan",
    reason: "The person asked for the project to be forgotten.",
    dryRun: true,
    maximumForget: 25,
  };

  it("previews the decision without changing anything", async () => {
    // The preview is what makes a semantic bulk delete safe to offer at all.
    await seedTopic();

    const result = await manager(matcherMatching("Titan")).forgetMatching({ id: principalId }, request);

    expect(result).toMatchObject({ dryRun: true, matched: 2, forgotten: 0, forgetBatchId: null });
    expect(result.candidates.map((c) => c.content).sort()).toEqual([
      "The user leads the Titan migration.",
      "The user's Titan deadline is in March.",
    ]);
    const rows = await context.database.select().from(agentMemory);
    expect(rows.every((row) => row.forgottenAt === null)).toBe(true);
    expect(await context.database.select().from(auditEvent)).toHaveLength(0);
  });

  it("soft-deletes exactly the matches, under one batch id", async () => {
    await seedTopic();

    const result = await manager(matcherMatching("Titan"))
      .forgetMatching({ id: principalId }, { ...request, dryRun: false });

    expect(result).toMatchObject({ dryRun: false, matched: 2, forgotten: 2, capped: false });
    expect(result.forgetBatchId).not.toBeNull();
    const rows = await context.database.select().from(agentMemory);
    const forgotten = rows.filter((row) => row.forgottenAt !== null);
    expect(forgotten).toHaveLength(2);
    // One operator decision, one batch, so the whole action stays traceable.
    expect(new Set(forgotten.map((row) => row.forgetBatchId)).size).toBe(1);
    expect(forgotten[0]!.forgetBatchId).toBe(result.forgetBatchId);
    expect(forgotten.every((row) => row.forgetReason === request.reason)).toBe(true);
    // The row survives: soft delete, so what was forgotten stays answerable.
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.content.includes("Jakarta"))?.forgottenAt).toBeNull();
  });

  it("records the target and the counts, never the content", async () => {
    await seedTopic();

    await manager(matcherMatching("Titan"))
      .forgetMatching({ id: principalId }, { ...request, dryRun: false });

    const [event] = await context.database
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "memory.forgotten"));
    expect(event?.metadata).toMatchObject({
      target: "Project Titan", matched: 2, forgotten: 2, ownerSubject: "user:pilot",
    });
    expect(JSON.stringify(event?.metadata)).not.toContain("deadline is in March");
  });

  it("stops at the cap rather than emptying the store", async () => {
    // A model that decided everything matches must not be able to clear an
    // owner's memory in one call.
    await seedTopic();

    const result = await manager(matcherMatching("The user"))
      .forgetMatching({ id: principalId }, { ...request, dryRun: false, maximumForget: 1 });

    expect(result).toMatchObject({ matched: 3, forgotten: 1, capped: true });
    expect((await context.database.select().from(agentMemory))
      .filter((row) => row.forgottenAt !== null)).toHaveLength(1);
  });

  it("refuses rather than reporting an empty match when the model is unreachable", async () => {
    // "Nothing matched" would be read as "the topic is not stored", and acted on.
    await seedTopic();

    await expect(manager(matcherMatching("Titan", { succeeded: false }))
      .forgetMatching({ id: principalId }, { ...request, dryRun: false }))
      .rejects.toBeInstanceOf(ForgetMatchingUnavailableError);
    expect((await context.database.select().from(agentMemory))
      .every((row) => row.forgottenAt === null)).toBe(true);
  });

  it("refuses when no inference route is configured", async () => {
    await seedTopic();
    await expect(manager().forgetMatching({ id: principalId }, request))
      .rejects.toBeInstanceOf(ForgetMatchingUnavailableError);
  });

  it("cannot reach another owner's memory from a self-service principal", async () => {
    // The owner in the request never widens an enterprise principal's scope.
    await seedTopic("user:someone-else");

    const result = await manager(matcherMatching("Titan")).forgetMatching(
      { id: principalId, ownerSubject: "user:pilot" },
      { ...request, ownerSubject: "user:someone-else", dryRun: false },
    );

    expect(result).toMatchObject({ matched: 0, forgotten: 0 });
    expect((await context.database.select().from(agentMemory))
      .every((row) => row.forgottenAt === null)).toBe(true);
  });

  it("reports a partial scan rather than letting it pass as complete", async () => {
    await seedTopic();

    const result = await manager(matcherMatching("Titan", { truncated: true }))
      .forgetMatching({ id: principalId }, request);

    expect(result.truncated).toBe(true);
  });

  it("does not offer an already-forgotten fact a second time", async () => {
    const { ids } = await seedTopic();
    await context.database
      .update(agentMemory)
      .set({ forgottenAt: new Date(), forgetReason: "Earlier request.", forgetBatchId: randomUUID() })
      .where(eq(agentMemory.id, ids[0]!));

    const result = await manager(matcherMatching("Titan")).forgetMatching({ id: principalId }, request);

    expect(result.matched).toBe(1);
    expect(result.candidates[0]?.content).toBe("The user's Titan deadline is in March.");
  });
});

describe("what the record list means", () => {
  /** Jakarta, corrected to Bandung, plus one unrelated fact forgotten later. */
  async function seedLifecycle(ownerSubject = "user:pilot") {
    const [profile] = await context.database
      .insert(agentProfile)
      .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
      .returning({ id: agentProfile.id });
    const write = async (content: string, extra: Record<string, unknown> = {}) => {
      const [row] = await context.database
        .insert(agentMemory)
        .values({
          ownerSubject,
          agentProfileId: profile!.id,
          content,
          characterCount: content.length,
          embeddingModel: "Xenova/bge-m3",
          embedding: Array.from({ length: 1024 }, () => 0.01),
          ...extra,
        })
        .returning({ id: agentMemory.id });
      return row!.id;
    };
    const jakarta = await write("The user works in Jakarta.", {
      isLatest: false,
      supersededAt: new Date(),
      supersededReason: "Superseded by a later statement: The user works in Bandung.",
    });
    await write("The user works in Bandung.", { version: 2, parentMemoryId: jakarta, rootMemoryId: jakarta });
    await write("The user leads the Titan migration.", {
      forgottenAt: new Date(),
      forgetReason: "They asked us to forget the project.",
      forgetBatchId: randomUUID(),
    });
    return { profileId: profile!.id, jakarta };
  }

  it("lists what the agent would actually recall, not everything ever stored", async () => {
    // Before the lifecycle predicate existed this returned all three, so an
    // operator auditing an agent read a correction, its replacement and a
    // forgotten fact as if all were current.
    await seedLifecycle();

    const { items } = await manager().records({ limit: 50 } as never);

    expect(items.map((row) => row.content)).toEqual(["The user works in Bandung."]);
  });

  it("carries the chain, so a correction can be traced to what it replaced", async () => {
    const { jakarta } = await seedLifecycle();

    const [current] = (await manager().records({ limit: 50 } as never)).items;

    expect(current).toMatchObject({ version: 2, parentMemoryId: jakarta, rootMemoryId: jakarta, isLatest: true });
  });

  it("returns the retired fact and its reason when history is asked for", async () => {
    await seedLifecycle();

    const { items } = await manager().records({ limit: 50, includeSuperseded: true } as never);

    const retired = items.find((row) => row.content.includes("Jakarta"));
    expect(retired).toMatchObject({ isLatest: false, version: 1 });
    expect(retired?.supersededReason).toContain("Bandung");
    expect(retired?.supersededAt).not.toBeNull();
  });

  it("returns a forgotten fact only on request, with its batch and reason", async () => {
    await seedLifecycle();

    expect((await manager().records({ limit: 50 } as never)).items
      .some((row) => row.content.includes("Titan"))).toBe(false);

    const { items } = await manager().records({ limit: 50, includeForgotten: true } as never);
    const forgotten = items.find((row) => row.content.includes("Titan"));
    expect(forgotten?.forgetReason).toBe("They asked us to forget the project.");
    expect(forgotten?.forgetBatchId).not.toBeNull();
    expect(forgotten?.forgottenAt).not.toBeNull();
  });

  it("keeps a person's own view free of facts they had forgotten", async () => {
    // recordsForOwner backs the end-user "what do you know about me" surface.
    // Showing a forgotten fact there would answer a deletion request with the
    // thing that was supposed to be deleted.
    await seedLifecycle("user:ada");

    const { items } = await manager().recordsForOwner("user:ada");

    expect(items.map((row) => row.content)).toEqual(["The user works in Bandung."]);
  });
});
