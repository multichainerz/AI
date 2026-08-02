import { describe, expect, it } from "vitest";
import {
  chatStreamEventSchema,
  createChatConversationSchema,
  sendChatMessageSchema,
} from "./chat.js";

describe("chat contracts", () => {
  it("accepts bounded conversation and message inputs", () => {
    expect(createChatConversationSchema.parse({ modelAlias: "laguna-primary" })).toEqual({
      modelAlias: "laguna-primary",
    });
    expect(sendChatMessageSchema.parse({ content: "  Hello OrcaSynapse  " })).toEqual({
      content: "Hello OrcaSynapse",
    });
  });

  it("rejects unknown controls and oversized prompts", () => {
    expect(createChatConversationSchema.safeParse({ unrestrictedModel: true }).success).toBe(false);
    expect(sendChatMessageSchema.safeParse({ content: "x".repeat(32_001) }).success).toBe(false);
  });

  it("validates typed streaming events", () => {
    expect(chatStreamEventSchema.parse({
      type: "delta",
      conversationId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      messageId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      delta: "token",
    }).type).toBe("delta");
  });
});
