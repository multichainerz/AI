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
});
