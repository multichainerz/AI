import { describe, expect, it } from "vitest";
import {
  createPromptTemplateSchema,
  promptTemplateSchema,
  updatePromptTemplateSchema,
} from "./prompts.js";

const content = "You are the approved OrcaSynapse assistant. Answer accurately and state uncertainty.";
const checksum = "a".repeat(64);

describe("prompt governance contracts", () => {
  it("accepts a bounded chat-system prompt draft", () => {
    expect(createPromptTemplateSchema.safeParse({
      slug: "orcasynapse-chat-system",
      displayName: "OrcaSynapse chat system",
      description: "Approved system behavior for employee chat.",
      purpose: "CHAT_SYSTEM",
      version: "1.0.0",
      content,
    }).success).toBe(true);
  });

  it("rejects active prompts without evidence and activation history", () => {
    expect(promptTemplateSchema.safeParse({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "orcasynapse-chat-system",
      displayName: "OrcaSynapse chat system",
      description: "Approved system behavior for employee chat.",
      purpose: "CHAT_SYSTEM",
      version: "1.0.0",
      status: "ACTIVE",
      content,
      contentChecksum: checksum,
      activationEvaluationId: null,
      firstActivatedAt: null,
      revision: 1,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }).success).toBe(false);
  });

  it("does not allow purpose changes through a revision update", () => {
    expect(updatePromptTemplateSchema.safeParse({ expectedRevision: 1, purpose: "CHAT_SYSTEM" }).success).toBe(false);
  });
});
