import {
  AGENT_RUN_ENDED_EVENT_TYPE,
  RUNTIME_WORKLOAD_NAMES,
  type RuntimeOperationsSnapshot,
  type RuntimeExecutorSnapshot,
  type RuntimeWorkloadName,
} from "@orcasynapse/contracts";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  agentProfileVersion,
  agentRun,
  agentRunApproval,
  agentRunEvent,
  auditEvent,
  chatMessage,
  chatRunWakeStatement,
  workerNode,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { OperationsManager } from "./operations-manager.js";

const STALE_AFTER_MS = 45_000;
/** How often a dead executor is reaped without anyone watching the dashboard. */
const RECONCILE_INTERVAL_MS = 30_000;
const VISIBLE_EXECUTOR_HISTORY_MS = 24 * 60 * 60 * 1_000;
const EXECUTOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * The statuses a run can hold with work still owed on it.
 *
 * Wider than the worker's own eligible list on purpose. `WAITING_FOR_APPROVAL`
 * is unreachable through a native Hermes session and no worker will execute it,
 * which is exactly why a row that somehow holds it has to be endable from here:
 * the dispatcher no longer offers it, so nothing else would ever end it.
 */
const UNFINISHED_RUN_STATUSES = ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"] as const;

/**
 * How long past a lapsed lease a run counts as nobody's.
 *
 * A worker renews every 30s against a 90s lease, and the renewal matches on
 * owner and status rather than on expiry -- so a worker whose event loop stalls
 * lets the lease lapse and then renews it successfully and carries on. Ending a
 * run the moment its lease expired would take it from a worker that is about to
 * answer it. One further lease period is the margin, on top of the guarded
 * update below, which is what actually makes the race safe.
 *
 * Compared against a JavaScript clock deliberately, because a JavaScript clock
 * wrote the column. The deadline below compares database-written timestamps
 * against the database clock for the same reason.
 */
const ABANDONED_LEASE_GRACE_MS = 90_000;

/** A ceiling on one pass, so a backlog cannot hold a transaction-heavy tick open. */
const ABANDONED_RUN_BATCH = 100;

/**
 * FAILED, and abandoned rather than timed out.
 *
 * `TIMED_OUT` is the worker's word for a run that used its whole budget, which
 * asserts an agent was working the entire time; here nothing was. `CANCELLED`
 * is no better for a run left in CANCEL_REQUESTED, because claiming a clean
 * cancellation says a runtime acted on the request, and none did -- the request
 * simply outlived the fleet. One honest outcome for all four statuses, with the
 * code the chat manager already uses when it clears a stale pending turn.
 */
const ABANDONED_FAILURE_CODE = "HERMES_RUN_ABANDONED";
const ABANDONED_FAILURE_MESSAGE = "The configured agent timeout elapsed with no runtime executor holding this run.";

function count(groups: Array<{ status: string; total: number }>, statuses: string[]): number {
  return groups.filter(({ status }) => statuses.includes(status)).reduce((sum, item) => sum + item.total, 0);
}

function isWorkload(value: string): value is RuntimeWorkloadName {
  return (RUNTIME_WORKLOAD_NAMES as readonly string[]).includes(value);
}

function workloadNames(value: unknown): RuntimeWorkloadName[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").filter(isWorkload) : [];
}

export class DrizzleOperationsManager implements OperationsManager {
  private reconcileTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly reconcileIntervalMs = RECONCILE_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    await this.database
      .delete(workerNode)
      .where(lt(workerNode.lastSeenAt, new Date(Date.now() - EXECUTOR_RETENTION_MS)));
    // A dead executor cannot mark itself stopped, and reconciliation used to run
    // only when a snapshot was requested - so an unattended installation kept
    // reporting a dead worker as ONLINE until somebody opened the dashboard.
    //
    // The run sweep rides the same timer for the same reason, and deliberately
    // not on `snapshot`: ending somebody's run is not a side effect a reader
    // should trigger by opening a screen. Both are caught here because an
    // unhandled rejection from a timer callback ends the API process, and a
    // database that blipped for one tick has to cost a tick, not the server.
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch(() => undefined);
      void this.reconcileAbandonedRuns().catch(() => undefined);
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  /** Marks executors stopped once their heartbeat has gone stale. */
  async reconcile(): Promise<number> {
    const stopped = await this.database
      .update(workerNode)
      .set({ status: "STOPPED" })
      .where(and(
        eq(workerNode.status, "ONLINE"),
        lt(workerNode.lastSeenAt, new Date(Date.now() - STALE_AFTER_MS)),
      ))
      .returning({ id: workerNode.id });
    return stopped.length;
  }

  /**
   * Ends runs that outlived their own timeout with no worker executing them.
   *
   * The worker's poll loop is the only thing that enforces `timeoutSeconds`,
   * and it can only enforce it for a run it is holding. So a fleet that is down
   * when a message is sent, or a worker that dies before claiming a queued run,
   * left the run with no terminal status forever: no `RUN_ENDED` marker is
   * written, the chat subscriber never ends, the browser counts seconds, and
   * the conversation refuses every further message for as long as its assistant
   * row stays PENDING. Pressing Stop only deepened it, because
   * `CANCEL_REQUESTED` is a status only a worker can clear.
   *
   * The deadline is the run's own: a run never claimed is timed from `queuedAt`
   * -- which is what the reader has been watching -- and a run that started is
   * timed from `startedAt`, the same instant the worker's loop uses.
   */
  async reconcileAbandonedRuns(): Promise<number> {
    const abandonedBefore = new Date(Date.now() - ABANDONED_LEASE_GRACE_MS);
    const abandoned = await this.database
      .select({ id: agentRun.id, status: agentRun.status })
      .from(agentRun)
      .innerJoin(agentProfileVersion, eq(agentProfileVersion.id, agentRun.profileVersionId))
      .where(and(
        inArray(agentRun.status, [...UNFINISHED_RUN_STATUSES]),
        or(isNull(agentRun.processorLeaseExpiresAt), lt(agentRun.processorLeaseExpiresAt, abandonedBefore)),
        sql`COALESCE(${agentRun.startedAt}, ${agentRun.queuedAt})
          + (${agentProfileVersion.timeoutSeconds} * INTERVAL '1 second') < CURRENT_TIMESTAMP`,
      ))
      .orderBy(asc(agentRun.queuedAt))
      .limit(ABANDONED_RUN_BATCH);

    let ended = 0;
    for (const run of abandoned) {
      if (await this.endAbandonedRun(run.id, run.status, abandonedBefore)) ended += 1;
    }
    return ended;
  }

  /**
   * Finalises one abandoned run, to the same standard the worker's finaliser holds.
   *
   * The guarded update comes first and everything else depends on it having
   * matched, so the `RUN_ENDED` marker is written inside the transaction that
   * flips the status and can never land on its own -- a marker without the flip
   * would end every subscriber's stream on a run that is still live.
   *
   * The lease condition is what makes this safe against a worker, and against
   * a second API instance running the same sweep. A worker that claimed the row
   * between the scan and here has moved the lease, so this update matches
   * nothing; and if this commits first, that worker's own claim finds a
   * terminal status and skips. Either way exactly one finaliser writes.
   */
  private async endAbandonedRun(runId: string, previousStatus: string, abandonedBefore: Date): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const completedAt = new Date();
      const ended = await transaction
        .update(agentRun)
        .set({
          status: "FAILED",
          failureCode: ABANDONED_FAILURE_CODE,
          failureMessage: ABANDONED_FAILURE_MESSAGE,
          completedAt,
          toolCapabilityTokenHash: null,
          toolCapabilityExpiresAt: null,
          processorLeaseOwner: null,
          processorLeaseExpiresAt: null,
        })
        .where(and(
          eq(agentRun.id, runId),
          inArray(agentRun.status, [...UNFINISHED_RUN_STATUSES]),
          or(isNull(agentRun.processorLeaseExpiresAt), lt(agentRun.processorLeaseExpiresAt, abandonedBefore)),
        ))
        .returning({ id: agentRun.id });
      if (ended.length !== 1) return false;

      await transaction
        .update(chatMessage)
        .set({ status: "FAILED", errorCode: ABANDONED_FAILURE_CODE, completedAt })
        .where(and(eq(chatMessage.agentRunId, runId), eq(chatMessage.status, "PENDING")));
      // EXPIRED rather than DENIED: nobody decided this, and nobody could have.
      await transaction
        .update(agentRunApproval)
        .set({ status: "EXPIRED" })
        .where(and(eq(agentRunApproval.runId, runId), eq(agentRunApproval.status, "PENDING")));
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE",
        actorId: null,
        action: "agent.run_abandoned",
        resourceType: "AgentRun",
        resourceId: runId,
        outcome: "FAILURE",
        metadata: { failureCode: ABANDONED_FAILURE_CODE, previousStatus, reconciliation: "ABANDONED_RUN_SWEEP" },
      });

      const [streamed] = await transaction.execute<{ offset: string }>(sql`
        SELECT char_length("partialOutput") AS "offset" FROM "AgentRun" WHERE "id" = ${runId}::uuid
      `).then((result) => result.rows);
      // The marker, and deliberately no `lastEventCursor` update with it: a
      // reader resuming from that cursor has to meet the marker again and be
      // told the outcome again, or a reconnect after the end is a silent stream.
      await transaction.insert(agentRunEvent).values({
        runId,
        type: AGENT_RUN_ENDED_EVENT_TYPE,
        summary: ABANDONED_FAILURE_MESSAGE,
        status: "FAILED",
        errorCode: ABANDONED_FAILURE_CODE,
        contentOffset: streamed ? Number(streamed.offset) : null,
        occurredAt: completedAt,
      });
      await transaction.execute(chatRunWakeStatement(runId));
      return true;
    });
  }

  async snapshot(): Promise<RuntimeOperationsSnapshot> {
    const capturedAt = new Date();
    await this.reconcile();

    const [agentGroups, executorRecords] = await Promise.all([
      this.database
        .select({ status: agentRun.status, total: sql<number>`count(*)::int` })
        .from(agentRun)
        .groupBy(agentRun.status),
      this.database
        .select()
        .from(workerNode)
        .where(gte(workerNode.lastSeenAt, new Date(capturedAt.getTime() - VISIBLE_EXECUTOR_HISTORY_MS)))
        .orderBy(desc(workerNode.lastSeenAt))
        .limit(50),
    ]);

    const executors: RuntimeExecutorSnapshot[] = executorRecords.map((executor) => {
      const stale =
        executor.status === "ONLINE" && capturedAt.getTime() - executor.lastSeenAt.getTime() > STALE_AFTER_MS;
      return {
        id: executor.id,
        name: executor.name,
        status: executor.status === "STOPPED" ? "STOPPED" : stale ? "STALE" : "ONLINE",
        startedAt: executor.startedAt.toISOString(),
        lastSeenAt: executor.lastSeenAt.toISOString(),
        version: executor.version,
        workloads: workloadNames(executor.workloads),
      };
    });

    const workloads = [
      {
        name: "hermes-runs" as const,
        displayName: "Hermes Agent Runs",
        pendingCount: count(agentGroups, ["QUEUED", "CANCEL_REQUESTED"]),
        activeCount: count(agentGroups, ["RUNNING"]),
        failedCount: count(agentGroups, ["FAILED", "TIMED_OUT", "DENIED"]),
        totalCount: count(agentGroups, agentGroups.map(({ status }) => status)),
      },
    ];

    const hasOnlineExecutor = executors.some(({ status }) => status === "ONLINE");
    const statusReasons = hasOnlineExecutor ? [] : ["No online PostgreSQL runtime executor heartbeat is available."];

    return {
      engine: "postgresql-state",
      status: statusReasons.length ? "DEGRADED" : "ONLINE",
      statusReasons,
      workloads,
      executors,
      capturedAt: capturedAt.toISOString(),
    };
  }
}
