import { describe, expect, it } from "vitest";
import {
  benchmarkRunSchema,
  benchmarkSuiteSchema,
  createBenchmarkSuiteSchema,
  updateBenchmarkSuiteSchema,
} from "./benchmarks.js";

const suite = {
  id: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b",
  slug: "chat-baseline",
  displayName: "Chat baseline",
  description: "The questions this installation must keep answering correctly.",
  kind: "CHAT_QUALITY" as const,
  cases: [{
    id: "cites-runbook",
    prompt: "What should we check before promoting the release?",
    intent: "A promotion question must cite the runbook rather than improvise.",
    assertions: [
      { kind: "MUST_INCLUDE" as const, value: "migrations" },
      { kind: "MUST_NOT_INCLUDE" as const, value: "I don't know" },
    ],
  }],
  passThreshold: 0.9,
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

const run = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  suiteId: suite.id,
  suiteSlug: suite.slug,
  suiteRevision: 1,
  kind: "CHAT_QUALITY" as const,
  status: "COMPLETED" as const,
  target: {
    agentProfileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    agentProfileSlug: "support-analyst",
    agentProfileVersion: 3,
    modelAlias: "qwen3.6-27b",
    ownerSubject: "local-admin:operator",
  },
  totalCases: 1,
  passedCases: 1,
  passRate: 1,
  medianLatencyMs: 4_120,
  results: [{
    caseId: "cites-runbook",
    intent: "A promotion question must cite the runbook rather than improvise.",
    passed: true,
    assertions: [{ kind: "MUST_INCLUDE" as const, value: "migrations", passed: true }],
    latencyMs: 4_120,
    outputTokens: 260,
    outputExcerpt: "Confirm migrations are applied…",
    failureReason: null,
  }],
  failureMessage: null,
  evaluationRunId: null,
  requestedBy: null,
  queuedAt: "2026-08-07T09:00:00.000Z",
  startedAt: "2026-08-07T09:00:01.000Z",
  completedAt: "2026-08-07T09:00:30.000Z",
};

describe("benchmark suite", () => {
  it("accepts a suite whose cases each assert something", () => {
    expect(benchmarkSuiteSchema.parse(suite).slug).toBe("chat-baseline");
  });

  it("refuses a case with no assertions, which would pass by doing nothing", () => {
    const empty = { ...suite, cases: [{ ...suite.cases[0]!, assertions: [] }] };
    expect(benchmarkSuiteSchema.safeParse(empty).success).toBe(false);
  });

  it("refuses a suite with no cases at all", () => {
    expect(benchmarkSuiteSchema.safeParse({ ...suite, cases: [] }).success).toBe(false);
  });

  it("refuses a latency bound that is not a number", () => {
    // It could never hold, so the case it guards would fail every run for a
    // reason no result explains.
    const bad = (value: string) => ({
      ...suite,
      cases: [{ ...suite.cases[0]!, assertions: [{ kind: "MAX_LATENCY_MS" as const, value }] }],
    });
    expect(benchmarkSuiteSchema.safeParse(bad("soon")).success).toBe(false);
    expect(benchmarkSuiteSchema.safeParse(bad("0")).success).toBe(false);
    expect(benchmarkSuiteSchema.safeParse(bad("2500")).success).toBe(true);
  });

  it("refuses two cases sharing one id, which would collapse into one result", () => {
    // The id names a row in the results table. Reused, one row stands for two
    // questions and a regression in the second is invisible.
    const duplicated = {
      ...suite,
      cases: [suite.cases[0]!, { ...suite.cases[0]!, prompt: "A different question entirely." }],
    };
    expect(benchmarkSuiteSchema.safeParse(duplicated).success).toBe(false);
    expect(createBenchmarkSuiteSchema.safeParse(duplicated).success).toBe(false);
    expect(updateBenchmarkSuiteSchema.safeParse({ expectedRevision: 1, cases: duplicated.cases }).success).toBe(false);
  });

  it("keeps slug and kind out of the update shape", () => {
    // Changing either would silently redefine what past runs measured, so they
    // are set once at creation and a new suite is the way to change them.
    const parsed = updateBenchmarkSuiteSchema.parse({ expectedRevision: 1, displayName: "Renamed" });
    expect("slug" in parsed).toBe(false);
    expect("kind" in parsed).toBe(false);
  });

  it("requires a revision on update so two operators cannot overwrite each other", () => {
    expect(updateBenchmarkSuiteSchema.safeParse({ displayName: "Renamed" }).success).toBe(false);
  });

  it("takes only the authored fields on create", () => {
    const parsed = createBenchmarkSuiteSchema.parse({ ...suite });
    expect("revision" in parsed).toBe(false);
    expect("id" in parsed).toBe(false);
  });
});

describe("benchmark run", () => {
  it("accepts a completed run", () => {
    expect(benchmarkRunSchema.parse(run).passRate).toBe(1);
  });

  it("refuses passing more cases than were run", () => {
    expect(benchmarkRunSchema.safeParse({ ...run, passedCases: 2 }).success).toBe(false);
  });

  it("refuses a pass rate on a run still in flight", () => {
    // A partial score rendered beside finished runs reads as a final one, and
    // an operator would compare it against the threshold.
    const running = { ...run, status: "RUNNING" as const, completedAt: null, passRate: 0.5 };
    expect(benchmarkRunSchema.safeParse(running).success).toBe(false);
  });

  it("refuses a completed run with no completion time", () => {
    expect(benchmarkRunSchema.safeParse({ ...run, completedAt: null }).success).toBe(false);
  });

  it("records what the run was pointed at, so two scores stay comparable", () => {
    // The same suite scoring 0.94 then 0.71 says nothing until you know the
    // model changed underneath.
    const parsed = benchmarkRunSchema.parse(run);
    expect(parsed.target.modelAlias).toBe("qwen3.6-27b");
    expect(parsed.target.agentProfileVersion).toBe(3);
  });

  it("allows a queued run that has measured nothing yet", () => {
    const queued = {
      ...run,
      status: "QUEUED" as const,
      totalCases: 0, passedCases: 0, passRate: null, medianLatencyMs: null,
      results: [], startedAt: null, completedAt: null,
    };
    expect(benchmarkRunSchema.safeParse(queued).success).toBe(true);
  });
});
