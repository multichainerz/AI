import { describe, expect, it } from "vitest";
import {
  documentConversionJobPayloadSchema,
  documentDetailSchema,
  documentUploadMetadataSchema,
  quarantineDecisionSchema,
} from "./documents.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

describe("document contracts", () => {
  it("applies conservative upload defaults and rejects unrecognized metadata", () => {
    expect(documentUploadMetadataSchema.parse({})).toEqual({
      classification: "INTERNAL",
      retentionDays: 365,
    });
    expect(documentUploadMetadataSchema.parse({ retentionDays: "30" }).retentionDays).toBe(30);
    expect(() => documentUploadMetadataSchema.parse({ owner: "another-user" })).toThrow();
  });

  it("requires explicit, bounded quarantine decisions", () => {
    expect(quarantineDecisionSchema.parse({ decision: "APPROVE", reason: "Approved pilot source" })).toEqual({
      decision: "APPROVE",
      reason: "Approved pilot source",
    });
    expect(() => quarantineDecisionSchema.parse({ decision: "APPROVE", reason: "no" })).toThrow();
  });

  it("keeps normalization queue payloads generation-safe", () => {
    expect(documentConversionJobPayloadSchema.parse({ documentId: DOCUMENT_ID, generation: 2 })).toEqual({
      documentId: DOCUMENT_ID,
      generation: 2,
    });
    expect(() => documentConversionJobPayloadSchema.parse({
      documentId: DOCUMENT_ID,
      generation: 0,
    })).toThrow();
  });

  it("exposes transient staging state without durable document content", () => {
    const parsed = documentDetailSchema.parse({
      id: DOCUMENT_ID,
      fileName: "policy.txt",
      mediaType: "text/plain",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      classification: "CONFIDENTIAL",
      status: "READY",
      pageCount: 1,
      processingGeneration: 1,
      failureCode: null,
      failureMessage: null,
      stagingExpiresAt: null,
      stagingPurgedAt: "2026-07-30T00:01:00.000Z",
      reprocessAvailable: false,
      retentionUntil: "2027-07-30T00:00:00.000Z",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:01:00.000Z",
      completedAt: "2026-07-30T00:01:00.000Z",
    });
    expect(parsed.stagingPurgedAt).toBe("2026-07-30T00:01:00.000Z");
    expect(parsed.reprocessAvailable).toBe(false);
  });
});
