import type {
  AdministratorSession,
  BenchmarkCaseResult,
  BenchmarkKind,
  BenchmarkRun,
  BenchmarkSuite,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  OrcaSynapseApiError,
  cancelBenchmarkRun,
  getBenchmarkRuns,
  getBenchmarkSuites,
  startBenchmarkRun,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  LockedScreen,
  Metric,
  MetricRow,
  MicroLabel,
  PageHeader,
  Panel,
  StatusText,
  cn,
} from "./ui/index.js";

interface BenchmarksViewProps {
  session: AdministratorSession | null;
  onOpenOperations: () => void;
  onSessionExpired: () => void;
}

/** While anything is in flight, results change without the operator acting. */
const REFRESH_MS = 4_000;

const kindLabel: Record<BenchmarkKind, string> = {
  CHAT_QUALITY: "Chat quality",
  RETRIEVAL: "Retrieval",
  MEMORY: "Memory",
};

const kindDescription: Record<BenchmarkKind, string> = {
  CHAT_QUALITY: "Asks the agent, through the same path a person's message takes.",
  RETRIEVAL: "Searches the document plane and scores the passages that come back.",
  MEMORY: "Reads what the agent already knows about this owner.",
};

function inFlight(run: BenchmarkRun): boolean {
  return run.status === "QUEUED" || run.status === "RUNNING";
}

/**
 * Colour states what the run means, not merely what it is.
 *
 * A completed run below its suite's threshold is a regression, so it reads as
 * one — a green "completed" beside a 0.4 pass rate is the misreading this
 * whole screen exists to prevent.
 */
function runTone(run: BenchmarkRun, threshold: number): "good" | "warn" | "bad" | "accent" | "neutral" {
  if (inFlight(run)) return "accent";
  if (run.status === "CANCELLED") return "neutral";
  if (run.status === "FAILED") return "warn";
  return (run.passRate ?? 0) >= threshold ? "good" : "bad";
}

/**
 * States the outcome, not the enum.
 *
 * "Completed" is true of a suite that scored 0.5 against a 0.9 threshold and
 * tells an operator nothing — the word they need is that it regressed. The
 * lifecycle value is an implementation detail; what the run *means* is not.
 */
function runLabel(run: BenchmarkRun, threshold: number): string {
  switch (run.status) {
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "CANCELLED":
      return "stopped";
    case "FAILED":
      return "did not run";
    case "COMPLETED":
      return (run.passRate ?? 0) >= threshold ? "passed" : "below threshold";
  }
}

function percentage(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function duration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

/**
 * Short enough to survive a narrow cell.
 *
 * The full form truncated mid-clock in the results grid, which is worse than a
 * coarser one: "4:00:01…" hides whether it is morning or evening.
 */
function when(value: string | null): string {
  return value === null
    ? "—"
    : new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function BenchmarksView({ session, onOpenOperations, onSessionExpired }: BenchmarksViewProps) {
  const [suites, setSuites] = useState<BenchmarkSuite[]>([]);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [inspecting, setInspecting] = useState<BenchmarkRun | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { unlocked, can } = adminAccess(session);
  const canManage = can("evaluations:manage");
  const loading = useRef(false);

  const load = async () => {
    if (!unlocked || loading.current) return;
    loading.current = true;
    try {
      const [suiteList, runList] = await Promise.all([getBenchmarkSuites(), getBenchmarkRuns()]);
      setSuites(suiteList.items);
      setRuns(runList.items);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof OrcaSynapseApiError && loadError.status === 401) onSessionExpired();
      else setError(loadError instanceof Error ? loadError.message : "Unable to load benchmarks.");
    } finally {
      loading.current = false;
    }
  };

  useEffect(() => { void load(); }, [session]);

  const active = runs.filter(inFlight);

  /*
   * Polls only while something is running.
   *
   * A run is minutes of inference with no push channel, so the screen has to
   * ask. It stops asking the moment nothing is in flight, because a benchmark
   * page left open on a quiet installation should not keep a query running
   * against the same database the agents use.
   */
  useEffect(() => {
    if (!unlocked || active.length === 0) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [unlocked, active.length]);

  const latestBySuite = useMemo(() => {
    const latest = new Map<string, BenchmarkRun>();
    // Runs arrive newest first, so the first one seen for a suite is its latest.
    for (const run of runs) if (!latest.has(run.suiteId)) latest.set(run.suiteId, run);
    return latest;
  }, [runs]);

  const start = async (suite: BenchmarkSuite) => {
    setBusy(suite.id);
    setError(null);
    setMessage(null);
    try {
      await startBenchmarkRun({ suiteId: suite.id });
      setMessage(`'${suite.displayName}' is queued. Results appear here as each case is scored.`);
      await load();
    } catch (startError) {
      if (startError instanceof OrcaSynapseApiError && startError.status === 401) onSessionExpired();
      else setError(startError instanceof Error ? startError.message : "Unable to start the run.");
    } finally {
      setBusy(null);
    }
  };

  const stop = async (run: BenchmarkRun) => {
    setBusy(run.id);
    setError(null);
    try {
      await cancelBenchmarkRun(run.id);
      setMessage("Run stopped. The cases it already scored are kept.");
      await load();
    } catch (stopError) {
      if (stopError instanceof OrcaSynapseApiError && stopError.status === 401) onSessionExpired();
      else setError(stopError instanceof Error ? stopError.message : "Unable to stop the run.");
    } finally {
      setBusy(null);
    }
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Evidence"
      title="Benchmarks"
      mark="B"
      reason="Claim or sign in to OrcaSynapse to run benchmarks. A run drives the live agent, so it is gated on the same permission that manages evaluations."
      actionLabel="Open operations"
      onAction={onOpenOperations}
    />;
  }

  const completed = runs.filter(({ status }) => status === "COMPLETED");
  const regressions = completed.filter((run) => {
    const suite = suites.find(({ id }) => id === run.suiteId);
    return suite ? (run.passRate ?? 0) < suite.passThreshold : false;
  }).length;

  return <div className="grid gap-5">
    <PageHeader
      kicker="Operations"
      title="Benchmarks"
      description="Deterministic checks executed against this installation, and the evidence an evaluation is promoted on."
      actions={<Button onClick={onOpenOperations}>Evaluation ledger</Button>}
    />

    <MetricRow className="lg:grid-cols-4" aria-label="Benchmark summary">
      <Metric label="Suites" value={suites.length} caption="Authored checks" />
      <Metric label="In flight" value={active.length} tone={active.length > 0 ? "accent" : "neutral"} caption="Queued or running" />
      <Metric label="Completed" value={completed.length} caption="Scored runs" />
      <Metric
        label="Below threshold"
        value={regressions}
        tone={regressions > 0 ? "bad" : "good"}
        caption="Regressions"
      />
    </MetricRow>

    <Panel className="flex items-center gap-4 border-l-2 border-l-accent">
      <div className="min-w-0 flex-1">
        <MicroLabel className="block">How a run is scored</MicroLabel>
        <strong className="mt-1.5 block text-[12px] font-semibold text-text">
          Every check is a plain string or latency comparison. No model judges an answer.
        </strong>
        <p className="mb-0 mt-1 text-body text-muted">
          A run reads memory and never writes to it, so running a suite twice measures the same installation both
          times. A completed run can be cited as the evidence for an evaluation.
        </p>
      </div>
    </Panel>

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    {message && <Alert tone="good" onDismiss={() => setMessage(null)}>{message}</Alert>}

    <section className="grid items-start gap-3 lg:grid-cols-2" aria-label="Benchmark suites">
      {suites.length === 0 && (
        <EmptyState className="lg:col-span-2" title="No benchmark suites yet">
          A suite is a set of questions with the answers they must contain. Author one through the benchmarks API to
          start measuring whether this installation still answers well.
        </EmptyState>
      )}
      {suites.map((suite) => {
        const latest = latestBySuite.get(suite.id);
        const running = latest && inFlight(latest) ? latest : null;
        return <Panel className="grid min-w-0 gap-4" key={suite.id}>
          <header className="flex items-center gap-3">
            <MicroLabel className="rounded border border-border bg-raised px-1.5 py-0.5">
              {kindLabel[suite.kind]}
            </MicroLabel>
            {latest && (
              <StatusText dot tone={runTone(latest, suite.passThreshold)}>
                {runLabel(latest, suite.passThreshold)}
              </StatusText>
            )}
            <StatusText className="ml-auto">Revision {suite.revision}</StatusText>
          </header>

          <div className="min-w-0">
            <h2 className="m-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-text">{suite.displayName}</h2>
            <p className="mb-0 mt-1 text-body text-muted">{suite.description}</p>
            <p className="mb-0 mt-1 text-caption text-faint">{kindDescription[suite.kind]}</p>
          </div>

          <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-4">
            {[
              { label: "Cases", value: String(suite.cases.length) },
              { label: "Threshold", value: percentage(suite.passThreshold) },
              { label: "Last score", value: latest?.status === "COMPLETED" ? percentage(latest.passRate) : "—" },
              { label: "Median", value: duration(latest?.medianLatencyMs ?? null) },
            ].map((fact) => (
              <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
                <dt className="truncate font-mono text-micro uppercase text-faint">{fact.label}</dt>
                {/* Titled because these cells truncate, and a half-shown model
                alias is the fact you most need whole. */}
            <dd className="m-0 mt-1 truncate font-mono text-caption tabular-nums text-muted" title={fact.value}>
              {fact.value}
            </dd>
              </div>
            ))}
          </dl>

          {running && (
            <div className="rounded border border-accent/40 bg-accent/10 px-3 py-2">
              <MicroLabel className="block text-accent">
                {running.status === "QUEUED" ? "Waiting for a worker" : "Running"}
              </MicroLabel>
              <span className="mt-1 block font-mono text-caption tabular-nums text-muted">
                {running.results.length} of {running.totalCases} cases scored
              </span>
            </div>
          )}

          <footer className="flex items-center justify-between gap-2.5">
            <StatusText>{latest ? `Last run ${when(latest.queuedAt)}` : "Never run"}</StatusText>
            {canManage && <div className="flex gap-1.5">
              {latest && latest.results.length > 0 && (
                <Button size="sm" onClick={() => setInspecting(latest)}>Results</Button>
              )}
              {running
                ? <Button size="sm" variant="danger" disabled={busy === running.id} onClick={() => void stop(running)}>
                    {busy === running.id ? "Stopping..." : "Stop"}
                  </Button>
                : <Button size="sm" variant="primary" disabled={busy === suite.id} onClick={() => void start(suite)}>
                    {busy === suite.id ? "Starting..." : "Run"}
                  </Button>}
            </div>}
          </footer>
        </Panel>;
      })}
    </section>

    {inspecting && <RunResults run={inspecting} onClose={() => setInspecting(null)} />}
  </div>;
}

function RunResults({ run, onClose }: { run: BenchmarkRun; onClose: () => void }) {
  return <Dialog
    open
    kicker="Benchmark run"
    title={`${run.suiteSlug} — revision ${run.suiteRevision}`}
    onClose={onClose}
  >
    <div className="grid gap-4">
      {/* What the run was pointed at. The same suite scoring 0.94 then 0.71
          says nothing until you know what changed underneath. */}
      <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-4">
        {[
          { label: "Score", value: percentage(run.passRate) },
          { label: "Cases", value: `${run.passedCases}/${run.totalCases}` },
          { label: "Model", value: run.target.modelAlias ?? "—" },
          { label: "Agent", value: run.target.agentProfileSlug
            ? `${run.target.agentProfileSlug} v${run.target.agentProfileVersion ?? "?"}`
            : "—" },
          { label: "Owner", value: run.target.ownerSubject },
          { label: "Median", value: duration(run.medianLatencyMs) },
          { label: "Started", value: when(run.startedAt) },
          { label: "Finished", value: when(run.completedAt) },
        ].map((fact) => (
          <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
            <dt className="truncate font-mono text-micro uppercase text-faint">{fact.label}</dt>
            {/* Titled because these cells truncate, and a half-shown model
                alias is the fact you most need whole. */}
            <dd className="m-0 mt-1 truncate font-mono text-caption tabular-nums text-muted" title={fact.value}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>

      {run.failureMessage && <Alert tone="warn">{run.failureMessage}</Alert>}

      <ul className="m-0 grid list-none gap-2 p-0">
        {run.results.map((result) => <CaseResult key={result.caseId} result={result} />)}
      </ul>
    </div>
  </Dialog>;
}

function CaseResult({ result }: { result: BenchmarkCaseResult }) {
  return <li className={cn(
    "grid gap-2 rounded border p-3",
    result.passed ? "border-border bg-surface" : "border-bad/40 bg-bad/10",
  )}>
    <header className="flex items-center gap-3">
      <StatusText dot tone={result.passed ? "good" : "bad"}>{result.passed ? "passed" : "failed"}</StatusText>
      <span className="truncate font-mono text-caption text-muted">{result.caseId}</span>
      <span className="ml-auto shrink-0 font-mono text-caption tabular-nums text-faint">
        {duration(result.latencyMs)}
      </span>
    </header>
    {/* The intent, so a failure explains itself without someone having to
        reconstruct why the case was written. */}
    <p className="m-0 text-body text-muted">{result.intent}</p>
    <ul className="m-0 grid list-none gap-1 p-0">
      {result.assertions.map((assertion, index) => (
        <li className="flex items-center gap-2" key={`${assertion.kind}-${index}`}>
          <StatusText dot tone={assertion.passed ? "good" : "bad"} />
          <MicroLabel>{assertion.kind.toLowerCase().replaceAll("_", " ")}</MicroLabel>
          <span className="min-w-0 truncate font-mono text-caption text-muted">{assertion.value}</span>
        </li>
      ))}
    </ul>
    {result.failureReason && <StatusText tone="warn">{result.failureReason}</StatusText>}
    {result.outputExcerpt && (
      <details>
        <summary className="cursor-pointer font-mono text-micro uppercase text-faint">Answer excerpt</summary>
        <p className="mb-0 mt-2 whitespace-pre-wrap break-words text-body text-muted">{result.outputExcerpt}</p>
      </details>
    )}
  </li>;
}
