import {
  benchmarkCaseSchema,
  type BenchmarkAssertion,
  type BenchmarkCase,
  type BenchmarkCaseResult,
  type BenchmarkKind,
} from "@orcasynapse/contracts";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { auditEvent, benchmarkRun, benchmarkSuite, type OrcaSynapseDatabase } from "@orcasynapse/database";

/**
 * Executes benchmark suites against the live stack and scores what comes back.
 *
 * Everything here is deterministic. No model judges an answer, because a score
 * an operator cannot re-derive by hand is not evidence a release is safe — and
 * the whole point of a benchmark run is to be the evidence an evaluation cites.
 *
 * A run never writes to agent memory. Recall is measured; capture is not, and a
 * benchmark that wrote facts would change the system it is measuring, so the
 * second run of a suite would score differently because of the first. The
 * capability list on the agent runs this queues carries `memory:agent:read`
 * when the profile allows it and never `memory:agent:write`.
 */

/** How long a claim is held before another worker may take the run. */
const LEASE_MS = 5 * 60_000;

/** What one case produced, whichever plane answered it. */
export interface BenchmarkCaseOutput {
  /** The answer text, retrieved passages, or recalled facts — whatever is scored. */
  text: string;
  /** File names of documents the answer drew on, for MUST_CITE_DOCUMENT. */
  citedDocuments: string[];
  latencyMs: number | null;
  outputTokens: number | null;
  /** Set when the case could not be executed at all, as opposed to answered badly. */
  failureReason: string | null;
}

export interface ClaimedBenchmarkRun {
  id: string;
  suiteId: string;
  suiteSlug: string;
  suiteRevision: number;
  kind: BenchmarkKind;
  ownerSubject: string;
  agentProfileId: string | null;
  /** The version pinned when the run was queued, not whatever is active now. */
  agentProfileVersion: number | null;
  requestedBy: string | null;
}

/** Drives one case against whichever plane its suite exercises. */
export interface BenchmarkCaseExecutor {
  execute(run: ClaimedBenchmarkRun, benchmarkCase: BenchmarkCase): Promise<BenchmarkCaseOutput>;
}

export interface BenchmarkOutcome {
  runId: string;
  suiteSlug: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  passedCases: number;
  totalCases: number;
}

/**
 * Decides one assertion.
 *
 * Substring rather than equality throughout: a suite asserts that an answer
 * mentions the rollback step, not that it is phrased a particular way, and an
 * exact-match benchmark would fail on every rewording and teach an operator to
 * ignore it.
 */
export function scoreAssertion(assertion: BenchmarkAssertion, output: BenchmarkCaseOutput): boolean {
  const haystack = output.text.toLowerCase();
  const needle = assertion.value.trim().toLowerCase();
  switch (assertion.kind) {
    case "MUST_INCLUDE":
      return haystack.includes(needle);
    case "MUST_NOT_INCLUDE":
      return !haystack.includes(needle);
    case "MUST_CITE_DOCUMENT":
      // Matched on the file name so a suite can say "runbook" without pinning
      // the extension the operator happened to upload.
      return output.citedDocuments.some((name) => name.toLowerCase().includes(needle));
    case "MAX_LATENCY_MS":
      // An unmeasured latency is not a fast one. The contract has already
      // refused a non-numeric bound.
      return output.latencyMs !== null && output.latencyMs <= Number(assertion.value);
  }
}

export function scoreCase(benchmarkCase: BenchmarkCase, output: BenchmarkCaseOutput): BenchmarkCaseResult {
  const assertions = benchmarkCase.assertions.map((assertion) => ({
    kind: assertion.kind,
    value: assertion.value,
    passed: output.failureReason === null && scoreAssertion(assertion, output),
  }));
  return {
    caseId: benchmarkCase.id,
    intent: benchmarkCase.intent,
    passed: output.failureReason === null && assertions.every(({ passed }) => passed),
    assertions,
    latencyMs: output.latencyMs,
    outputTokens: output.outputTokens,
    // Bounded, never the whole answer: enough to see why a case failed without
    // turning the results column into a second transcript store.
    outputExcerpt: output.text.length > 0 ? output.text.slice(0, 2_000) : null,
    failureReason: output.failureReason,
  };
}

/**
 * Median, not mean: one cold start on a host that loads weights on demand would
 * otherwise redefine what "typical" means for the whole suite.
 */
export function medianLatency(results: readonly BenchmarkCaseResult[]): number | null {
  const measured = results
    .flatMap(({ latencyMs }) => latencyMs === null ? [] : [latencyMs])
    .sort((left, right) => left - right);
  if (measured.length === 0) return null;
  const middle = Math.floor(measured.length / 2);
  return measured.length % 2 === 1
    ? measured[middle]!
    : Math.round((measured[middle - 1]! + measured[middle]!) / 2);
}

export class BenchmarkRunner {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly executor: BenchmarkCaseExecutor,
    private readonly leaseMs = LEASE_MS,
  ) {}

  /** Runs the longest-waiting queued suite, or returns null when there is none. */
  async runNext(workerId: string): Promise<BenchmarkOutcome | null> {
    const claimed = await this.claim(workerId);
    if (!claimed) return null;
    try {
      return await this.executeRun(claimed, workerId);
    } catch (cause) {
      console.error("OrcaSynapse could not execute benchmark run", claimed.id, cause);
      await this.fail(claimed.id, "The benchmark run could not be completed.");
      return { runId: claimed.id, suiteSlug: claimed.suiteSlug, status: "FAILED", passedCases: 0, totalCases: 0 };
    }
  }

  /**
   * Takes the oldest run nobody holds.
   *
   * `FOR UPDATE SKIP LOCKED` rather than a read-then-write: two workers reading
   * the same queued row would both execute the suite, and the second result
   * would silently overwrite the first.
   */
  private async claim(workerId: string): Promise<ClaimedBenchmarkRun | null> {
    const now = new Date();
    const expiry = new Date(now.getTime() + this.leaseMs);
    return this.database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ id: benchmarkRun.id })
        .from(benchmarkRun)
        .where(or(
          eq(benchmarkRun.status, "QUEUED"),
          // A run whose worker died. The lease lapsing is the only signal that
          // separates that from one still going.
          and(eq(benchmarkRun.status, "RUNNING"), lt(benchmarkRun.leaseExpiresAt, now)),
          and(eq(benchmarkRun.status, "RUNNING"), isNull(benchmarkRun.leaseExpiresAt)),
        ))
        .orderBy(asc(benchmarkRun.queuedAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;

      const [row] = await transaction
        .update(benchmarkRun)
        .set({
          status: "RUNNING",
          startedAt: sql`COALESCE(${benchmarkRun.startedAt}, ${now})`,
          leaseOwner: workerId,
          leaseExpiresAt: expiry,
        })
        .where(eq(benchmarkRun.id, candidate.id))
        .returning();
      if (!row) return null;
      return {
        id: row.id,
        suiteId: row.suiteId,
        suiteSlug: row.suiteSlug,
        suiteRevision: row.suiteRevision,
        kind: row.kind,
        ownerSubject: row.ownerSubject,
        agentProfileId: row.agentProfileId,
        agentProfileVersion: row.agentProfileVersion,
        requestedBy: row.requestedBy,
      };
    });
  }

  private async executeRun(run: ClaimedBenchmarkRun, workerId: string): Promise<BenchmarkOutcome> {
    const [suite] = await this.database
      .select({ cases: benchmarkSuite.cases, revision: benchmarkSuite.revision })
      .from(benchmarkSuite)
      .where(eq(benchmarkSuite.id, run.suiteId))
      .limit(1);
    if (!suite) {
      // The run cascades with its suite, so this is not reachable by deleting
      // one. It exists so a row that somehow outlives its suite resolves
      // instead of being claimed again on every tick forever.
      await this.fail(run.id, "The benchmark suite this run belongs to is gone.");
      return { runId: run.id, suiteSlug: run.suiteSlug, status: "FAILED", passedCases: 0, totalCases: 0 };
    }
    /*
     * A suite edited while the run waited is refused rather than executed.
     *
     * Executing the new questions under the old revision number would file the
     * result against a document that never asked them, which is the one thing
     * the revision exists to prevent.
     */
    if (suite.revision !== run.suiteRevision) {
      await this.fail(
        run.id,
        `Suite '${run.suiteSlug}' changed from revision ${run.suiteRevision} to ${suite.revision} while this run was queued.`,
      );
      return { runId: run.id, suiteSlug: run.suiteSlug, status: "FAILED", passedCases: 0, totalCases: 0 };
    }

    const cases = parseCases(suite.cases);
    const results: BenchmarkCaseResult[] = [];
    for (const benchmarkCase of cases) {
      // Checked between cases rather than only at the end: a suite is minutes
      // of inference, and an operator who pressed stop should not wait it out.
      if (await this.stopped(run.id, workerId)) {
        await this.recordCancelled(run.id, results, cases.length, workerId);
        return {
          runId: run.id,
          suiteSlug: run.suiteSlug,
          status: "CANCELLED",
          passedCases: results.filter(({ passed }) => passed).length,
          totalCases: cases.length,
        };
      }
      let output: BenchmarkCaseOutput;
      try {
        output = await this.executor.execute(run, benchmarkCase);
      } catch (cause) {
        // One unreachable case is a failed case, not a failed suite: the other
        // thirty-nine still answer the question the operator asked.
        console.error("OrcaSynapse benchmark case failed", run.id, benchmarkCase.id, cause);
        output = {
          text: "",
          citedDocuments: [],
          latencyMs: null,
          outputTokens: null,
          failureReason: "The case could not be executed.",
        };
      }
      results.push(scoreCase(benchmarkCase, output));
      await this.renewLease(run.id, workerId, results, cases.length);
    }

    const passedCases = results.filter(({ passed }) => passed).length;
    await this.complete(run, results, passedCases, workerId);
    return { runId: run.id, suiteSlug: run.suiteSlug, status: "COMPLETED", passedCases, totalCases: results.length };
  }

  /**
   * Whether an operator stopped the run, or another worker took the lease.
   *
   * The lease half needs `leaseOwner`: a stolen lease leaves the row RUNNING,
   * so reading `status` alone detected only the operator half and the
   * dispossessed worker carried on executing the same suite in parallel with
   * its replacement, each overwriting the other's results.
   */
  private async stopped(runId: string, workerId: string): Promise<boolean> {
    const [row] = await this.database
      .select({ status: benchmarkRun.status, leaseOwner: benchmarkRun.leaseOwner })
      .from(benchmarkRun)
      .where(eq(benchmarkRun.id, runId))
      .limit(1);
    return row?.status !== "RUNNING" || row.leaseOwner !== workerId;
  }

  /**
   * Extends the claim and publishes progress after each case.
   *
   * Written as it goes rather than once at the end so a suite that dies at case
   * thirty still shows what the first twenty-nine answered — and so a crash
   * costs the remaining cases rather than all of them.
   */
  private async renewLease(
    runId: string,
    workerId: string,
    results: readonly BenchmarkCaseResult[],
    totalCases: number,
  ): Promise<void> {
    await this.database
      .update(benchmarkRun)
      .set({
        leaseOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs),
        results,
        totalCases,
        passedCases: results.filter(({ passed }) => passed).length,
      })
      // Also matched on the lease owner, so a worker whose claim was stolen
      // cannot quietly take it back and resume writing over the new holder.
      .where(and(
        eq(benchmarkRun.id, runId),
        eq(benchmarkRun.status, "RUNNING"),
        eq(benchmarkRun.leaseOwner, workerId),
      ))
      .catch((cause: unknown) => {
        console.error("OrcaSynapse could not record benchmark progress", runId, cause);
      });
  }

  private async complete(
    run: ClaimedBenchmarkRun,
    results: readonly BenchmarkCaseResult[],
    passedCases: number,
    workerId: string,
  ): Promise<void> {
    const completedAt = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(benchmarkRun)
        .set({
          status: "COMPLETED",
          completedAt,
          results,
          totalCases: results.length,
          passedCases,
          // An empty suite scores zero rather than dividing by nothing. It
          // cannot reach here — the contract requires at least one case — but a
          // NaN written into a score column would outlive the bug that made it.
          passRate: results.length === 0 ? 0 : passedCases / results.length,
          medianLatencyMs: medianLatency(results),
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        // Status *and* ownership, matching `renewLease`. Status alone caught the
        // operator-cancel case but not lease theft: a single-case suite has no
        // top-of-loop check after its case, so a worker that lost its lease
        // mid-case still arrived here, matched on id + RUNNING, and wrote
        // COMPLETED with a full pass rate over the run its replacement owns --
        // which `attachEvidence` then accepts as a PASSED promotion gate.
        .where(and(
          eq(benchmarkRun.id, run.id),
          eq(benchmarkRun.status, "RUNNING"),
          eq(benchmarkRun.leaseOwner, workerId),
        ));
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE",
        actorId: workerId,
        action: "benchmark.run_completed",
        resourceType: "BenchmarkRun",
        resourceId: run.id,
        outcome: "SUCCESS",
        // Counts only. A prompt can quote a customer document, and the trail
        // records that the run happened, not what it asked.
        metadata: {
          suiteSlug: run.suiteSlug,
          suiteRevision: run.suiteRevision,
          kind: run.kind,
          passedCases,
          totalCases: results.length,
        },
      });
    });
  }

  private async recordCancelled(
    runId: string,
    results: readonly BenchmarkCaseResult[],
    totalCases: number,
    workerId: string,
  ): Promise<void> {
    // No pass rate: a suite stopped a third of the way through has a real count
    // of cases that passed, and turning that into a score would answer a
    // different question from the one the suite asks.
    await this.database
      .update(benchmarkRun)
      .set({
        results,
        totalCases,
        passedCases: results.filter(({ passed }) => passed).length,
        medianLatencyMs: medianLatency(results),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      // Guarded like every other write here. `stopped()` now reports true when
      // another worker takes the lease, which routes the dispossessed worker
      // through this method -- and unguarded it would null the new holder's
      // lease and overwrite its results with a partial set, handing the run to
      // a third worker. That is the outcome the lease check exists to prevent.
      // Matched on the lease alone, deliberately. Both reasons `stopped()`
      // fires land here, and they need opposite treatment: an operator cancel
      // has already set status away from RUNNING but the lease is still ours,
      // and the partial results are worth keeping; a stolen lease leaves status
      // RUNNING but the row belongs to another worker, and writing to it would
      // null its lease and overwrite its results. Ownership is what separates
      // them -- a status guard would silently discard every cancelled run's
      // scores instead.
      .where(and(eq(benchmarkRun.id, runId), eq(benchmarkRun.leaseOwner, workerId)));
  }

  private async fail(runId: string, message: string): Promise<void> {
    await this.database
      .update(benchmarkRun)
      .set({
        status: "FAILED",
        completedAt: new Date(),
        failureMessage: message.slice(0, 1_000),
        // Reset, so a refused run never reads as a suite that scored zero.
        totalCases: 0,
        passedCases: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(benchmarkRun.id, runId))
      .catch((cause: unknown) => {
        console.error("OrcaSynapse could not record a failed benchmark run", runId, cause);
      });
  }
}

/**
 * Cases are read back through the contract rather than trusted.
 *
 * A malformed case is dropped rather than scored: an assertion that cannot be
 * parsed would never fire, and a check that never fires reads as a pass.
 */
function parseCases(value: unknown): BenchmarkCase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = benchmarkCaseSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}
