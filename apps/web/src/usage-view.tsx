import type {
  AdministratorSession,
  UsageBreakdown,
  UsageBreakdownRow,
  UsageBucket,
  UsageReport,
  UsageWindow,
} from "@orcasynapse/contracts";
import { Activity } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OrcaSynapseApiError, getGatewayUsage } from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, EmptyState, LockedScreen, Metric, MetricRow, MicroLabel,
  Panel, PanelHeading, Select, StatusText, Tile, WorkspaceDock, WorkspaceIntro,
} from "./ui/index.js";

interface UsageViewProps {
  session: AdministratorSession | null;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

const WINDOW_LABELS: Readonly<Record<UsageWindow, string>> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/**
 * The em dash this screen uses for "the runtime did not say".
 *
 * Not zero, anywhere, and this constant exists so that stays deliberate. The
 * whole token and cost column is built on `reportedUsage()` in the Hermes
 * client refusing to record an unmeasured run as a measured zero; rendering
 * null as `0` here would undo that at the last possible step and tell an
 * operator a window was free.
 */
const NOT_REPORTED = "—";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en");
const money = new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function tokens(value: number): string {
  return compact.format(value);
}

function cost(value: number | null): string {
  return value === null ? NOT_REPORTED : money.format(value);
}

function milliseconds(value: number | null): string {
  if (value === null) return NOT_REPORTED;
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${exact.format(value)} ms`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function bucketLabel(at: string, bucket: UsageReport["bucket"]): string {
  return new Intl.DateTimeFormat("en", bucket === "hour"
    ? { month: "short", day: "numeric", hour: "numeric" }
    : { month: "short", day: "numeric" }).format(new Date(at));
}

/**
 * The trend, drawn as SVG with every dimension in an attribute.
 *
 * No charting library and no inline `style`, because the container serves
 * `style-src 'self'` without `unsafe-inline` and `scripts/test-csp-closure.sh`
 * fails the build on `style={{`. Every library that draws this writes bar
 * geometry into a style attribute. Here `x`, `y`, `width` and `height` are SVG
 * presentation *attributes* -- which the CSP has no opinion about -- and colour
 * is a Tailwind class, exactly as the run-mix bar in `dashboard-hero.tsx`
 * already does it.
 *
 * `preserveAspectRatio="none"` lets one bar per bucket stretch to whatever
 * width the panel has, so the same markup renders 24 buckets and 168.
 */
function UsageTrend({ series, bucket }: { series: UsageBucket[]; bucket: UsageReport["bucket"] }) {
  const ceiling = Math.max(1, ...series.map((point) => point.totalTokens));
  const span = Math.max(1, series.length);
  const width = 0.78;

  return (
    <figure className="m-0 grid gap-2">
      <svg
        className="h-40 w-full"
        viewBox={`0 0 ${span} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Tokens per ${bucket} across ${series.length} ${bucket === "hour" ? "hours" : "days"}.`}
      >
        <rect x="0" y="99.6" width={span} height="0.4" className="fill-border" />
        {series.map((point, index) => {
          const total = point.totalTokens;
          const height = total === 0 ? 0 : Math.max(0.8, (total / ceiling) * 96);
          const input = total === 0 ? 0 : (point.inputTokens / total) * height;
          return (
            <g key={point.at}>
              {/* Input at the base, output above it, so the darker mass is the
                  prompt cost an operator can actually shorten. */}
              <rect
                x={index + (1 - width) / 2}
                y={100 - height}
                width={width}
                height={height - input}
                className="fill-accent"
              />
              <rect
                x={index + (1 - width) / 2}
                y={100 - input}
                width={width}
                height={input}
                className="fill-accent-strong"
              />
              {point.failed > 0 && (
                <rect
                  x={index + (1 - width) / 2}
                  y="96.5"
                  width={width}
                  height="3.5"
                  className="fill-bad"
                />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex items-center justify-between gap-4 text-caption text-muted">
        <span>{series.length > 0 ? bucketLabel(series[0]!.at, bucket) : ""}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2 bg-accent-strong" />Input</span>
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2 bg-accent" />Output</span>
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2 bg-bad" />Failures</span>
        </span>
        <span>{series.length > 0 ? bucketLabel(series[series.length - 1]!.at, bucket) : ""}</span>
      </figcaption>
    </figure>
  );
}

function BreakdownRows({ rows }: { rows: UsageBreakdownRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <TableRow key={row.key ?? row.label}>
          <TableCell className="max-w-0 truncate font-medium text-text">{row.label}</TableCell>
          <TableCell className="text-right tabular-nums">{exact.format(row.runs)}</TableCell>
          <TableCell className="text-right tabular-nums">{tokens(row.totalTokens)}</TableCell>
          <TableCell className="text-right tabular-nums">{cost(row.costUsd)}</TableCell>
          <TableCell className="text-right tabular-nums">{milliseconds(row.averageLatencyMs)}</TableCell>
        </TableRow>
      ))}
    </>
  );
}

/**
 * One breakdown table, and an honest footer when it is not the whole story.
 *
 * The `other` row is drawn rather than dropped so the column totals still
 * reconcile with the window's — a top-twenty table whose numbers do not add up
 * to the summary above it reads as a bug in the summary.
 */
function Breakdown({
  title,
  description,
  breakdown,
}: {
  title: string;
  description: string;
  breakdown: UsageBreakdown;
}) {
  return (
    <Panel className="grid min-w-0 gap-3">
      <PanelHeading title={title} description={description} className="mb-0" />
      {breakdown.rows.length === 0 ? (
        <EmptyState title="Nothing in this window">
          No run finished inside the selected window, so there is nothing to attribute yet.
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Avg latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <BreakdownRows rows={breakdown.rows} />
            {breakdown.other && <BreakdownRows rows={[breakdown.other]} />}
          </TableBody>
        </Table>
      )}
      {breakdown.truncated && (
        <StatusText>
          Showing the top {breakdown.rows.length}. Everything beyond them is summed into the final row rather than dropped.
        </StatusText>
      )}
    </Panel>
  );
}

export function UsageView({ session, onConfigure, onSessionExpired }: UsageViewProps) {
  const [window, setWindow] = useState<UsageWindow>("24h");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { unlocked } = adminAccess(session);

  useEffect(() => {
    if (!unlocked) return;
    let current = true;
    setLoading(true);
    void getGatewayUsage(window)
      .then((next) => {
        if (!current) return;
        setReport(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
        else setError(cause instanceof Error ? cause.message : "Unable to load gateway usage.");
      })
      .finally(() => { if (current) setLoading(false); });
    // Guards a window switch landing out of order: a 30d request started first
    // can answer after the 24h one that replaced it, and without this the
    // screen would settle on the window nobody selected.
    return () => { current = false; };
  }, [session, unlocked, window, onSessionExpired]);

  if (!unlocked) {
    return <LockedScreen
      kicker="Gateway"
      title="Usage"
      mark="U"
      reason="Sign in as an administrator to read what the governed inference path has consumed."
      // The same words and the same button as every other locked governance
      // screen, which `locked-screen-contract.test.tsx` asserts across all of
      // them: an operator moving between them is not relearning the rule.
      actionLabel="Open platform settings"
      onAction={onConfigure}
    />;
  }

  const totals = report?.totals;

  return <div className="workspace-stack flex h-full min-h-0 flex-col gap-3 pb-3">
    <WorkspaceIntro
      icon={<Activity className="size-4" aria-hidden="true" />}
      title="Usage"
      actions={
        <label className="flex items-center gap-2">
          <span className="whitespace-nowrap text-caption text-muted">Window</span>
          <Select
            className="w-44"
            value={window}
            onChange={(event) => setWindow(event.target.value as UsageWindow)}
          >
            {(Object.keys(WINDOW_LABELS) as UsageWindow[]).map((key) => (
              <option key={key} value={key}>{WINDOW_LABELS[key]}</option>
            ))}
          </Select>
        </label>
      }
    >
      <section className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <MicroLabel className="block">What this counts</MicroLabel>
          <strong className="mt-1.5 block text-label font-semibold text-text">
            {report
              ? `${exact.format(report.totals.runs)} runs finished in the ${WINDOW_LABELS[report.window].toLowerCase()}.`
              : loading ? "Reading the window…" : "No window loaded."}
          </strong>
          <p className="mb-0 mt-1 text-caption leading-relaxed text-muted">
            Every governed run that reached a terminal state inside the window, including the chat turns
            among them. Cost is what the route reported; there is no price book, so an on-premises
            route that reports none shows a dash rather than a zero.
          </p>
        </div>
      </section>
    </WorkspaceIntro>

    <WorkspaceDock>
      <MetricRow className="border-b-0 pb-0 lg:grid-cols-5" aria-label="Gateway usage summary">
        <Metric
          label="Runs"
          value={totals ? exact.format(totals.runs) : NOT_REPORTED}
          caption={totals ? `${exact.format(totals.completed)} completed · ${exact.format(totals.failed)} failed` : "No data"}
        />
        <Metric
          label="Total tokens"
          value={totals ? tokens(totals.totalTokens) : NOT_REPORTED}
          caption={totals
            ? `${tokens(totals.inputTokens)} in · ${tokens(totals.outputTokens)} out${totals.tokensUnreported > 0 ? ` · ${exact.format(totals.tokensUnreported)} unreported` : ""}`
            : "No data"}
        />
        <Metric
          label="Cost"
          value={totals ? cost(totals.costUsd) : NOT_REPORTED}
          caption={totals
            ? totals.costReportedRuns === 0
              ? "No route reported a price"
              : `${exact.format(totals.costReportedRuns)} of ${exact.format(totals.runs)} runs priced`
            : "No data"}
        />
        <Metric
          label="Failure rate"
          value={totals ? percentage(totals.failureRate) : NOT_REPORTED}
          tone={totals && totals.failureRate > 0.1 ? "bad" : totals && totals.failureRate > 0 ? "warn" : "good"}
          caption={totals ? `${exact.format(totals.timedOut)} timed out · ${exact.format(totals.denied)} denied` : "No data"}
        />
        <Metric
          label="p95 latency"
          value={totals ? milliseconds(totals.p95LatencyMs) : NOT_REPORTED}
          caption={totals ? `${milliseconds(totals.averageLatencyMs)} average · ${milliseconds(totals.averageFirstTokenMs)} to first token` : "No data"}
        />
      </MetricRow>
    </WorkspaceDock>

    {error && <Alert className="shrink-0" onDismiss={() => setError(null)}>{error}</Alert>}

    <section className="grid min-h-0 flex-1 content-start items-start gap-3 overflow-y-auto" aria-label="Gateway usage detail">
      {report && (
        <Panel className="grid gap-3">
          <PanelHeading
            title="Consumption over time"
            description={`One bar per ${report.bucket}, tallest bar scaled to the busiest one. A red foot marks a ${report.bucket} that contained a failed run.`}
            className="mb-0"
          />
          {report.series.length === 0
            ? <EmptyState title="Nothing finished in this window">
                Send a message in Session, or widen the window, and the trend fills in.
              </EmptyState>
            : <UsageTrend series={report.series} bucket={report.bucket} />}
        </Panel>
      )}

      {report && (
        <Panel className="grid gap-3">
          <PanelHeading
            title="The governed path itself"
            description="Requests the enrolled runtime made back through the OrcaSynapse inference gateway, and the governed tool calls made alongside them."
            className="mb-0"
          />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Tile>
              <MicroLabel className="block">Gateway requests</MicroLabel>
              <strong className="mt-1 block font-display text-[19px] font-semibold tabular-nums text-text">
                {exact.format(report.gateway.requests)}
              </strong>
            </Tile>
            <Tile>
              <MicroLabel className="block">Refused</MicroLabel>
              <strong className="mt-1 block font-display text-[19px] font-semibold tabular-nums text-text">
                {exact.format(report.gateway.rejected)}
              </strong>
              <small className="mt-1 block text-caption text-muted">
                {exact.format(report.gateway.rejectedByPolicy)} by guardrails ·{" "}
                {exact.format(report.gateway.rejectedByRateLimit)} rate limited
              </small>
            </Tile>
            <Tile>
              <MicroLabel className="block">Tool calls</MicroLabel>
              <strong className="mt-1 block font-display text-[19px] font-semibold tabular-nums text-text">
                {exact.format(report.tools.calls)}
              </strong>
              <small className="mt-1 block text-caption text-muted">
                {exact.format(report.tools.completed)} completed
              </small>
            </Tile>
            <Tile>
              <MicroLabel className="block">Tool refusals</MicroLabel>
              <strong className="mt-1 block font-display text-[19px] font-semibold tabular-nums text-text">
                {exact.format(report.tools.denied + report.tools.failed)}
              </strong>
              <small className="mt-1 block text-caption text-muted">
                {exact.format(report.tools.denied)} denied · {exact.format(report.tools.failed)} failed
              </small>
            </Tile>
          </div>
        </Panel>
      )}

      {report && <div className="grid gap-3 lg:grid-cols-2">
        <Breakdown
          title="By model route"
          description="Which approved route the spend actually went to."
          breakdown={report.byModel}
        />
        <Breakdown
          title="By agent"
          description="Named by profile slug, which is stable across the versions a profile has had."
          breakdown={report.byProfile}
        />
        <Breakdown
          title="By division"
          description="Runs against a deployment-wide profile belong to no division and are their own row, not a gap."
          breakdown={report.byDivision}
        />
        {report.byUser
          ? <Breakdown
              title="By person"
              description="Who drove the usage, from the run's own owner."
              breakdown={report.byUser}
            />
          : <Panel className="grid min-w-0 gap-3">
              <PanelHeading title="By person" description="Who drove the usage." className="mb-0" />
              {/*
                * A refusal, not an empty table. This breakdown names individuals,
                * so it sits behind `audit:read` rather than the `operations:read`
                * the rest of the screen needs — and a reader who may not see it
                * has to be able to tell that from nobody having used the system.
                */}
              <EmptyState title="This breakdown needs the audit scope">
                Per-person usage names individuals, so it is behind <code className="font-mono">audit:read</code>{" "}
                rather than the operations scope the rest of this screen uses. A Platform, Security or Auditor
                administrator can read it.
              </EmptyState>
            </Panel>}
      </div>}

      {!report && !error && (
        <EmptyState title={loading ? "Loading usage…" : "No usage loaded"}>
          {loading ? "Reading the selected window." : "Select a window to read what the inference path consumed."}
        </EmptyState>
      )}
    </section>
  </div>;
}
