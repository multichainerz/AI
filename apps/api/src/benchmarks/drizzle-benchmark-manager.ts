import {
  benchmarkCaseSchema,
  type BenchmarkCase,
  type BenchmarkCaseResult,
  type BenchmarkKind,
  type BenchmarkRun,
  type BenchmarkRunList,
  type BenchmarkSuite,
  type BenchmarkSuiteList,
  type CreateBenchmarkSuite,
  type StartBenchmarkRun,
  type UpdateBenchmarkSuite,
} from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  auditEvent,
  benchmarkRun,
  benchmarkSuite,
  document,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { APPROVED_EMBEDDING_MODEL } from "@orcasynapse/knowledge";
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, isUniqueViolation } from "../database-support.js";
import {
  BenchmarkRunNotFoundError,
  BenchmarkSuiteConflictError,
  BenchmarkSuiteNotFoundError,
  BenchmarkTargetUnavailableError,
  type BenchmarkManager,
} from "./benchmark-manager.js";

const DEFAULT_RUN_PAGE = 50;

/** The handle a `database.transaction` callback receives. */
type Transaction = Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0];

interface StoredSuite {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  kind: BenchmarkKind;
  cases: unknown;
  passThreshold: number;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredRun {
  id: string;
  suiteId: string;
  suiteSlug: string;
  suiteRevision: number;
  kind: BenchmarkKind;
  status: BenchmarkRun["status"];
  agentProfileId: string | null;
  agentProfileSlug: string | null;
  agentProfileVersion: number | null;
  modelAlias: string | null;
  ownerSubject: string;
  totalCases: number;
  passedCases: number;
  passRate: number | null;
  medianLatencyMs: number | null;
  results: unknown;
  failureMessage: string | null;
  evaluationRunId: string | null;
  requestedBy: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Cases are read back through the contract rather than trusted.
 *
 * They are JSONB, so the shape a run executes is whatever was written — and a
 * case that fails to parse must be dropped loudly rather than scored, because a
 * malformed assertion that silently never fires reads as a pass.
 */
function parseCases(value: unknown): BenchmarkCase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = benchmarkCaseSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseResults(value: unknown): BenchmarkCaseResult[] {
  return Array.isArray(value) ? value as BenchmarkCaseResult[] : [];
}

function suiteDto(suite: StoredSuite): BenchmarkSuite {
  return {
    id: suite.id,
    slug: suite.slug,
    displayName: suite.displayName,
    description: suite.description,
    kind: suite.kind,
    cases: parseCases(suite.cases),
    passThreshold: suite.passThreshold,
    revision: suite.revision,
    createdBy: suite.createdBy,
    updatedBy: suite.updatedBy,
    createdAt: suite.createdAt.toISOString(),
    updatedAt: suite.updatedAt.toISOString(),
  };
}

function runDto(run: StoredRun): BenchmarkRun {
  return {
    id: run.id,
    suiteId: run.suiteId,
    suiteSlug: run.suiteSlug,
    suiteRevision: run.suiteRevision,
    kind: run.kind,
    status: run.status,
    target: {
      agentProfileId: run.agentProfileId,
      agentProfileSlug: run.agentProfileSlug,
      agentProfileVersion: run.agentProfileVersion,
      modelAlias: run.modelAlias,
      ownerSubject: run.ownerSubject,
    },
    totalCases: run.totalCases,
    passedCases: run.passedCases,
    passRate: run.passRate,
    medianLatencyMs: run.medianLatencyMs,
    results: parseResults(run.results),
    failureMessage: run.failureMessage,
    evaluationRunId: run.evaluationRunId,
    requestedBy: run.requestedBy,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/** The statuses a run occupies before it has an answer. */
const IN_FLIGHT = ["QUEUED", "RUNNING"] as const;

export class DrizzleBenchmarkManager implements BenchmarkManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async listSuites(): Promise<BenchmarkSuiteList> {
    const rows = await this.database
      .select()
      .from(benchmarkSuite)
      .orderBy(asc(benchmarkSuite.slug));
    return { items: rows.map((row) => suiteDto(row as StoredSuite)) };
  }

  async createSuite(principal: AdminPrincipal, input: CreateBenchmarkSuite): Promise<BenchmarkSuite> {
    try {
      const created = await this.database.transaction(async (transaction) => {
        const [row] = await transaction
          .insert(benchmarkSuite)
          .values({
            slug: input.slug,
            displayName: input.displayName,
            description: input.description,
            kind: input.kind,
            cases: input.cases,
            passThreshold: input.passThreshold,
            createdBy: principal.id,
            updatedBy: principal.id,
          })
          .returning();
        if (!row) throw new BenchmarkSuiteConflictError("The benchmark suite could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "benchmark.suite_created",
          resourceType: "BenchmarkSuite",
          resourceId: row.id,
          outcome: "SUCCESS",
          // Counts, never the prompts: a case can quote a customer document.
          metadata: { slug: input.slug, kind: input.kind, cases: input.cases.length },
        });
        return row;
      });
      return suiteDto(created as StoredSuite);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BenchmarkSuiteConflictError(`A benchmark suite named '${input.slug}' already exists.`);
      }
      throw error;
    }
  }

  /**
   * Edits a suite, bumping the revision only when what it executes changes.
   *
   * The revision exists so a run can say which document it scored, so it has to
   * move when the cases or the pass threshold move. It deliberately does not
   * move for a renamed suite or a corrected description: those change nothing
   * about the result, and bumping would invalidate a run already queued against
   * the same questions.
   */
  async updateSuite(
    principal: AdminPrincipal,
    id: string,
    input: UpdateBenchmarkSuite,
  ): Promise<BenchmarkSuite> {
    const updated = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`benchmark-suite:${id}`));
      const [existing] = await transaction
        .select()
        .from(benchmarkSuite)
        .where(eq(benchmarkSuite.id, id))
        .limit(1);
      if (!existing) throw new BenchmarkSuiteNotFoundError("The benchmark suite does not exist.");
      if (existing.revision !== input.expectedRevision) {
        throw new BenchmarkSuiteConflictError("The benchmark suite changed; reload before editing it again.");
      }

      const executionChanged = input.cases !== undefined
        || (input.passThreshold !== undefined && input.passThreshold !== existing.passThreshold);
      const [row] = await transaction
        .update(benchmarkSuite)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.cases !== undefined ? { cases: input.cases } : {}),
          ...(input.passThreshold !== undefined ? { passThreshold: input.passThreshold } : {}),
          ...(executionChanged ? { revision: existing.revision + 1 } : {}),
          updatedBy: principal.id,
        })
        .where(and(eq(benchmarkSuite.id, id), eq(benchmarkSuite.revision, input.expectedRevision)))
        .returning();
      if (!row) throw new BenchmarkSuiteConflictError("The benchmark suite changed; reload before editing it again.");
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "benchmark.suite_updated",
        resourceType: "BenchmarkSuite",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { revision: row.revision, executionChanged },
      });
      return row;
    });
    return suiteDto(updated as StoredSuite);
  }

  /**
   * Deletes a suite, unless doing so would remove an answer someone relied on.
   *
   * The run rows cascade, which is right for a suite authored by mistake and
   * wrong for one whose result a promotion cited. So a suite with a run
   * attached to an evaluation is kept, and so is one with a run still going,
   * whose row the worker is in the middle of writing.
   */
  async deleteSuite(principal: AdminPrincipal, id: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ id: benchmarkSuite.id, slug: benchmarkSuite.slug })
        .from(benchmarkSuite)
        .where(eq(benchmarkSuite.id, id))
        .limit(1);
      if (!existing) throw new BenchmarkSuiteNotFoundError("The benchmark suite does not exist.");

      const [cited] = await transaction
        .select({ total: count() })
        .from(benchmarkRun)
        .where(and(eq(benchmarkRun.suiteId, id), isNotNull(benchmarkRun.evaluationRunId)));
      if ((cited?.total ?? 0) > 0) {
        throw new BenchmarkSuiteConflictError(
          "This suite has results attached to an evaluation and cannot be deleted.",
        );
      }
      const [active] = await transaction
        .select({ total: count() })
        .from(benchmarkRun)
        .where(and(eq(benchmarkRun.suiteId, id), inArray(benchmarkRun.status, [...IN_FLIGHT])));
      if ((active?.total ?? 0) > 0) {
        throw new BenchmarkSuiteConflictError("Stop the run in progress before deleting this suite.");
      }

      await transaction.delete(benchmarkSuite).where(eq(benchmarkSuite.id, id));
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "benchmark.suite_deleted",
        resourceType: "BenchmarkSuite",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { slug: existing.slug },
      });
    });
  }

  async startRun(principal: AdminPrincipal, input: StartBenchmarkRun): Promise<BenchmarkRun> {
    const queued = await this.database.transaction(async (transaction) => {
      const [suite] = await transaction
        .select()
        .from(benchmarkSuite)
        .where(eq(benchmarkSuite.id, input.suiteId))
        .limit(1);
      if (!suite) throw new BenchmarkSuiteNotFoundError("The benchmark suite does not exist.");

      // One run of a suite at a time. A second against the same target is the
      // same questions to the same model, and on a host that answers one at a
      // time it only makes both slower.
      const [active] = await transaction
        .select({ total: count() })
        .from(benchmarkRun)
        .where(and(eq(benchmarkRun.suiteId, suite.id), inArray(benchmarkRun.status, [...IN_FLIGHT])));
      if ((active?.total ?? 0) > 0) {
        throw new BenchmarkSuiteConflictError("This suite already has a run waiting or in progress.");
      }

      const target = await this.resolveTarget(transaction, suite.kind, input.agentProfileId ?? null);
      const cases = parseCases(suite.cases);
      const [row] = await transaction
        .insert(benchmarkRun)
        .values({
          suiteId: suite.id,
          suiteSlug: suite.slug,
          suiteRevision: suite.revision,
          kind: suite.kind,
          status: "QUEUED",
          ...target,
          ownerSubject: principal.subject,
          totalCases: cases.length,
          requestedBy: principal.id,
        })
        .returning();
      if (!row) throw new BenchmarkSuiteConflictError("The benchmark run could not be queued.");
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "benchmark.run_queued",
        resourceType: "BenchmarkRun",
        resourceId: row.id,
        outcome: "SUCCESS",
        metadata: {
          suiteSlug: suite.slug,
          suiteRevision: suite.revision,
          kind: suite.kind,
          cases: cases.length,
          agentProfileId: target.agentProfileId,
          modelAlias: target.modelAlias,
        },
      });
      return row;
    });
    return runDto(queued as StoredRun);
  }

  /**
   * Works out what the run will measure, or refuses to queue it.
   *
   * Every branch here answers the same question: is there something to score?
   * Queuing without one produces a completed run at 0%, which enters the
   * history as a regression the model never caused — so the failure has to
   * happen now, in front of the operator who can fix it.
   */
  private async resolveTarget(
    transaction: Transaction,
    kind: BenchmarkKind,
    requestedProfileId: string | null,
  ): Promise<{
    agentProfileId: string | null;
    agentProfileSlug: string | null;
    agentProfileVersion: number | null;
    modelAlias: string | null;
  }> {
    if (kind === "RETRIEVAL") {
      const [indexed] = await transaction
        .select({ total: count() })
        .from(document)
        .where(eq(document.status, "READY"));
      if ((indexed?.total ?? 0) === 0) {
        throw new BenchmarkTargetUnavailableError(
          "No indexed document to retrieve from. Upload and index knowledge before running a retrieval benchmark.",
        );
      }
      // The embedding model, not the chat model: retrieval scores move when the
      // vectors change, and that is the thing whose change explains them.
      return {
        agentProfileId: null,
        agentProfileSlug: null,
        agentProfileVersion: null,
        modelAlias: APPROVED_EMBEDDING_MODEL,
      };
    }

    const candidates = await transaction
      .select({
        id: agentProfile.id,
        slug: agentProfile.slug,
        version: agentProfileVersion.version,
        modelAlias: agentProfileVersion.modelAlias,
      })
      .from(agentProfile)
      .innerJoin(agentProfileVersion, and(
        eq(agentProfileVersion.profileId, agentProfile.id),
        eq(agentProfileVersion.version, agentProfile.activeVersion),
      ))
      .where(and(
        eq(agentProfile.status, "ACTIVE"),
        ...(requestedProfileId ? [eq(agentProfile.id, requestedProfileId)] : []),
      ))
      .orderBy(asc(agentProfile.slug))
      .limit(3);

    const chosen = candidates[0];
    if (!chosen) {
      throw new BenchmarkTargetUnavailableError(
        requestedProfileId
          ? "That agent is not active, so there is nothing to benchmark."
          : "No active agent to benchmark. Activate an agent profile first.",
      );
    }
    // Naming the agent is the operator's call, not a coin toss. A result whose
    // subject was chosen arbitrarily cannot be compared with the next one.
    if (!requestedProfileId && candidates.length > 1) {
      throw new BenchmarkTargetUnavailableError(
        "Several agents are active. Choose which one this run should measure.",
      );
    }
    return {
      agentProfileId: chosen.id,
      agentProfileSlug: chosen.slug,
      agentProfileVersion: chosen.version,
      modelAlias: chosen.modelAlias,
    };
  }

  async listRuns(suiteId?: string, limit?: number): Promise<BenchmarkRunList> {
    const rows = await this.database
      .select()
      .from(benchmarkRun)
      .where(suiteId ? eq(benchmarkRun.suiteId, suiteId) : undefined)
      .orderBy(desc(benchmarkRun.queuedAt))
      .limit(limit ?? DEFAULT_RUN_PAGE);
    return { items: rows.map((row) => runDto(row as StoredRun)) };
  }

  async getRun(id: string): Promise<BenchmarkRun> {
    const [row] = await this.database
      .select()
      .from(benchmarkRun)
      .where(eq(benchmarkRun.id, id))
      .limit(1);
    if (!row) throw new BenchmarkRunNotFoundError("The benchmark run does not exist.");
    return runDto(row as StoredRun);
  }

  /**
   * Stops a run, leaving whatever it had already scored.
   *
   * CANCELLED rather than COMPLETED, and no pass rate: a suite stopped a third
   * of the way through has a real count of cases that passed, and turning that
   * into a score would put a number in the history that answers a different
   * question from the one the suite asks.
   */
  async cancelRun(principal: AdminPrincipal, id: string): Promise<BenchmarkRun> {
    const cancelled = await this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(benchmarkRun)
        .set({ status: "CANCELLED", completedAt: new Date() })
        .where(and(eq(benchmarkRun.id, id), inArray(benchmarkRun.status, [...IN_FLIGHT])))
        .returning();
      if (!row) {
        const [existing] = await transaction
          .select({ status: benchmarkRun.status })
          .from(benchmarkRun)
          .where(eq(benchmarkRun.id, id))
          .limit(1);
        if (!existing) throw new BenchmarkRunNotFoundError("The benchmark run does not exist.");
        throw new BenchmarkSuiteConflictError("This run has already finished.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "benchmark.run_cancelled",
        resourceType: "BenchmarkRun",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { suiteSlug: row.suiteSlug, passedCases: row.passedCases, totalCases: row.totalCases },
      });
      return row;
    });
    return runDto(cancelled as StoredRun);
  }
}
