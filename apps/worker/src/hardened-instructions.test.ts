import { describe, expect, it } from "vitest";
import { hardenedInstructions } from "./agent-processor.js";

/*
 * The system text a governed run is started with. This is the one place the
 * control plane composes anything the model reads, so what it does with an
 * absent soul is worth pinning: the instructions are appended unconditionally,
 * and the old fallback substituted them for a missing soul, emitting the same
 * paragraph twice under two headings — which reads to a model as emphasis
 * rather than as the absence it actually was.
 */
const run = (soulMd: string, instructions = "Answer support questions from the handbook.") =>
  ({ version: { soulMd, instructions } } as never);

describe("hardenedInstructions", () => {
  it("does not repeat the instructions when a Profile has no soul", () => {
    const text = hardenedInstructions(run("   "));
    const occurrences = text.split("Answer support questions from the handbook.").length - 1;

    expect(occurrences).toBe(1);
    expect(text).not.toContain("PROFILE DISTRIBUTION BEHAVIOR");
  });

  it("treats a soul below the length floor as absent rather than as content", () => {
    // Nine characters: under the floor, so the heading must not appear at all.
    expect(hardenedInstructions(run("too short"))).not.toContain("PROFILE DISTRIBUTION BEHAVIOR");
    expect(hardenedInstructions(run("long enough to count"))).toContain("PROFILE DISTRIBUTION BEHAVIOR");
  });

  it("keeps the soul, the instructions and the boundary in that order when all three exist", () => {
    const text = hardenedInstructions(run("Speak plainly and cite the handbook."));

    expect(text.indexOf("PROFILE DISTRIBUTION BEHAVIOR"))
      .toBeLessThan(text.indexOf("Answer support questions from the handbook."));
    expect(text.indexOf("Answer support questions from the handbook."))
      .toBeLessThan(text.indexOf("ORCASYNAPSE ENFORCED EXECUTION BOUNDARY"));
    expect(text).toContain("Speak plainly and cite the handbook.");
  });

  it("always states the execution boundary, whatever the Profile carries", () => {
    for (const soul of ["", "too short", "a properly written soul document"]) {
      expect(hardenedInstructions(run(soul))).toContain("ORCASYNAPSE ENFORCED EXECUTION BOUNDARY");
    }
  });

  /*
   * The remembered section's budget, and which limit actually holds it.
   *
   * There were two, and the comment on them argued that both were load-bearing:
   * "forty one-line notes and four notes of two thousand characters are the
   * same problem". Only the second sentence was true. The entry limit was 40
   * over a caller that returns at most 20 matched notes or 5 recent ones, so it
   * could not fire from production and nothing here could observe it -- while
   * the character budget stops both cases on its own, because forty one-line
   * notes cost far less than six thousand characters and never needed stopping.
   *
   * Two hundred notes is more than any caller produces, deliberately: this
   * function is exported, so what bounds its output has to be a property of the
   * function rather than of one caller's `LIMIT` clause. The assertion is that
   * the budget is nearly full when it stops, which is what distinguishes "the
   * characters ran out" from "a count ran out".
   */
  it("stops remembering on the character budget rather than on a count of notes", () => {
    const notes = [...Array(200).keys()].map((index) => ({
      content: `Note ${index}: ${"policy detail ".repeat(3)}`,
      at: new Date("2026-08-01T00:00:00.000Z"),
    }));

    const text = hardenedInstructions(run("A properly written soul document."), notes);
    const rendered = (text.match(/^- \(2026-08-01\) Note \d+: .*$/gm) ?? []);
    const characters = rendered.reduce((total, line) => total + line.length, 0);

    expect(rendered.length).toBeGreaterThan(40);
    expect(characters).toBeLessThanOrEqual(6_000);
    expect(characters).toBeGreaterThan(5_900);
  });
});
