import { describe, expect, it } from "vitest";
import {
  documentConversionJobPayloadSchema,
  documentDetailSchema,
  documentOcrJobPayloadSchema,
  documentUploadMetadataSchema,
  quarantineDecisionSchema,
} from "./documents.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const ARTIFACT_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";

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

  it("keeps queue payloads generation-safe and page-bounded", () => {
    expect(documentConversionJobPayloadSchema.parse({ documentId: DOCUMENT_ID, generation: 2 })).toEqual({
      documentId: DOCUMENT_ID,
      generation: 2,
    });
    expect(documentOcrJobPayloadSchema.parse({
      documentId: DOCUMENT_ID,
      generation: 2,
      pageNumbers: [1, 2],
    }).pageNumbers).toEqual([1, 2]);
    expect(() => documentOcrJobPayloadSchema.parse({
      documentId: DOCUMENT_ID,
      generation: 0,
      pageNumbers: [],
    })).toThrow();
  });

  it("represents whole-document artifacts without inventing page zero", () => {
    const parsed = documentDetailSchema.parse({
      id: DOCUMENT_ID,
      fileName: "policy.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      classification: "CONFIDENTIAL",
      status: "READY",
      pageCount: 2,
      processingGeneration: 1,
      failureCode: null,
      failureMessage: null,
      retentionUntil: "2027-07-30T00:00:00.000Z",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:01:00.000Z",
      completedAt: "2026-07-30T00:01:00.000Z",
      textPreview: "Policy text",
      artifacts: [{
        id: ARTIFACT_ID,
        kind: "OCR_TEXT",
        pageNumber: null,
        mediaType: "text/plain",
        sizeBytes: 11,
        sha256: "b".repeat(64),
        createdAt: "2026-07-30T00:01:00.000Z",
      }],
    });
    expect(parsed.artifacts[0]?.pageNumber).toBeNull();
  });
});
