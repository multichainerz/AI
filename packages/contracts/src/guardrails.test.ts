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
  activationEvaluationId: null,
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

  it("requires evidence and a timestamp for active policy output", () => {
    expect(guardrailPolicySchema.safeParse({ ...draft, status: "ACTIVE" }).success).toBe(false);
    expect(guardrailPolicySchema.parse({
      ...draft,
      status: "ACTIVE",
      activationEvaluationId: "de44bc5d-0355-4c3f-872e-1af99f356d19",
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
    }).status).toBe("ACTIVE");
  });

  it("requires optimistic concurrency for updates", () => {
    expect(updateGuardrailPolicySchema.safeParse({ maxInputCharacters: 8_000 }).success).toBe(false);
    expect(updateGuardrailPolicySchema.parse({ expectedRevision: 2, maxInputCharacters: 8_000 }).expectedRevision).toBe(2);
  });
});
