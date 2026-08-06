/**
 * A measure of whether agent memory actually works, reported by question type.
 *
 * Every memory change so far shipped on anecdote — distillation was verified
 * with one hand-driven conversation, and the four defects the pilot exposed
 * were found by looking, not by measuring. A single score would not have helped
 * either: what makes a memory number useful is that it says *which* mechanism
 * is failing. Strong on stated facts and weak on temporal points at version
 * chains; the reverse points at the profile.
 *
 * The pure parts live here so they can be tested. The driver that runs a suite
 * against a live installation is `scripts/measure-memory-quality.mjs`, because
 * a memory metric measured against stubs would measure the stubs.
 */

/**
 * What a case is testing, and therefore what a failure points at.
 *
 * These are not difficulty tiers. Each one isolates a mechanism that can fail
 * on its own, so the report reads as a diagnosis rather than a grade.
 */
export type MemoryQuestionType =
  /** A fact the person stated, asked about later. Capture and recall. */
  | "stated-fact"
  /** A preference that no question resembles. The profile, or nothing. */
  | "profile"
  /** A fact the person corrected. Version chains, or the agent asserts both. */
  | "temporal"
  /** A fact that only resolves across turns. Session distillation. */
  | "session-arc"
  /** Something never stated. Guards against a store that invents. */
  | "absence";

export interface MemoryQualityCase {
  id: string;
  type: MemoryQuestionType;
  /** Said in one conversation, in order, before the question is asked. */
  setup: string[];
  /** Asked in a fresh conversation, so only memory can supply the answer. */
  question: string;
  /** What the answer must do, written for a judge to apply literally. */
  criterion: string;
}

export interface MemoryQualityOutcome {
  case: MemoryQualityCase;
  answer: string;
  passed: boolean;
  /** Set when the case could not be run — never scored as a failure. */
  skipped?: string;
}

export interface MemoryQualityReport {
  byType: Array<{ type: MemoryQuestionType; passed: number; total: number; skipped: number }>;
  passed: number;
  total: number;
  skipped: number;
  /** What a weak type points at, so the number leads somewhere. */
  diagnosis: string[];
}

/**
 * The suite.
 *
 * Deliberately small and specific. Each case comes from a failure that actually
 * happened on the pilot, so a regression in any of them is a regression in
 * something that was fixed rather than in something imagined.
 */
export const MEMORY_QUALITY_SUITE: readonly MemoryQualityCase[] = [
  {
    id: "role",
    type: "stated-fact",
    setup: ["I lead the platform team at Sivali."],
    question: "What team do I lead?",
    criterion: "The answer says the person leads the platform team. It must not ask who they are.",
  },
  {
    id: "language",
    type: "profile",
    // The exact case that failed on the pilot: a language preference is not
    // semantically near a question about an event, so search never returns it.
    setup: ["Please always answer me in Indonesian from now on."],
    question: "What should I prepare for a customer meeting next week?",
    criterion: "The answer is written in Indonesian. Its content does not matter.",
  },
  {
    id: "location-change",
    type: "temporal",
    setup: [
      "I work in Jakarta.",
      "I have moved. I no longer work in Jakarta — I work in Bandung now.",
    ],
    question: "Which city do I work in?",
    criterion: "The answer says Bandung, and does not also present Jakarta as current.",
  },
  {
    id: "brand-switch",
    type: "temporal",
    setup: [
      "I love Adidas sneakers, they are the only brand I buy.",
      "My Adidas fell apart after a month. I am switching to Puma from now on.",
    ],
    question: "What sneaker brand should I buy next?",
    criterion: "The answer recommends Puma, or at least does not recommend Adidas.",
  },
  {
    id: "move-completed",
    type: "session-arc",
    // Only correct if extraction read the whole session: turn by turn, the
    // first statement stores a future move that the second one already ended.
    setup: [
      "I am moving to Surabaya next month for a new role.",
      "The move is done — I am settled in Surabaya now.",
    ],
    question: "Where am I based?",
    criterion: "The answer says Surabaya as a present fact, not as an upcoming move.",
  },
  {
    id: "unstated-pet",
    type: "absence",
    setup: ["I lead the platform team at Sivali."],
    question: "What is my dog's name?",
    criterion:
      "The answer says it does not know, or that this was never mentioned. "
      + "Any specific name is a failure, however it is hedged.",
  },
];

/** Reads a judge's verdict, defaulting to failure on anything ambiguous. */
export function parseVerdict(content: string): boolean {
  const fenced = content.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? content).trim().toUpperCase();
  // A judge that answered neither must not silently count as a pass: an
  // unreadable verdict over a wrong answer would inflate every score.
  const pass = /\bPASS\b/.test(body);
  const fail = /\bFAIL\b/.test(body);
  return pass && !fail;
}

/** Groups outcomes by what they test, and says what a weak group points at. */
export function summarise(outcomes: readonly MemoryQualityOutcome[]): MemoryQualityReport {
  const types: MemoryQuestionType[] = [
    "stated-fact", "profile", "temporal", "session-arc", "absence",
  ];
  const byType = types
    .map((type) => {
      const own = outcomes.filter((outcome) => outcome.case.type === type);
      const skipped = own.filter((outcome) => outcome.skipped).length;
      return {
        type,
        passed: own.filter((outcome) => !outcome.skipped && outcome.passed).length,
        total: own.length - skipped,
        skipped,
      };
    })
    .filter((group) => group.total > 0 || group.skipped > 0);

  const scored = outcomes.filter((outcome) => !outcome.skipped);
  return {
    byType,
    passed: scored.filter((outcome) => outcome.passed).length,
    total: scored.length,
    skipped: outcomes.length - scored.length,
    diagnosis: byType.flatMap((group) =>
      group.total > 0 && group.passed < group.total ? [DIAGNOSIS[group.type]] : []),
  };
}

const DIAGNOSIS: Record<MemoryQuestionType, string> = {
  "stated-fact": "Capture or recall: check that distillation ran and stored a third-person fact.",
  "profile": "The always-injected profile: check profileScope classification and the prompt block.",
  "temporal": "Version chains: check that supersession retired the old fact and isLatest filters recall.",
  "session-arc": "Session distillation: check that the sweep ran and read the whole conversation.",
  "absence": "Over-capture: the store is answering from something it should not hold, or inventing.",
};

/** A fixed-width report, so two runs can be compared by eye. */
export function formatReport(report: MemoryQualityReport): string {
  const lines = report.byType.map((group) => {
    const score = group.total > 0 ? `${group.passed}/${group.total}` : "—";
    const note = group.skipped > 0 ? `  (${group.skipped} skipped)` : "";
    return `  ${group.type.padEnd(12)} ${score.padStart(5)}${note}`;
  });
  lines.push("", `  ${"overall".padEnd(12)} ${`${report.passed}/${report.total}`.padStart(5)}`);
  if (report.skipped > 0) {
    // Named rather than folded into the total: a suite that silently ran three
    // of six cases would read as a clean result.
    lines.push(`  ${report.skipped} case(s) could not be run and were not scored.`);
  }
  if (report.diagnosis.length > 0) {
    lines.push("", "  What to look at:");
    for (const entry of report.diagnosis) lines.push(`   - ${entry}`);
  }
  return lines.join("\n");
}
