import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guardrailPolicy } from "./drizzle/schema.js";
import { resolveRuntimeTextPolicy } from "./runtime-text-policy.js";
import { createTestDatabase, type TestDatabase } from "./testing.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

describe("resolveRuntimeTextPolicy", () => {
  it("returns default when the catalogue is empty", async () => {
    await expect(resolveRuntimeTextPolicy(context.database)).resolves.toEqual({ status: "default" });
  });

  it("returns active with id and version when exactly one policy is ACTIVE", async () => {
    const [row] = await context.database.insert(guardrailPolicy).values({
      slug: `policy-${randomUUID().slice(0, 8)}`,
      displayName: "Baseline",
      description: "Active catalogue row.",
      version: "policy-v3",
      status: "ACTIVE",
      maxInputCharacters: 32_000,
      maxOutputCharacters: 64_000,
      firstActivatedAt: new Date(),
      rules: [],
    }).returning({ id: guardrailPolicy.id });

    await expect(resolveRuntimeTextPolicy(context.database)).resolves.toEqual({
      status: "active",
      policy: {
        id: row!.id,
        version: "policy-v3",
        maxInputCharacters: 32_000,
        maxOutputCharacters: 64_000,
        blockControlCharacters: true,
        blockCredentialPatterns: true,
        rules: [],
      },
    });
  });

  it("returns unresolved when only drafts exist", async () => {
    await context.database.insert(guardrailPolicy).values({
      slug: `policy-${randomUUID().slice(0, 8)}`,
      displayName: "Drafted guardrails",
      description: "Written but never activated.",
      version: "1",
      status: "DRAFT",
      maxInputCharacters: 32_000,
      maxOutputCharacters: 64_000,
      firstActivatedAt: null,
      rules: [],
    });

    await expect(resolveRuntimeTextPolicy(context.database)).resolves.toEqual({
      status: "unresolved",
      activeCount: 0,
    });
  });
});
