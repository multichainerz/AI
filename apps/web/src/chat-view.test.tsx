import type { DocumentSummary } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { createClientMessageId, knowledgeScopeSummary, pinnableDocuments } from "./chat-view.js";

function summary(fileName: string, status: DocumentSummary["status"]): DocumentSummary {
  return { id: `${fileName}-id`, fileName, status, classification: "INTERNAL" } as DocumentSummary;
}

describe("pinnableDocuments", () => {
  it("offers only documents that are actually indexed", () => {
    const offered = pinnableDocuments([
      summary("ready.pdf", "READY"),
      summary("queued.pdf", "QUEUED"),
      summary("failed.pdf", "FAILED"),
    ]);

    expect(offered.map(({ fileName }) => fileName)).toEqual(["ready.pdf"]);
  });

  it("offers nothing when the library is empty or entirely unindexed", () => {
    expect(pinnableDocuments([])).toEqual([]);
    expect(pinnableDocuments([summary("queued.pdf", "QUEUED")])).toEqual([]);
  });
});

describe("knowledgeScopeSummary", () => {
  it("says retrieval is unrestricted when nothing is pinned", () => {
    // An unpinned conversation retrieves across everything the owner holds,
    // which is a materially different answer than a pinned one.
    expect(knowledgeScopeSummary(0)).toContain("every document you own");
  });

  it("names the restriction and agrees with itself on plurals", () => {
    expect(knowledgeScopeSummary(1)).toBe("Answers are restricted to 1 pinned document.");
    expect(knowledgeScopeSummary(3)).toBe("Answers are restricted to 3 pinned documents.");
  });
});

describe("createClientMessageId", () => {
  it("prefers the platform UUID when one is available", () => {
    expect(createClientMessageId({ randomUUID: () => "3f1d0f0c-0f6a-4a1f-9a0e-6f3f4d2c1b0a" }))
      .toBe("3f1d0f0c-0f6a-4a1f-9a0e-6f3f4d2c1b0a");
  });

  it("still produces a distinct id when no platform crypto exists", () => {
    const first = createClientMessageId(null);
    const second = createClientMessageId(null);

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });
});
