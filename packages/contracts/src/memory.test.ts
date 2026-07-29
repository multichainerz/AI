import { describe, expect, it } from "vitest";
import {
  knowledgeSourceSchema,
  memoryIndexJobPayloadSchema,
  memoryMetricsSchema,
} from "./memory.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

describe("memory contracts", () => {
  it("keeps synchronization jobs generation-safe and action-explicit", () => {
    expect(memoryIndexJobPayloadSchema.parse({
      documentId: DOCUMENT_ID,
      generation: 3,
      action: "UPSERT",
    })).toEqual({ documentId: DOCUMENT_ID, generation: 3, action: "UPSERT" });
    expect(() => memoryIndexJobPayloadSchema.parse({
      documentId: DOCUMENT_ID,
      generation: 3,
      action: "UPSERT",
      containerTag: "caller-controlled",
    })).toThrow();
  });

  it("bounds knowledge evidence stored with assistant messages", () => {
    expect(knowledgeSourceSchema.parse({
      documentId: DOCUMENT_ID,
      fileName: "policy.pdf",
      classification: "CONFIDENTIAL",
      score: 0.87,
      excerpt: "Approved policy evidence.",
    })).toMatchObject({ fileName: "policy.pdf", score: 0.87 });
    expect(() => knowledgeSourceSchema.parse({
      documentId: DOCUMENT_ID,
      fileName: "policy.pdf",
      classification: "CONFIDENTIAL",
      score: 1.5,
      excerpt: "Out-of-range relevance.",
    })).toThrow();
  });

  it("rejects internally inconsistent negative metrics", () => {
    expect(() => memoryMetricsSchema.parse({
      generatedAt: new Date().toISOString(),
      total: -1,
      queued: 0,
      processing: 0,
      ready: 0,
      failed: 0,
      deletePending: 0,
    })).toThrow();
  });
});
