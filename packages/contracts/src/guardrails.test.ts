import { describe, expect, it } from "vitest";
import {
  createGuardrailPolicySchema,
  guardrailPolicySchema,
  updateGuardrailPolicySchema,
} from "./guardrails.js";

const draft = {
  id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
  slug: "chat-safety",
  displayName: "Chat safety",
  description: "Approved input and output controls for internal chat.",
  version: "1.0.0",
  status: "DRAFT",
  maxInputCharacters: 12_000,
  maxOutputCharacters: 200_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
  rules: [],
  firstActivatedAt: null,
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
} as const;

describe("guardrail policy contracts", () => {
  it("accepts a bounded policy draft", () => {
    expect(createGuardrailPolicySchema.parse({
      slug: draft.slug,
      displayName: draft.displayName,
      description: draft.description,
      version: draft.version,
      maxInputCharacters: draft.maxInputCharacters,
      maxOutputCharacters: draft.maxOutputCharacters,
      blockControlCharacters: draft.blockControlCharacters,
      blockCredentialPatterns: draft.blockCredentialPatterns,
    })).toMatchObject({ slug: "chat-safety", maxInputCharacters: 12_000 });
  });

  it("rejects unsafe response ceilings", () => {
    expect(createGuardrailPolicySchema.safeParse({ ...draft, maxOutputCharacters: 512 }).success).toBe(false);
    expect(createGuardrailPolicySchema.safeParse({ ...draft, maxOutputCharacters: 1_000_001 }).success).toBe(false);
  });

  it("refuses to write an output ceiling the runtime would discard, while still reading one", () => {
    /*
     * `submitRun` clamps with Math.min(200_000, …), so 500,000 was accepted by
     * the contract, stored, shown on the screen, and never honoured. The write
     * bound now refuses it -- and the read bound deliberately does not, because
     * it validates rows on the way *out* and an existing deployment holding a
     * larger value must not turn into a 500 on a working screen.
     */
    expect(createGuardrailPolicySchema.safeParse({ ...draft, maxOutputCharacters: 500_000 }).success).toBe(false);
    expect(updateGuardrailPolicySchema.safeParse({ expectedRevision: 1, maxOutputCharacters: 500_000 }).success).toBe(false);
    expect(guardrailPolicySchema.safeParse({ ...draft, maxOutputCharacters: 500_000 }).success).toBe(true);
  });

  it("carries a rule list, and bounds it", () => {
    const rule = {
      id: "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
      label: "Internal codename",
      type: "WORD",
      pattern: "seahorse",
      action: "BLOCK",
      caseSensitive: false,
      enabled: true,
    } as const;

    expect(guardrailPolicySchema.parse({ ...draft, rules: [rule] }).rules[0]?.label).toBe("Internal codename");
    // Absent on create is an empty list, so an operator who adds no rules gets
    // exactly the policy they get today.
    expect(createGuardrailPolicySchema.parse({
      slug: draft.slug,
      displayName: draft.displayName,
      description: draft.description,
      version: draft.version,
      maxInputCharacters: draft.maxInputCharacters,
      maxOutputCharacters: draft.maxOutputCharacters,
      blockControlCharacters: draft.blockControlCharacters,
      blockCredentialPatterns: draft.blockCredentialPatterns,
    }).rules).toEqual([]);
    // Every enabled rule costs an evaluation on every inspected message.
    expect(guardrailPolicySchema.safeParse({
      ...draft,
      rules: Array.from({ length: 101 }, (_, index) => ({ ...rule, id: `0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e${String(index).padStart(2, "0")}` })),
    }).success).toBe(false);
    expect(guardrailPolicySchema.safeParse({ ...draft, rules: [{ ...rule, type: "GLOB" }] }).success).toBe(false);
  });

  it("requires an activation timestamp for active policy output", () => {
    expect(guardrailPolicySchema.safeParse({ ...draft, status: "ACTIVE" }).success).toBe(false);
    expect(guardrailPolicySchema.parse({
      ...draft,
      status: "ACTIVE",
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
    }).status).toBe("ACTIVE");
  });

  it("requires optimistic concurrency for updates", () => {
    expect(updateGuardrailPolicySchema.safeParse({ maxInputCharacters: 8_000 }).success).toBe(false);
    expect(updateGuardrailPolicySchema.parse({ expectedRevision: 2, maxInputCharacters: 8_000 }).expectedRevision).toBe(2);
  });
});
