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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleMemoryManager } from "./drizzle-memory-manager.js";
import { AgentMemoryNotFoundError, MemoryPolicyConflictError } from "./memory-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

function manager() {
  return new DrizzleMemoryManager(context.database);
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
