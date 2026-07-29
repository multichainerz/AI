import { describe, expect, it } from "vitest";
import { boundedContextMessages } from "./prisma-chat-manager.js";

describe("chat context bounding", () => {
  it("keeps the newest complete messages within the character budget and restores chronology", () => {
    const result = boundedContextMessages([
      { role: "USER", content: "latest-user" },
      { role: "ASSISTANT", content: "recent-answer" },
      { role: "USER", content: "old-question" },
    ], 25);

    expect(result).toEqual([
      { role: "assistant", content: "recent-answer" },
      { role: "user", content: "latest-user" },
    ]);
  });
});
