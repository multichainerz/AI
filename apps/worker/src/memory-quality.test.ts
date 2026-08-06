import { describe, expect, it } from "vitest";
import {
  MEMORY_QUALITY_SUITE,
  formatReport,
  parseVerdict,
  summarise,
  type MemoryQualityOutcome,
  type MemoryQuestionType,
} from "./memory-quality.js";

/**
 * The scoring is the part that can lie. A judge verdict read too generously, or
 * a skipped case folded into the total, produces a number that says memory works
 * when nothing was measured — which is worse than having no metric at all.
 */

function outcome(
  type: MemoryQuestionType,
  passed: boolean,
  skipped?: string,
): MemoryQualityOutcome {
  return {
    case: { id: `${type}-${passed}`, type, setup: [], question: "?", criterion: "." },
    answer: "",
    passed,
    ...(skipped ? { skipped } : {}),
  };
}

describe("parseVerdict", () => {
  it("reads a bare verdict either way", () => {
    expect(parseVerdict("PASS")).toBe(true);
    expect(parseVerdict("FAIL")).toBe(false);
    expect(parseVerdict("  pass\n")).toBe(true);
  });

  it("reads a verdict a small model wrapped in a fence", () => {
    expect(parseVerdict("```\nPASS\n```")).toBe(true);
  });

  it("fails an answer the judge could not decide", () => {
    // An unreadable verdict over a wrong answer would inflate every score, so
    // anything short of an unambiguous PASS is a failure.
    expect(parseVerdict("")).toBe(false);
    expect(parseVerdict("It depends on how you read the criterion.")).toBe(false);
    expect(parseVerdict("PASS, though arguably FAIL")).toBe(false);
  });

  it("does not read PASS out of a longer word", () => {
    expect(parseVerdict("The answer is passable.")).toBe(false);
    expect(parseVerdict("COMPASS")).toBe(false);
  });
});

describe("summarise", () => {
  it("scores each type on its own, so a failure points somewhere", () => {
    const report = summarise([
      outcome("stated-fact", true),
      outcome("profile", true),
      outcome("temporal", false),
      outcome("temporal", false),
    ]);

    expect(report.byType).toEqual([
      { type: "stated-fact", passed: 1, total: 1, skipped: 0 },
      { type: "profile", passed: 1, total: 1, skipped: 0 },
      { type: "temporal", passed: 0, total: 2, skipped: 0 },
    ]);
    expect(report.passed).toBe(2);
    expect(report.total).toBe(4);
    expect(report.diagnosis).toHaveLength(1);
    expect(report.diagnosis[0]).toContain("Version chains");
  });

  it("keeps a skipped case out of the score entirely", () => {
    // Counted as a failure it would blame the code for an environment problem;
    // counted as a pass it would report a clean run over nothing.
    const report = summarise([
      outcome("stated-fact", true),
      outcome("profile", false, "no capture was recorded"),
    ]);

    expect(report).toMatchObject({ passed: 1, total: 1, skipped: 1 });
    expect(report.byType.find((group) => group.type === "profile"))
      .toEqual({ type: "profile", passed: 0, total: 0, skipped: 1 });
    // A type nothing was scored for cannot be diagnosed.
    expect(report.diagnosis).toEqual([]);
  });

  it("reports nothing rather than a perfect score for an empty run", () => {
    expect(summarise([])).toMatchObject({ passed: 0, total: 0, skipped: 0, byType: [] });
  });
});

describe("formatReport", () => {
  it("names skipped cases instead of folding them away", () => {
    const text = formatReport(summarise([
      outcome("stated-fact", true),
      outcome("temporal", false),
      outcome("absence", false, "the judge was unavailable"),
    ]));

    const squashed = text.split("\n").map((line) => line.trim().replace(/\s+/g, " "));
    expect(squashed).toContain("stated-fact 1/1");
    expect(squashed).toContain("temporal 0/1");
    expect(squashed).toContain("overall 1/2");
    expect(text).toContain("1 case(s) could not be run");
    expect(text).toContain("Version chains");
    // Fixed width, so two runs line up when read side by side.
    const scores = text.split("\n").filter((line) => /\d+\/\d+/.test(line));
    expect(new Set(scores.map((line) => line.indexOf("/")))).toHaveLength(1);
  });
});

describe("MEMORY_QUALITY_SUITE", () => {
  it("covers every mechanism a failure could be blamed on", () => {
    const covered = new Set(MEMORY_QUALITY_SUITE.map((entry) => entry.type));
    expect([...covered].sort())
      .toEqual(["absence", "profile", "session-arc", "stated-fact", "temporal"]);
  });

  it("asks every question in a conversation of its own", () => {
    // A question asked inside the conversation that stated the fact is answered
    // from the transcript, not from memory, and would score a broken store as
    // working.
    for (const entry of MEMORY_QUALITY_SUITE) {
      expect(entry.setup.length).toBeGreaterThan(0);
      expect(entry.question).not.toBe("");
      expect(entry.criterion.length).toBeGreaterThan(20);
    }
    expect(new Set(MEMORY_QUALITY_SUITE.map((entry) => entry.id)).size)
      .toBe(MEMORY_QUALITY_SUITE.length);
  });
});
