import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditEvent,
  createTestDatabase,
  evaluationRun,
  promptTemplate,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzlePromptManager } from "./drizzle-prompt-manager.js";
import { PromptConflictError, PromptNotFoundError } from "./prompt-manager.js";

let context: TestDatabase;
const principal = { id: randomUUID(), subject: "platform-admin" } as never;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

function manager() {
  return new DrizzlePromptManager(context.database);
}

const draft = {
  slug: "chat-system",
  displayName: "Chat system prompt",
  description: "Governs the assistant persona for chat.",
  purpose: "CHAT_SYSTEM" as const,
  version: "1.0.0",
  content: "You are a careful internal analyst who cites approved evidence only.",
};

/**
 * A promoted run must satisfy EvaluationRun_evidence_check: completed, promoted,
 * with a reason and at least one category result. Building it correctly here is
 * itself coverage - a mock would have accepted an unpromotable row.
 */
async function promoteEvidence(slug: string, version: string) {
  await context.database.insert(evaluationRun).values({
    name: "Prompt release evaluation",
    targetType: "PROMPT",
    targetReference: `prompt:${slug}`,
    targetVersion: version,
    status: "PROMOTED",
    minimumPassRate: 0.9,
    requiredCategories: ["CHAT", "SAFETY"],
    categoryResults: [
      { category: "CHAT", passRate: 1, passed: true },
      { category: "SAFETY", passRate: 1, passed: true },
    ],
    totalCases: 2,
    passedCases: 2,
    completedAt: new Date(),
    promotedAt: new Date(),
    promotionReason: "Approved for release.",
  });
}

describe("DrizzlePromptManager", () => {
  it("creates a template with a content checksum and audits the checksum, not the content", async () => {
    const created = await manager().create(principal, draft);

    expect(created.status).toBe("DRAFT");
    expect(created.contentChecksum).toMatch(/^[a-f0-9]{64}$/);

    const [event] = await context.database
      .select({ metadata: auditEvent.metadata, action: auditEvent.action })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, created.id));
    expect(event?.action).toBe("prompt.template_created");
    expect(JSON.stringify(event?.metadata)).toContain(created.contentChecksum);
    expect(JSON.stringify(event?.metadata)).not.toContain("careful internal analyst");
  });

  it("rejects a second template reusing a slug", async () => {
    await manager().create(principal, draft);
    await expect(manager().create(principal, draft)).rejects.toBeInstanceOf(PromptConflictError);
  });

  it("requires a new version when prompt content changes", async () => {
    const created = await manager().create(principal, draft);

    await expect(
      manager().update(principal, created.id, {
        expectedRevision: created.revision,
        content: "A materially different instruction body that is long enough.",
      }),
    ).rejects.toThrow(/require a new version/i);
  });

  it("refuses an update whose expected revision is stale", async () => {
    const created = await manager().create(principal, draft);

    await expect(
      manager().update(principal, created.id, {
        expectedRevision: created.revision + 5,
        displayName: "Renamed",
      }),
    ).rejects.toThrow(/changed in another session/i);
  });

  it("requires exact promoted chat and safety evidence before activating", async () => {
    const created = await manager().create(principal, draft);

    await expect(
      manager().activate(principal, created.id, { expectedRevision: created.revision, reason: "Release" }),
    ).rejects.toThrow(/promoted CHAT and SAFETY evaluation evidence/);

    await promoteEvidence(draft.slug, draft.version);
    const activated = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
    });

    expect(activated.status).toBe("ACTIVE");
    expect(activated.activationEvaluationId).not.toBeNull();
    expect(activated.firstActivatedAt).not.toBeNull();
  });

  it("rejects a second active prompt for the same purpose", async () => {
    const first = await manager().create(principal, draft);
    await promoteEvidence(draft.slug, draft.version);
    await manager().activate(principal, first.id, { expectedRevision: first.revision, reason: "Release" });

    const second = await manager().create(principal, { ...draft, slug: "chat-system-alt" });
    await promoteEvidence("chat-system-alt", draft.version);

    await expect(
      manager().activate(principal, second.id, { expectedRevision: second.revision, reason: "Release" }),
    ).rejects.toThrow(/Suspend 'Chat system prompt'/);
  });

  it("blocks editing an active prompt until it is suspended", async () => {
    const created = await manager().create(principal, draft);
    await promoteEvidence(draft.slug, draft.version);
    const active = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
    });

    await expect(
      manager().update(principal, created.id, { expectedRevision: active.revision, displayName: "Renamed" }),
    ).rejects.toThrow(/Suspend the active prompt/);

    const suspended = await manager().suspend(principal, created.id, {
      expectedRevision: active.revision,
      reason: "Rollback",
    });
    expect(suspended.status).toBe("SUSPENDED");

    const renamed = await manager().update(principal, created.id, {
      expectedRevision: suspended.revision,
      displayName: "Renamed",
    });
    expect(renamed.displayName).toBe("Renamed");
  });

  it("only suspends a prompt that is active", async () => {
    const created = await manager().create(principal, draft);
    await expect(
      manager().suspend(principal, created.id, { expectedRevision: created.revision, reason: "No" }),
    ).rejects.toThrow(/Only an active prompt/);
  });

  it("reports a missing prompt distinctly from a conflict", async () => {
    await expect(
      manager().update(principal, randomUUID(), { expectedRevision: 1, displayName: "x" }),
    ).rejects.toBeInstanceOf(PromptNotFoundError);
  });

  it("returns a material edit to draft and clears its activation evidence", async () => {
    const created = await manager().create(principal, draft);
    await promoteEvidence(draft.slug, draft.version);
    const active = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
    });
    const suspended = await manager().suspend(principal, created.id, {
      expectedRevision: active.revision,
      reason: "Rollback",
    });

    const edited = await manager().update(principal, created.id, {
      expectedRevision: suspended.revision,
      version: "1.1.0",
      content: "A revised instruction body that is comfortably long enough to store.",
    });

    expect(edited.status).toBe("DRAFT");
    expect(edited.activationEvaluationId).toBeNull();

    const [stored] = await context.database
      .select({ status: promptTemplate.status })
      .from(promptTemplate)
      .where(and(eq(promptTemplate.id, created.id), eq(promptTemplate.status, "DRAFT")));
    expect(stored).toBeDefined();
  });
});
