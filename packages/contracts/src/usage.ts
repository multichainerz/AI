import { z } from "zod";

/**
 * What the governed inference path actually consumed, over a bounded window.
 *
 * Distinct from the three metrics contracts that already exist, and this file
 * exists because none of them could answer the question. `ChatMetrics` is one
 * hard-coded 24h window with a single `totalTokens` scalar; `AgentMetrics`
 * counts runs by status and carries no tokens at all; `ToolMetrics` counts
 * calls. None of them break anything down, none show a trend, and none show
 * cost.
 *
 * Aggregated live from rows that already exist -- `AgentRun` for the run
 * itself, `AgentRunEvent` for cost, `AuditEvent` for gateway traffic -- rather
 * than from a rollup table. See `DrizzleUsageManager` for the scaling limit
 * that choice carries and the measurement that would change it.
 */

export const USAGE_WINDOWS = ["24h", "7d", "30d"] as const;
export const usageWindowSchema = z.enum(USAGE_WINDOWS);

/**
 * How wide one point on the trend is.
 *
 * Derived from the window rather than chosen: 24h and 7d bucket hourly (24 and
 * 168 points), 30d daily (30). It is reported rather than assumed so a reader
 * rendering the series knows what a point spans without re-deriving the rule.
 */
export const usageBucketGranularitySchema = z.enum(["hour", "day"]);

/**
 * A token or cost figure the runtime did not report, kept apart from a
 * measured zero.
 *
 * `reportedUsage()` in the Hermes client deliberately writes null when a
 * provider returns no usage -- llama.cpp behind an OpenAI-compatible gateway
 * among them -- because recording those as measured zeroes tells an operator
 * the run was free. Summing nulls into a total would undo that at the last
 * step, so every total carries the count of runs that contributed to it beside
 * the count that could not.
 */
const nonNegativeInteger = z.number().int().nonnegative();

export const usageTotalsSchema = z.object({
  runs: nonNegativeInteger,
  completed: nonNegativeInteger,
  failed: nonNegativeInteger,
  cancelled: nonNegativeInteger,
  denied: nonNegativeInteger,
  timedOut: nonNegativeInteger,

  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  reasoningTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
  /** Runs whose token counts the runtime actually measured. */
  tokensReported: nonNegativeInteger,
  /** Runs that consumed tokens nobody counted. The figures above exclude them. */
  tokensUnreported: nonNegativeInteger,

  /**
   * Null, not zero, when no run in the window priced itself.
   *
   * There is no price book in this product: cost is whatever the upstream
   * returned as `cost_usd`, which OpenRouter sends and an on-premises vLLM or
   * llama.cpp route does not. A zero here would be a claim that the window was
   * free rather than an admission that nothing said.
   */
  costUsd: z.number().nonnegative().nullable(),
  costReportedRuns: nonNegativeInteger,
  costUnreportedRuns: nonNegativeInteger,

  averageLatencyMs: nonNegativeInteger.nullable(),
  p95LatencyMs: nonNegativeInteger.nullable(),
  /** Queue-to-first-token, which is what a person actually waits for. */
  averageFirstTokenMs: nonNegativeInteger.nullable(),

  failureRate: z.number().min(0).max(1),
});

export const usageBucketSchema = z.object({
  /** The bucket's start, in UTC. The browser renders it local. */
  at: z.iso.datetime(),
  runs: nonNegativeInteger,
  failed: nonNegativeInteger,
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
  costUsd: z.number().nonnegative().nullable(),
});

export const usageBreakdownRowSchema = z.object({
  /**
   * Nullable because one row genuinely has no key: a run against a
   * deployment-wide agent profile belongs to no division, and that is a real
   * bucket rather than an absent one. `label` carries what to draw.
   */
  key: z.string().min(1).max(320).nullable(),
  label: z.string().min(1).max(320),
  runs: nonNegativeInteger,
  failed: nonNegativeInteger,
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
  costUsd: z.number().nonnegative().nullable(),
  averageLatencyMs: nonNegativeInteger.nullable(),
});

/**
 * A breakdown, and an honest statement of what it left out.
 *
 * Capped at twenty rows, because a route catalogue can be large -- OpenRouter
 * serves several hundred models -- and a table of every one of them is not a
 * breakdown. `truncated` and `other` are what keep that cap from reading as
 * "these are all of them": the remainder is summed into one row rather than
 * silently dropped, so the column totals still reconcile with the window's.
 */
export const usageBreakdownSchema = z.object({
  rows: z.array(usageBreakdownRowSchema).max(20),
  truncated: z.boolean(),
  other: usageBreakdownRowSchema.nullable(),
});

/**
 * The `/internal/v1` plane: VM2 calling back through the control plane for
 * inference.
 *
 * Counted separately from runs, and not derivable from them. A run is one
 * governed turn; a turn can make several gateway calls, and a call the
 * guardrails refused produced no run at all. `rejected` is only meaningful
 * from the release that began recording refusals -- before it, a blocked
 * request left no trace anywhere.
 */
export const usageGatewaySchema = z.object({
  requests: nonNegativeInteger,
  rejected: nonNegativeInteger,
  rejectedByPolicy: nonNegativeInteger,
  rejectedByRateLimit: nonNegativeInteger,
});

export const usageToolsSchema = z.object({
  calls: nonNegativeInteger,
  completed: nonNegativeInteger,
  denied: nonNegativeInteger,
  failed: nonNegativeInteger,
});

export const usageReportSchema = z.object({
  window: usageWindowSchema,
  windowStartedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  bucket: usageBucketGranularitySchema,
  totals: usageTotalsSchema,
  series: z.array(usageBucketSchema),
  byModel: usageBreakdownSchema,
  byProfile: usageBreakdownSchema,
  byDivision: usageBreakdownSchema,
  /**
   * Null when the caller may not see it, which is not the same as empty.
   *
   * The report is gated on `operations:read`, held by OPERATIONS_ADMIN among
   * others. Naming individuals and what they spent is closer to "who did what"
   * than to "is it healthy", so this one breakdown additionally requires
   * `audit:read` -- the scope the audit trail itself is behind. The same split
   * the corpus routes already make between metadata and content.
   */
  byUser: usageBreakdownSchema.nullable(),
  gateway: usageGatewaySchema,
  tools: usageToolsSchema,
});

export const usageQuerySchema = z.object({
  window: usageWindowSchema.default("24h"),
}).strict();

export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageBucketGranularity = z.infer<typeof usageBucketGranularitySchema>;
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type UsageBucket = z.infer<typeof usageBucketSchema>;
export type UsageBreakdownRow = z.infer<typeof usageBreakdownRowSchema>;
export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;
export type UsageGateway = z.infer<typeof usageGatewaySchema>;
export type UsageTools = z.infer<typeof usageToolsSchema>;
export type UsageReport = z.infer<typeof usageReportSchema>;
export type UsageQuery = z.infer<typeof usageQuerySchema>;
