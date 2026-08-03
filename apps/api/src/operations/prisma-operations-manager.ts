import {
  RUNTIME_WORKLOAD_NAMES,
  type RuntimeOperationsSnapshot,
  type RuntimeExecutorSnapshot,
  type RuntimeWorkloadName,
} from "@orcasynapse/contracts";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import type { OperationsManager } from "./operations-manager.js";

const STALE_AFTER_MS = 45_000;
const VISIBLE_EXECUTOR_HISTORY_MS = 24 * 60 * 60 * 1_000;
const EXECUTOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function count(groups: Array<{ status: string; _count: { _all: number } }>, statuses: string[]): number {
  return groups.filter(({ status }) => statuses.includes(status)).reduce((sum, item) => sum + item._count._all, 0);
}

function isWorkload(value: string): value is RuntimeWorkloadName {
  return (RUNTIME_WORKLOAD_NAMES as readonly string[]).includes(value);
}

export class PrismaOperationsManager implements OperationsManager {
  constructor(private readonly prisma: OrcaSynapsePrismaClient) {}

  async start(): Promise<void> {
    await this.prisma.workerNode.deleteMany({
      where: { lastSeenAt: { lt: new Date(Date.now() - EXECUTOR_RETENTION_MS) } },
    });
  }

  async stop(): Promise<void> {}

  async snapshot(): Promise<RuntimeOperationsSnapshot> {
    const capturedAt = new Date();
    const [agentGroups, executorRecords] = await Promise.all([
      this.prisma.agentRun.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.workerNode.findMany({
        where: { lastSeenAt: { gte: new Date(capturedAt.getTime() - VISIBLE_EXECUTOR_HISTORY_MS) } },
        orderBy: { lastSeenAt: "desc" },
        take: 50,
      }),
    ]);
    const executors: RuntimeExecutorSnapshot[] = executorRecords.map((executor) => {
      const stale = executor.status === "ONLINE" && capturedAt.getTime() - executor.lastSeenAt.getTime() > STALE_AFTER_MS;
      return {
        id: executor.id,
        name: executor.name,
        status: executor.status === "STOPPED" ? "STOPPED" : stale ? "STALE" : "ONLINE",
        startedAt: executor.startedAt.toISOString(),
        lastSeenAt: executor.lastSeenAt.toISOString(),
        version: executor.version,
        workloads: executor.workloads.filter(isWorkload),
      };
    });
    const workloads = [
      {
        name: "hermes-runs" as const, displayName: "Hermes Agent Runs",
        pendingCount: count(agentGroups, ["QUEUED", "CANCEL_REQUESTED"]), activeCount: count(agentGroups, ["RUNNING"]),
        failedCount: count(agentGroups, ["FAILED", "TIMED_OUT", "DENIED"]), totalCount: count(agentGroups, agentGroups.map(({ status }) => status)),
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
