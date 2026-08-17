import type {
  UsageBreakdown,
  UsageBreakdownRow,
  UsageBucket,
  UsageBucketGranularity,
  UsageGateway,
  UsageReport,
  UsageTools,
  UsageTotals,
  UsageWindow,
} from "@orcasynapse/contracts";
import { sql, type SQL } from "drizzle-orm";
import type { OrcaSynapseDatabase } from "@orcasynapse/database";
import type { UsageManager, UsageReportOptions } from "./usage-manager.js";

/**
 * How far back each window reaches, and how wide one point on its trend is.
 *
 * 24h and 7d bucket hourly because an hour is the unit an operator reasons in
 * when something changed this morning; 7d is 168 points, which a bar chart
 * still renders legibly. 30d goes daily rather than producing 720.
 */
const WINDOWS: Readonly<Record<UsageWindow, { ms: number; bucket: UsageBucketGranularity }>> = {
  "24h": { ms: 24 * 60 * 60 * 1_000, bucket: "hour" },
  "7d": { ms: 7 * 24 * 60 * 60 * 1_000, bucket: "hour" },
  "30d": { ms: 30 * 24 * 60 * 60 * 1_000, bucket: "day" },
};

/** How many rows a breakdown draws before the rest is folded into one. */
const BREAKDOWN_LIMIT = 20;

function integer(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

/**
 * A money figure, or nothing at all.
 *
 * Zero is returned only when the database actually summed something to zero.
 * `SUM` over no rows is null in PostgreSQL, and that null is the fact the whole
 * cost column depends on: it means the routes in this window reported no price,
 * not that they were free.
 */
function nullableCost(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/*
 * Type aliases rather than interfaces, and not a style choice: drizzle's
 * `execute<T>` constrains T to `Record<string, unknown>`, and an interface has
 * no implicit index signature to satisfy that. An object type alias does.
 */
type AggregateRow = {
  runs: unknown;
  failed: unknown;
  inputTokens: unknown;
  outputTokens: unknown;
  totalTokens: unknown;
  costUsd: unknown;
  averageLatencyMs: unknown;
};

type BreakdownQueryRow = AggregateRow & {
  kind: unknown;
  key: unknown;
  label: unknown;
};

/**
 * The columns every aggregate in this file selects, written once.
 *
 * Counts are cast to `int` and token sums left as the `bigint` PostgreSQL
 * returns for `SUM(integer)`: thirty days of traffic can exceed a signed 32-bit
 * total, and `Number()` on the returned string is exact well past that.
 */
const AGGREGATE_COLUMNS = sql`
  count(*)::int AS "runs",
  count(*) FILTER (WHERE r."status" IN ('FAILED', 'TIMED_OUT', 'DENIED'))::int AS "failed",
  coalesce(sum(r."inputTokens"), 0) AS "inputTokens",
  coalesce(sum(r."outputTokens"), 0) AS "outputTokens",
  coalesce(sum(r."totalTokens"), 0) AS "totalTokens",
  sum(c."costUsd")::double precision AS "costUsd",
  avg(extract(epoch FROM (r."completedAt" - r."startedAt")) * 1000)::double precision AS "averageLatencyMs"
`;

/**
 * The windowed run set, joined to everything a breakdown needs.
 *
 * `completedAt` is the anchor because tokens and cost exist only once a run is
 * terminal; a queued run has nothing to sum. That predicate is what
 * `AgentRun_completedAt_idx` exists for -- before it, every other index on the
 * table led with a non-temporal column and this was a sequential scan of the
 * installation's entire run history on every load.
 *
 * Measured on PostgreSQL 17.11 with 200,000 terminal runs spread over ~139
 * days, taking the 30d window (~43,000 rows): 61.05ms and 5,715 buffers on a
 * parallel sequential scan, against 25.16ms and 1,450 buffers on an index scan.
 * The ratio is the smaller half of the point. Without the index the plan reads
 * the whole table, so its cost tracks the installation's lifetime history;
 * with it, the cost tracks the window the operator asked for and stops growing.
 *
 * Cost comes through a lateral rather than a join to a grouped subquery so the
 * event table is entered once per windowed run, through
 * `AgentRunEvent_runId_cursor_idx`, instead of being aggregated whole and then
 * filtered.
 */
function windowedRuns(since: Date): SQL {
  return sql`
    "AgentRun" r
    JOIN "AgentProfile" p ON p."id" = r."profileId"
    LEFT JOIN "Division" d ON d."id" = p."divisionId"
    LEFT JOIN LATERAL (
      SELECT sum(e."costUsd") AS "costUsd"
      FROM "AgentRunEvent" e
      WHERE e."runId" = r."id" AND e."costUsd" IS NOT NULL
    ) c ON TRUE
    WHERE r."completedAt" >= ${since}
  `;
}

function breakdownRow(row: BreakdownQueryRow, fallbackLabel: string): UsageBreakdownRow {
  return {
    key: typeof row.key === "string" && row.key.length > 0 ? row.key : null,
    label: typeof row.label === "string" && row.label.length > 0 ? row.label : fallbackLabel,
    runs: integer(row.runs),
    failed: integer(row.failed),
    inputTokens: integer(row.inputTokens),
    outputTokens: integer(row.outputTokens),
    totalTokens: integer(row.totalTokens),
    costUsd: nullableCost(row.costUsd),
    averageLatencyMs: nullableInteger(row.averageLatencyMs),
  };
}

/**
 * Usage aggregated live, from rows that already exist.
 *
 * There is no rollup table and no worker sweep, which is a decision with a
 * stated limit rather than an oversight. Every figure here comes from one
 * windowed pass over `AgentRun` (index-backed since v8.9.0), one lateral into
 * `AgentRunEvent` per run, and two small windowed counts over `AuditEvent` and
 * `GovernedToolCall`.
 *
 * `AuditEvent` is the highest-volume table in the schema -- every governed path
 * writes to it and nothing prunes it -- so the 30d gateway count is a range
 * scan over the largest thing here. It is served by
 * `AuditEvent_occurredAt_idx`, which leads with the column being ranged on, so
 * the scan is bounded by the window rather than by the table. If a real
 * deployment measures that as too slow, a rollup is the answer and the
 * measurement is what should justify it -- the same way `divisionMemory()` in
 * the worker records 12.32ms -> 0.39ms for its own index fix rather than
 * asserting that one was needed.
 */
export class DrizzleUsageManager implements UsageManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async report(options: UsageReportOptions): Promise<UsageReport> {
    const generatedAt = new Date();
    const { ms, bucket } = WINDOWS[options.window];
    const since = new Date(generatedAt.getTime() - ms);

    const [totals, series, byModel, byProfile, byDivision, byUser, gateway, tools] = await Promise.all([
      this.totals(since),
      this.series(since, bucket),
      this.breakdown(since, sql`r."modelAlias"`, sql`r."modelAlias"`, "Not reported"),
      this.breakdown(since, sql`p."id"::text`, sql`p."slug"`, "Unknown agent"),
      /*
       * A null division is a real bucket: a run against a deployment-wide
       * profile belongs to no division, and reading that as "no filter" is the
       * mistake `ScopedMemoryEntry` and `divisionMemory()` both warn about. The
       * key stays null and the label says what null means.
       */
      this.breakdown(since, sql`d."id"::text`, sql`coalesce(d."displayName", 'Deployment-wide')`, "Deployment-wide"),
      options.includeUsers
        ? this.breakdown(since, sql`r."ownerSubject"`, sql`r."ownerSubject"`, "Unknown")
        : Promise.resolve(null),
      this.gateway(since),
      this.tools(since),
    ]);

    return {
      window: options.window,
      windowStartedAt: since.toISOString(),
      generatedAt: generatedAt.toISOString(),
      bucket,
      totals,
      series,
      byModel,
      byProfile,
      byDivision,
      byUser,
      gateway,
      tools,
    };
  }

  private async totals(since: Date): Promise<UsageTotals> {
    const [row] = await this.database.execute<AggregateRow & {
      completed: unknown;
      cancelled: unknown;
      denied: unknown;
      timedOut: unknown;
      reasoningTokens: unknown;
      tokensReported: unknown;
      tokensUnreported: unknown;
      costReportedRuns: unknown;
      costUnreportedRuns: unknown;
      p95LatencyMs: unknown;
      averageFirstTokenMs: unknown;
    }>(sql`
      SELECT
        ${AGGREGATE_COLUMNS},
        count(*) FILTER (WHERE r."status" = 'COMPLETED')::int AS "completed",
        count(*) FILTER (WHERE r."status" = 'CANCELLED')::int AS "cancelled",
        count(*) FILTER (WHERE r."status" = 'DENIED')::int AS "denied",
        count(*) FILTER (WHERE r."status" = 'TIMED_OUT')::int AS "timedOut",
        coalesce(sum(r."reasoningTokens"), 0) AS "reasoningTokens",
        count(*) FILTER (WHERE r."totalTokens" IS NOT NULL)::int AS "tokensReported",
        count(*) FILTER (WHERE r."totalTokens" IS NULL)::int AS "tokensUnreported",
        count(*) FILTER (WHERE c."costUsd" IS NOT NULL)::int AS "costReportedRuns",
        count(*) FILTER (WHERE c."costUsd" IS NULL)::int AS "costUnreportedRuns",
        (percentile_cont(0.95) WITHIN GROUP (
          ORDER BY extract(epoch FROM (r."completedAt" - r."startedAt")) * 1000
        ))::double precision AS "p95LatencyMs",
        avg(extract(epoch FROM (r."firstTokenAt" - r."startedAt")) * 1000)::double precision AS "averageFirstTokenMs"
      FROM ${windowedRuns(since)}
    `).then((result) => result.rows);

    const runs = integer(row?.runs);
    const failed = integer(row?.failed);
    return {
      runs,
      completed: integer(row?.completed),
      failed,
      cancelled: integer(row?.cancelled),
      denied: integer(row?.denied),
      timedOut: integer(row?.timedOut),
      inputTokens: integer(row?.inputTokens),
      outputTokens: integer(row?.outputTokens),
      reasoningTokens: integer(row?.reasoningTokens),
      totalTokens: integer(row?.totalTokens),
      tokensReported: integer(row?.tokensReported),
      tokensUnreported: integer(row?.tokensUnreported),
      costUsd: nullableCost(row?.costUsd),
      costReportedRuns: integer(row?.costReportedRuns),
      costUnreportedRuns: integer(row?.costUnreportedRuns),
      averageLatencyMs: nullableInteger(row?.averageLatencyMs),
      p95LatencyMs: nullableInteger(row?.p95LatencyMs),
      averageFirstTokenMs: nullableInteger(row?.averageFirstTokenMs),
      /*
       * Cancelled is deliberately not a failure. Somebody pressed stop; the
       * deployment did what it was told, and counting it against the route
       * would make an attentive operator look like a broken gateway.
       */
      failureRate: runs === 0 ? 0 : failed / runs,
    };
  }

  private async series(since: Date, bucket: UsageBucketGranularity): Promise<UsageBucket[]> {
    /*
     * Bucketed in UTC, deliberately. These timestamps are `withTimezone`, and
     * interpolating a caller's timezone would make the same window return
     * different buckets to two operators looking at one deployment. The browser
     * renders each boundary local.
     */
    const truncation = bucket === "hour" ? sql`'hour'` : sql`'day'`;
    /*
     * Converted back to `timestamptz` by the trailing `AT TIME ZONE 'UTC'`,
     * and that second conversion is the load-bearing half. `date_trunc(...,
     * ts AT TIME ZONE 'UTC')` yields a bare `timestamp`, which node-postgres
     * parses as *local* time -- so on any host not set to UTC every bucket
     * boundary came back shifted by the offset, silently and only in the chart.
     */
    const rows = await this.database.execute<AggregateRow & { at: unknown }>(sql`
      SELECT
        date_trunc(${truncation}, r."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "at",
        ${AGGREGATE_COLUMNS}
      FROM ${windowedRuns(since)}
      GROUP BY 1
      ORDER BY 1 ASC
    `).then((result) => result.rows);

    return rows.map((row) => ({
      at: (row.at instanceof Date ? row.at : new Date(String(row.at))).toISOString(),
      runs: integer(row.runs),
      failed: integer(row.failed),
      inputTokens: integer(row.inputTokens),
      outputTokens: integer(row.outputTokens),
      totalTokens: integer(row.totalTokens),
      costUsd: nullableCost(row.costUsd),
    }));
  }

  /**
   * One breakdown, and an exact statement of what it left out.
   *
   * The tail is summed in SQL rather than fetched and folded here, so a
   * deployment with ten thousand distinct users returns twenty-one rows instead
   * of ten thousand. The `other` row comes back even when the tail is empty --
   * an aggregate with no `GROUP BY` always produces one row -- and is detected
   * by its null count rather than by its absence.
   */
  private async breakdown(
    since: Date,
    key: SQL,
    label: SQL,
    fallbackLabel: string,
  ): Promise<UsageBreakdown> {
    const rows = await this.database.execute<BreakdownQueryRow>(sql`
      WITH grouped AS (
        SELECT ${key} AS "key", ${label} AS "label", ${AGGREGATE_COLUMNS}
        FROM ${windowedRuns(since)}
        GROUP BY 1, 2
      ), ranked AS (
        SELECT g.*, row_number() OVER (ORDER BY g."totalTokens" DESC, g."runs" DESC, g."label" ASC) AS "rank"
        FROM grouped g
      )
      SELECT 'row' AS "kind", "key", "label", "runs", "failed", "inputTokens", "outputTokens",
             "totalTokens", "costUsd", "averageLatencyMs"
      FROM ranked WHERE "rank" <= ${BREAKDOWN_LIMIT}
      UNION ALL
      /*
       * A cast NULL rather than a bare one. The keys these branches union are a
       * varchar on one breakdown and a text cast on another, and an untyped
       * NULL leaves PostgreSQL resolving the column type from whichever branch
       * it reaches first -- a resolution that works until the top branch
       * returns no rows.
       */
      SELECT 'other', NULL::text, 'Everything else', sum("runs")::int, sum("failed")::int,
             sum("inputTokens"), sum("outputTokens"), sum("totalTokens"),
             sum("costUsd")::double precision,
             /*
              * Weighted by the runs each group carried, so the remainder's
              * latency is the tail's actual average rather than the average of
              * its groups' averages -- which would let one idle group with a
              * single slow run outweigh a busy one.
              */
             (sum("averageLatencyMs" * "runs") / nullif(sum("runs") FILTER (WHERE "averageLatencyMs" IS NOT NULL), 0))::double precision
      FROM ranked WHERE "rank" > ${BREAKDOWN_LIMIT}
      /*
       * The same three keys the window function ordered on, not just the first.
       * Ordering this union by token count alone would drop the tie-break that
       * decided which twenty rows were kept, so two groups on equal tokens
       * could be selected in one order and drawn in another. Sorting kind
       * descending puts row ahead of other, because the remainder belongs at
       * the foot of the table.
       */
      ORDER BY "kind" DESC, "totalTokens" DESC, "runs" DESC, "label" ASC
    `).then((result) => result.rows);

    const listed = rows.filter((row) => row.kind === "row").map((row) => breakdownRow(row, fallbackLabel));
    const tail = rows.find((row) => row.kind === "other");
    const truncated = tail !== undefined && tail.runs !== null && integer(tail.runs) > 0;
    return {
      rows: listed,
      truncated,
      other: truncated && tail ? breakdownRow(tail, "Everything else") : null,
    };
  }

  private async gateway(since: Date): Promise<UsageGateway> {
    /*
     * `rejected` only counts from the release that started recording refusals.
     * Before it a blocked request left no trace anywhere: POLICY_REJECTED threw
     * before the audit write, and RATE_LIMITED threw inside the transaction
     * that would have carried it. A window reaching back past that release
     * therefore under-reports refusals rather than misreporting them.
     */
    const [row] = await this.database.execute<{
      requests: unknown; rejected: unknown; policy: unknown; rateLimit: unknown;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE "action" = 'inference.gateway_requested')::int AS "requests",
        count(*) FILTER (WHERE "action" = 'inference.gateway_rejected')::int AS "rejected",
        count(*) FILTER (WHERE "action" = 'inference.gateway_rejected'
          AND "metadata" ->> 'reason' = 'POLICY')::int AS "policy",
        count(*) FILTER (WHERE "action" = 'inference.gateway_rejected'
          AND "metadata" ->> 'reason' = 'RATE_LIMIT')::int AS "rateLimit"
      FROM "AuditEvent"
      WHERE "occurredAt" >= ${since}
        AND "action" IN ('inference.gateway_requested', 'inference.gateway_rejected')
    `).then((result) => result.rows);

    return {
      requests: integer(row?.requests),
      rejected: integer(row?.rejected),
      rejectedByPolicy: integer(row?.policy),
      rejectedByRateLimit: integer(row?.rateLimit),
    };
  }

  private async tools(since: Date): Promise<UsageTools> {
    const [row] = await this.database.execute<{
      calls: unknown; completed: unknown; denied: unknown; failed: unknown;
    }>(sql`
      SELECT
        count(*)::int AS "calls",
        count(*) FILTER (WHERE "status" = 'COMPLETED')::int AS "completed",
        count(*) FILTER (WHERE "status" = 'DENIED')::int AS "denied",
        count(*) FILTER (WHERE "status" = 'FAILED')::int AS "failed"
      FROM "GovernedToolCall"
      WHERE "requestedAt" >= ${since}
    `).then((result) => result.rows);

    return {
      calls: integer(row?.calls),
      completed: integer(row?.completed),
      denied: integer(row?.denied),
      failed: integer(row?.failed),
    };
  }
}
