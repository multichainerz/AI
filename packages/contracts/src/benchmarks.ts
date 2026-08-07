import { z } from "zod";

/**
 * Benchmarks: the checks an operator can run against this installation to find
 * out whether it still answers well.
 *
 * Distinct from the evaluation ledger in `ai-ops.ts`, and deliberately so. That
 * one is a *record* — an operator types in how many cases passed somewhere
 * else, and promotion gates a release on it. This one *executes*: it drives the
 * live stack, scores what comes back, and produces those numbers. A completed
 * run is therefore the natural evidence for an evaluation, which is why
 * `evaluationRunId` is on the run rather than the two systems being merged.
 *
 * Nothing here judges with a model. Every check is deterministic and its
 * reasoning is inspectable, because a benchmark whose scoring you cannot audit
 * cannot be used to argue a release is safe.
 */

const slugSchema = z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * What a suite exercises.
 *
 * The three planes fail independently and for different reasons, so a single
 * "is the AI good" number would hide which one broke. Retrieval degrades when
 * an embedding model or a relevance floor changes; chat degrades when a prompt,
 * profile or model route changes; memory degrades when distillation or
 * supersession misbehaves.
 */
export const BENCHMARK_KINDS = ["CHAT_QUALITY", "RETRIEVAL", "MEMORY"] as const;
export const benchmarkKindSchema = z.enum(BENCHMARK_KINDS);

/**
 * How a case is scored. Every assertion is a plain string operation.
 *
 * `MUST_INCLUDE` / `MUST_NOT_INCLUDE` are case-insensitive substring checks —
 * the second matters more than it looks, because "must not leak the other
 * tenant's project name" is exactly the kind of regression a pass-rate alone
 * would never surface.
 */
export const BENCHMARK_ASSERTION_KINDS = [
  "MUST_INCLUDE",
  "MUST_NOT_INCLUDE",
  "MUST_CITE_DOCUMENT",
  "MAX_LATENCY_MS",
] as const;
export const benchmarkAssertionKindSchema = z.enum(BENCHMARK_ASSERTION_KINDS);

export const benchmarkAssertionSchema = z.object({
  kind: benchmarkAssertionKindSchema,
  /** Substring, document file name, or a number rendered as text for MAX_LATENCY_MS. */
  value: z.string().trim().min(1).max(400),
});

export const benchmarkCaseSchema = z.object({
  id: slugSchema,
  prompt: z.string().trim().min(3).max(4_000),
  /**
   * Why this case exists. Carried through to the result so a failure explains
   * itself without someone having to reconstruct the author's intent.
   */
  intent: z.string().trim().min(3).max(400),
  assertions: z.array(benchmarkAssertionSchema).min(1).max(20),
});

export const benchmarkSuiteSchema = z.object({
  id: z.uuid(),
  slug: slugSchema,
  displayName: z.string().trim().min(2).max(160),
  description: z.string().trim().min(3).max(1_000),
  kind: benchmarkKindSchema,
  cases: z.array(benchmarkCaseSchema).min(1).max(200),
  /** Below this, a run is a regression rather than a pass. */
  passThreshold: z.number().min(0).max(1),
  revision: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createBenchmarkSuiteSchema = benchmarkSuiteSchema
  .pick({ slug: true, displayName: true, description: true, kind: true, cases: true, passThreshold: true });

export const updateBenchmarkSuiteSchema = createBenchmarkSuiteSchema
  .omit({ slug: true, kind: true })
  .partial()
  .extend({ expectedRevision: z.number().int().positive() });

export const BENCHMARK_RUN_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;
export const benchmarkRunStatusSchema = z.enum(BENCHMARK_RUN_STATUSES);

/**
 * What the run was pointed at, captured at start.
 *
 * A benchmark result is meaningless without it: the same suite scoring 0.94 and
 * then 0.71 says nothing until you know the model alias changed underneath. The
 * fields are denormalised on purpose so a historical run keeps reading true
 * after the profile it used is edited or deleted.
 */
export const benchmarkTargetSchema = z.object({
  agentProfileId: z.uuid().nullable(),
  agentProfileSlug: z.string().max(64).nullable(),
  agentProfileVersion: z.number().int().positive().nullable(),
  modelAlias: z.string().max(120).nullable(),
});

export const benchmarkCaseResultSchema = z.object({
  caseId: slugSchema,
  intent: z.string().max(400),
  passed: z.boolean(),
  /** Which assertions held, in the order they were declared. */
  assertions: z.array(z.object({
    kind: benchmarkAssertionKindSchema,
    value: z.string().max(400),
    passed: z.boolean(),
  })),
  latencyMs: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  /**
   * A bounded excerpt, never the whole answer. Enough to see why a case failed
   * without turning the results table into a second transcript store.
   */
  outputExcerpt: z.string().max(2_000).nullable(),
  failureReason: z.string().max(1_000).nullable(),
});

export const benchmarkRunSchema = z.object({
  id: z.uuid(),
  suiteId: z.uuid(),
  suiteSlug: slugSchema,
  suiteRevision: z.number().int().positive(),
  kind: benchmarkKindSchema,
  status: benchmarkRunStatusSchema,
  target: benchmarkTargetSchema,
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1).nullable(),
  /** Median rather than mean: one cold start should not redefine "typical". */
  medianLatencyMs: z.number().int().nonnegative().nullable(),
  results: z.array(benchmarkCaseResultSchema),
  failureMessage: z.string().max(1_000).nullable(),
  /** Set when this run has been attached to an evaluation as its evidence. */
  evaluationRunId: z.uuid().nullable(),
  requestedBy: z.uuid().nullable(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
}).superRefine((run, context) => {
  if (run.passedCases > run.totalCases) {
    context.addIssue({ code: "custom", path: ["passedCases"], message: "A run cannot pass more cases than it ran." });
  }
  if (run.status === "COMPLETED" && run.completedAt === null) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "A completed run requires a completion time." });
  }
  // A pass rate before the run finishes would be read as a final score.
  if (run.passRate !== null && (run.status === "QUEUED" || run.status === "RUNNING")) {
    context.addIssue({ code: "custom", path: ["passRate"], message: "A run in flight has no pass rate yet." });
  }
});

export const startBenchmarkRunSchema = z.object({
  suiteId: z.uuid(),
  /** Optional: defaults to the active profile for the suite's kind. */
  agentProfileId: z.uuid().nullable().optional(),
});

export const benchmarkSuiteListSchema = z.object({ items: z.array(benchmarkSuiteSchema) });
export const benchmarkRunListSchema = z.object({ items: z.array(benchmarkRunSchema) });

export type BenchmarkKind = z.infer<typeof benchmarkKindSchema>;
export type BenchmarkAssertion = z.infer<typeof benchmarkAssertionSchema>;
export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;
export type BenchmarkSuite = z.infer<typeof benchmarkSuiteSchema>;
export type CreateBenchmarkSuite = z.infer<typeof createBenchmarkSuiteSchema>;
export type UpdateBenchmarkSuite = z.infer<typeof updateBenchmarkSuiteSchema>;
export type BenchmarkRunStatus = z.infer<typeof benchmarkRunStatusSchema>;
export type BenchmarkTarget = z.infer<typeof benchmarkTargetSchema>;
export type BenchmarkCaseResult = z.infer<typeof benchmarkCaseResultSchema>;
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>;
export type StartBenchmarkRun = z.infer<typeof startBenchmarkRunSchema>;
export type BenchmarkSuiteList = z.infer<typeof benchmarkSuiteListSchema>;
export type BenchmarkRunList = z.infer<typeof benchmarkRunListSchema>;
