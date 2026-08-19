/**
 * The slug field's two rules, tested on the helper rather than through a form.
 *
 * These assertions used to live in `guardrails-view.test.tsx`, driving the
 * policy editor's slug input. That screen composes its slug from the version
 * now, so the coverage would have gone with the field -- while `slugAsTyped`
 * and `slugify` are still what Models, Access, Connections and configuration
 * sets put under every slug an operator types. Tested here they cover all
 * four instead of the one screen that happened to be asserted.
 */
import { describe, expect, it } from "vitest";
import { slugAsTyped, slugify } from "./slug.js";

describe("slugAsTyped", () => {
  it("lets a hyphen be typed, because every seeded slug has one", () => {
    // Trimming the trailing hyphen on each keystroke deletes the separator
    // before the next character arrives, so 'chat-safety' would be unreachable
    // by typing it.
    let value = "";
    for (const character of "chat-safety") value = slugAsTyped(value + character);
    expect(value).toBe("chat-safety");
  });

  it("keeps the value legal as it is typed", () => {
    expect(slugAsTyped("Chat Safety!")).toBe("chatsafety");
    expect(slugAsTyped("chat--safety")).toBe("chat-safety");
    expect(slugAsTyped("a".repeat(80))).toHaveLength(64);
  });
});

describe("slugify", () => {
  it("trims a half-typed trailing hyphen, which is what leaving the field is for", () => {
    expect(slugify("chat-safety-")).toBe("chat-safety");
  });

  it("normalizes a display name into a slug", () => {
    expect(slugify("  Chat Safety  ")).toBe("chat-safety");
    expect(slugify("-Chat  Safety-")).toBe("chat-safety");
  });
});
