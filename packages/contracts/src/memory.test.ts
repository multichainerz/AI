import { describe, expect, it } from "vitest";
import { knowledgeSourceSchema } from "./memory.js";

const DOCUMENT_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";

describe("knowledge source contracts", () => {
  it("retains only the bounded source evidence shared by Chat and Agent runs", () => {
    expect(knowledgeSourceSchema.parse({
      documentId: DOCUMENT_ID,
      fileName: "policy.txt",
      classification: "INTERNAL",
      score: 0.91,
      excerpt: "Approved internal policy excerpt.",
    })).toMatchObject({ score: 0.91, classification: "INTERNAL" });
  });
});
