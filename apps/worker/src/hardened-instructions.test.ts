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
});
