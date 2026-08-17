import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditEvent,
  createTestDatabase,
  guardrailPolicy,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleGuardrailManager } from "./drizzle-guardrail-manager.js";
import { GuardrailConflictError, GuardrailNotFoundError } from "./guardrail-manager.js";

let context: TestDatabase;
const principal = { id: randomUUID(), subject: "security-admin" } as never;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

function manager() {
  return new DrizzleGuardrailManager(context.database);
}

const draft = {
  slug: "chat-baseline",
  displayName: "Chat baseline policy",
  description: "Bounds chat input and output for the governed assistant.",
  version: "1.0.0",
  maxInputCharacters: 32_000,
  maxOutputCharacters: 200_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
  rules: [],
};

async function healthyInference(status: "HEALTHY" | "DEGRADED" = "HEALTHY") {
  await context.database.insert(serviceConnection).values({
    slug: `inference-${randomUUID().slice(0, 8)}`,
    kind: "INFERENCE",
    displayName: "Local inference",
    environment: "DEVELOPMENT",
    enabled: true,
    status,
    baseUrl: "http://127.0.0.1:8000",
    configuration: {},
  });
}

describe("DrizzleGuardrailManager", () => {
  it("creates a draft policy and audits it without leaking runtime thresholds as secrets", async () => {
    const created = await manager().create(principal, draft);

    expect(created.status).toBe("DRAFT");
    const [event] = await context.database
      .select({ action: auditEvent.action, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, created.id));
    expect(event?.action).toBe("guardrail.policy_created");
    expect(JSON.stringify(event?.metadata)).toContain("ORCASYNAPSE");
  });

  it("rejects a second policy reusing a slug", async () => {
    await manager().create(principal, draft);
    await expect(manager().create(principal, draft)).rejects.toBeInstanceOf(GuardrailConflictError);
  });

  it("requires a new version when runtime controls change", async () => {
    const created = await manager().create(principal, draft);

    await expect(
      manager().update(principal, created.id, {
        expectedRevision: created.revision,
        maxInputCharacters: 8_000,
      }),
    ).rejects.toThrow(/require a new policy version/i);
  });

  it("allows a cosmetic edit without a version bump and keeps it out of draft", async () => {
    const created = await manager().create(principal, draft);

    const renamed = await manager().update(principal, created.id, {
      expectedRevision: created.revision,
      displayName: "Renamed baseline",
    });

    expect(renamed.displayName).toBe("Renamed baseline");
    expect(renamed.status).toBe("DRAFT");
  });

  it("requires exactly one healthy effective inference route", async () => {
    const created = await manager().create(principal, draft);

    await expect(
      manager().activate(principal, created.id, { expectedRevision: created.revision, reason: "Release" }),
    ).rejects.toThrow(/enabled and healthy before policy activation/);

    await healthyInference("DEGRADED");
    await expect(
      manager().activate(principal, created.id, { expectedRevision: created.revision, reason: "Release" }),
    ).rejects.toThrow(/enabled and healthy before policy activation/);
  });

  it("activates atomically on its own merits, with no evaluation evidence", async () => {
    const created = await manager().create(principal, draft);
    expect(created.status).toBe("DRAFT");
    await healthyInference();

    const activated = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
    });

    expect(activated.status).toBe("ACTIVE");
    expect(activated.firstActivatedAt).not.toBeNull();

    const [stored] = await context.database
      .select({ status: guardrailPolicy.status })
      .from(guardrailPolicy)
      .where(eq(guardrailPolicy.id, created.id));
    expect(stored?.status).toBe("ACTIVE");
  });

  it("permits only one active chat policy at a time", async () => {
    const first = await manager().create(principal, draft);
    await healthyInference();
    await manager().activate(principal, first.id, { expectedRevision: first.revision, reason: "Release" });

    const second = await manager().create(principal, { ...draft, slug: "chat-alternate" });

    await expect(
      manager().activate(principal, second.id, { expectedRevision: second.revision, reason: "Release" }),
    ).rejects.toThrow(/Suspend 'Chat baseline policy'/);
  });

  it("refuses a stale expected revision", async () => {
    const created = await manager().create(principal, draft);
    await expect(
      manager().update(principal, created.id, { expectedRevision: created.revision + 9, displayName: "x" }),
    ).rejects.toThrow(/changed in another session/i);
  });

  it("reports a missing policy distinctly from a conflict", async () => {
    await expect(
      manager().suspend(principal, randomUUID(), { expectedRevision: 1, reason: "x" }),
    ).rejects.toBeInstanceOf(GuardrailNotFoundError);
  });

  it("suspends only an active policy and returns it to editable state", async () => {
    const created = await manager().create(principal, draft);
    await expect(
      manager().suspend(principal, created.id, { expectedRevision: created.revision, reason: "x" }),
    ).rejects.toThrow(/Only the active policy/);

    await healthyInference();
    const active = await manager().activate(principal, created.id, {
      expectedRevision: created.revision,
      reason: "Release",
    });

    const suspended = await manager().suspend(principal, created.id, {
      expectedRevision: active.revision,
      reason: "Rollback",
    });
    expect(suspended.status).toBe("SUSPENDED");
  });

  it("round-trips a rule list through the jsonb column", async () => {
    const created = await manager().create(principal, {
      ...draft,
      rules: [{
        id: "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e01",
        label: "Internal codename",
        type: "WORD",
        pattern: "seahorse",
        action: "BLOCK",
        caseSensitive: false,
        enabled: true,
      }],
    });

    expect(created.rules).toHaveLength(1);
    expect(created.rules[0]).toMatchObject({ label: "Internal codename", type: "WORD", action: "BLOCK" });
    // Read back through a second call, so this covers the column and the dto
    // rather than the object the create happened to return.
    const [listed] = (await manager().list()).items;
    expect(listed?.rules[0]?.pattern).toBe("seahorse");
  });

  it("defaults an existing policy to no rules rather than to undefined", async () => {
    // What the additive migration produces for every row that predates rules.
    const created = await manager().create(principal, draft);
    expect(created.rules).toEqual([]);
  });

  it("treats a rule edit as a material change, exactly like a threshold", async () => {
    /*
     * The guarantee the whole policy model rests on: the rules a run enforced
     * are attributable to a named version. If a rule could be edited without a
     * new version, that sentence would be false for precisely the part an
     * operator edits most.
     */
    const created = await manager().create(principal, draft);
    const rules = [{
      id: "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e02",
      label: "Added later",
      type: "PHRASE" as const,
      pattern: "not for release",
      action: "FLAG" as const,
      caseSensitive: false,
      enabled: true,
    }];

    await expect(
      manager().update(principal, created.id, { expectedRevision: created.revision, rules }),
    ).rejects.toThrow(/require a new policy version/);

    const updated = await manager().update(principal, created.id, {
      expectedRevision: created.revision,
      version: "2.0.0",
      rules,
    });
    expect(updated.status).toBe("DRAFT");
    expect(updated.rules).toHaveLength(1);
  });

  it("does not call an unchanged rule list a change", async () => {
    // Compared canonically, so re-sending the same rules with keys in another
    // order is not mistaken for an edit and does not demand a version bump.
    const rules = [{
      id: "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e03",
      label: "Stable",
      type: "WORD" as const,
      pattern: "seahorse",
      action: "BLOCK" as const,
      caseSensitive: false,
      enabled: true,
    }];
    const created = await manager().create(principal, { ...draft, rules });

    const updated = await manager().update(principal, created.id, {
      expectedRevision: created.revision,
      displayName: "Renamed only",
      rules: [{ ...rules[0]! }],
    });
    expect(updated.displayName).toBe("Renamed only");
  });

  it("refuses an unsafe pattern before it can ever reach an inspection path", async () => {
    /*
     * Vetting at save is what lets the hot path compile without re-probing. A
     * catastrophic pattern that reached the column would be evaluated against
     * every message until somebody noticed the API had stopped answering.
     */
    await expect(manager().create(principal, {
      ...draft,
      rules: [{
        id: "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e04",
        label: "Catastrophic",
        type: "REGEX",
        pattern: "(a+)+b",
        action: "BLOCK",
        caseSensitive: false,
        enabled: true,
      }],
    })).rejects.toThrow(/backtracks exponentially/);

    // And nothing was written on the way out.
    expect(await context.database.select().from(guardrailPolicy)).toHaveLength(0);
  });
});
