import { describe, expect, it } from "vitest";
import { CHAT_SUGGESTIONS, pickChatSuggestions } from "./suggestions.js";

describe("pickChatSuggestions", () => {
  it("keeps a catalog large enough that two visits can differ", () => {
    expect(CHAT_SUGGESTIONS.length).toBeGreaterThanOrEqual(8);
  });

  it("returns the requested count of distinct catalog entries", () => {
    const picked = pickChatSuggestions(CHAT_SUGGESTIONS, 4, () => 0);
    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((item) => item.label)).size).toBe(4);
    for (const item of picked) {
      expect(CHAT_SUGGESTIONS).toContainEqual(item);
    }
  });

  it("can produce a different set when the stream of random values changes", () => {
    const first = pickChatSuggestions(CHAT_SUGGESTIONS, 4, () => 0).map((item) => item.label);
    const second = pickChatSuggestions(CHAT_SUGGESTIONS, 4, () => 0.99).map((item) => item.label);
    expect(first).not.toEqual(second);
  });
});
