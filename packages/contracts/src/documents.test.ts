import { describe, expect, it } from "vitest";
import {
  documentDetailSchema,
  documentMetricsSchema,
  documentUploadMetadataSchema,
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

  it("exposes metadata and projected Supermemory state without source-storage fields", () => {
    const parsed = documentDetailSchema.parse({
      id: DOCUMENT_ID,
      fileName: "policy.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      classification: "CONFIDENTIAL",
      status: "READY",
      failureCode: null,
      failureMessage: null,
      retentionUntil: "2027-07-30T00:00:00.000Z",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:01:00.000Z",
      completedAt: "2026-07-30T00:01:00.000Z",
    });
    expect(parsed.fileName).toBe("policy.pdf");
    expect(Object.keys(parsed)).not.toContain("stagingKey");
  });

  it("makes zero retained source bytes a contract invariant", () => {
    expect(documentMetricsSchema.parse({
      generatedAt: "2026-08-03T00:00:00.000Z",
      total: 1,
      processing: 0,
      ready: 1,
      failed: 0,
      retainedSourceBytes: 0,
    }).retainedSourceBytes).toBe(0);
    expect(() => documentMetricsSchema.parse({
      generatedAt: "2026-08-03T00:00:00.000Z",
      total: 1,
      processing: 0,
      ready: 1,
      failed: 0,
      retainedSourceBytes: 1,
    })).toThrow();
  });
});
