import {
  RUNTIME_WORKLOAD_NAMES,
  type RuntimeOperationsSnapshot,
  type RuntimeExecutorSnapshot,
  type RuntimeWorkloadName,
} from "@orcasynapse/contracts";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { agentRun, workerNode, type OrcaSynapseDatabase } from "@orcasynapse/database";
import type { OperationsManager } from "./operations-manager.js";

const STALE_AFTER_MS = 45_000;
/** How often a dead executor is reaped without anyone watching the dashboard. */
const RECONCILE_INTERVAL_MS = 30_000;
const VISIBLE_EXECUTOR_HISTORY_MS = 24 * 60 * 60 * 1_000;
const EXECUTOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
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
