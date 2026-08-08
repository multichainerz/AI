import {
  EVALUATION_CATEGORIES,
  type AdministratorSession,
  type AttachBenchmarkEvidence,
  type BenchmarkCaseResult,
  type BenchmarkKind,
  type BenchmarkRun,
  type BenchmarkSuite,
  type EvaluationCategory,
  type EvaluationTargetType,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  attachBenchmarkEvidence,
  cancelBenchmarkRun,
  deleteBenchmarkSuite,
  getBenchmarkRuns,
  getBenchmarkSuites,
  startBenchmarkRun,
} from "./api.js";
import { BenchmarkSuiteEditor } from "./benchmark-suite-editor.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  LockedScreen,
  Metric,
  MetricRow,
  MicroLabel,
  PageHeader,
  Panel,
  Select,
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
  /*
   * The run being inspected is held by id, not by value.
   *
   * Opening the results on a run in flight is the case the poll exists for, and
   * a snapshot taken at open time freezes at the cases scored so far — and never
   * reaches COMPLETED, so the evidence form the run was commissioned for never
   * appears however long the operator waits.
   */
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  /** null when closed; `{ suite: null }` for a new one. */
  const [editing, setEditing] = useState<{ suite: BenchmarkSuite | null } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
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

  const inspecting = inspectingId === null ? null : runs.find(({ id }) => id === inspectingId) ?? null;

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

  const remove = async (suite: BenchmarkSuite) => {
    setBusy(suite.id);
    setError(null);
    try {
      await deleteBenchmarkSuite(suite.id);
      setMessage(`'${suite.displayName}' deleted.`);
      await load();
    } catch (deleteError) {
      if (deleteError instanceof OrcaSynapseApiError && deleteError.status === 401) onSessionExpired();
      else setError(deleteError instanceof Error ? deleteError.message : "Unable to delete the suite.");
    } finally {
      setBusy(null);
      setConfirmingDelete(null);
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
      actions={<>
        <Button onClick={onOpenOperations}>Evaluation ledger</Button>
        {canManage && <Button variant="primary" onClick={() => setEditing({ suite: null })}>New suite</Button>}
      </>}
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
        <strong className="mt-1.5 block text-label font-semibold text-text">
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
        <EmptyState
          className="lg:col-span-2"
          title="No benchmark suites yet"
          action={canManage
            ? <Button onClick={() => setEditing({ suite: null })}>Author the first suite</Button>
            : undefined}
        >
          A suite is a set of questions with the things their answers must contain. Running one is how you find out
          whether this installation still answers as well as it did.
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
            {canManage && !running && <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${suite.displayName}`}
              onClick={() => setConfirmingDelete(confirmingDelete === suite.id ? null : suite.id)}
            >
              Delete
            </Button>}
          </header>

          <div className="min-w-0">
            <h2 className="font-display m-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-text">{suite.displayName}</h2>
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
                <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
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
            <div className="flex gap-1.5">
              {/* Outside the manage guard: reading the evidence is what
                  `evaluations:read` is for, and an auditor who cannot see a
                  result cannot audit the decision made on it. */}
              {latest && latest.results.length > 0 && (
                <Button size="sm" onClick={() => setInspectingId(latest.id)}>Results</Button>
              )}
              {canManage && !running && (
                <Button size="sm" onClick={() => setEditing({ suite })}>Edit</Button>
              )}
              {canManage && (running
                ? <Button size="sm" variant="danger" disabled={busy === running.id} onClick={() => void stop(running)}>
                    {busy === running.id ? "Stopping..." : "Stop"}
                  </Button>
                : <Button size="sm" variant="primary" disabled={busy === suite.id} onClick={() => void start(suite)}>
                    {busy === suite.id ? "Starting..." : "Run"}
                  </Button>)}
            </div>
          </footer>

          {confirmingDelete === suite.id && <div className="grid gap-3 rounded border border-bad/40 bg-bad/10 p-3">
            <div>
              <strong className="block text-label font-semibold text-text">Delete this suite?</strong>
              {/* The server refuses when a result is cited by an evaluation or a
                  run is still going, and says which — so this warns rather than
                  guesses. */}
              <span className="mt-1 block text-body text-muted">
                Its run history goes with it. A result already recorded against an evaluation keeps the suite.
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setConfirmingDelete(null)}>Keep</Button>
              <Button size="sm" variant="danger" disabled={busy === suite.id} onClick={() => void remove(suite)}>
                {busy === suite.id ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>}
        </Panel>;
      })}
    </section>

    {editing && <BenchmarkSuiteEditor
      suite={editing.suite}
      onSaved={(note) => { setEditing(null); setMessage(note); void load(); }}
      onClose={() => setEditing(null)}
    />}

    {inspecting && <RunResults
      run={inspecting}
      canManage={canManage}
      suite={suites.find(({ id }) => id === inspecting.suiteId) ?? null}
      onRecorded={(note) => { setInspectingId(null); setMessage(note); void load(); }}
      onClose={() => setInspectingId(null)}
    />}
  </div>;
}

interface RunResultsProps {
  run: BenchmarkRun;
  suite: BenchmarkSuite | null;
  canManage: boolean;
  onRecorded: (note: string) => void;
  onClose: () => void;
}

function RunResults({ run, suite, canManage, onRecorded, onClose }: RunResultsProps) {
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
            <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
            {/* Titled because these cells truncate, and a half-shown model
                alias is the fact you most need whole. */}
            <dd className="m-0 mt-1 truncate font-mono text-caption tabular-nums text-muted" title={fact.value}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>

      {run.failureMessage && <Alert tone="warn">{run.failureMessage}</Alert>}

      {run.status === "COMPLETED" && canManage && (
        <EvidenceForm run={run} suite={suite} onRecorded={onRecorded} />
      )}

      <ul className="m-0 grid list-none gap-2 p-0">
        {run.results.map((result) => <CaseResult key={result.caseId} result={result} />)}
      </ul>
    </div>
  </Dialog>;
}

/** The evaluation category each kind most obviously speaks to. */
const categoryForKind: Record<BenchmarkKind, EvaluationCategory> = {
  CHAT_QUALITY: "CHAT",
  RETRIEVAL: "RETRIEVAL",
  // Memory shows up as wrong answers, so chat is where its evidence lands —
  // stated as a default the operator can override, not as a fact.
  MEMORY: "CHAT",
};

function humanCategory(category: EvaluationCategory): string {
  return category.toLowerCase().replaceAll("_", " ");
}

/**
 * Records this run in the evaluation ledger.
 *
 * The split is deliberate: the operator types what they are deciding — which
 * release this gates, which category it answers for, what bar it must clear —
 * and never types the numbers. Those come from the run, so the figure a
 * promotion rests on is not one anybody could have mistyped in its favour.
 */
function EvidenceForm({
  run,
  suite,
  onRecorded,
}: {
  run: BenchmarkRun;
  suite: BenchmarkSuite | null;
  onRecorded: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AttachBenchmarkEvidence>({
    name: `${run.suiteSlug} — revision ${run.suiteRevision}`,
    category: categoryForKind[run.kind],
    targetType: run.target.agentProfileSlug ? "AGENT" : "MODEL",
    targetReference: run.target.agentProfileSlug ?? run.target.modelAlias ?? "",
    targetVersion: run.target.agentProfileVersion
      ? `v${run.target.agentProfileVersion}`
      : run.target.modelAlias ?? "",
    minimumPassRate: Math.max(0.5, suite?.passThreshold ?? 0.95),
  });

  if (run.evaluationRunId) {
    return <StatusText tone="good" dot>Recorded in the evaluation ledger.</StatusText>;
  }
  if (!open) {
    return <div className="flex items-center justify-between gap-3 rounded border border-border bg-raised px-3 py-2.5">
      <span className="text-body text-muted">
        {run.passedCases}/{run.totalCases} cases can be filed as the evidence for an evaluation.
      </span>
      <Button size="sm" onClick={() => setOpen(true)}>Record as evidence</Button>
    </div>;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const evaluation = await attachBenchmarkEvidence(run.id, draft);
      onRecorded(`Evaluation '${evaluation.name}' recorded as ${evaluation.status.toLowerCase()}.`);
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : "Unable to record the evidence.");
    } finally {
      setBusy(false);
    }
  };

  return <form
    className="grid gap-3 rounded border border-border-strong bg-raised p-3"
    onSubmit={(event) => void submit(event)}
  >
    <div>
      <strong className="block text-label font-semibold text-text">Record as evaluation evidence</strong>
      <span className="mt-1 block text-body text-muted">
        {run.passedCases} of {run.totalCases} cases are carried across unchanged. Only what you are deciding is typed.
      </span>
    </div>
    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Evaluation name">
        <Input
          value={draft.name}
          minLength={3}
          maxLength={160}
          required
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>
      <Field label="Evidence for">
        <Select
          value={draft.category}
          onChange={(event) => setDraft({ ...draft, category: event.target.value as EvaluationCategory })}
        >
          {EVALUATION_CATEGORIES.map((category) => (
            <option key={category} value={category}>{humanCategory(category)}</option>
          ))}
        </Select>
      </Field>
      <Field label="Target">
        <Select
          value={draft.targetType}
          onChange={(event) => setDraft({ ...draft, targetType: event.target.value as EvaluationTargetType })}
        >
          {(["AGENT", "MODEL", "PROMPT", "POLICY"] as const).map((target) => (
            <option key={target} value={target}>{target.toLowerCase()}</option>
          ))}
        </Select>
      </Field>
      <Field label="Reference">
        <Input
          value={draft.targetReference}
          required
          maxLength={240}
          onChange={(event) => setDraft({ ...draft, targetReference: event.target.value })}
        />
      </Field>
      <Field label="Version">
        <Input
          value={draft.targetVersion}
          required
          maxLength={120}
          onChange={(event) => setDraft({ ...draft, targetVersion: event.target.value })}
        />
      </Field>
      <Field label="Minimum pass rate">
        <Input
          type="number"
          min={0.5}
          max={1}
          step={0.01}
          value={draft.minimumPassRate}
          required
          onChange={(event) => setDraft({ ...draft, minimumPassRate: Number(event.target.value) })}
        />
      </Field>
    </div>
    <div className="flex justify-end gap-2">
      <Button onClick={() => setOpen(false)}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={busy || draft.targetReference.trim().length === 0}>
        {busy ? "Recording..." : "Record"}
      </Button>
    </div>
  </form>;
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
        <summary className="cursor-pointer text-micro font-semibold uppercase tabular-nums text-faint">Answer excerpt</summary>
        <p className="mb-0 mt-2 whitespace-pre-wrap break-words text-body text-muted">{result.outputExcerpt}</p>
      </details>
    )}
  </li>;
}
