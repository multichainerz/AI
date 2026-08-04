import { and, asc, eq, inArray, isNull, isNotNull, lt, notInArray, or } from "drizzle-orm";
import { agentRun, workerNode, type OrcaSynapseDatabase } from "@orcasynapse/database";

export interface WorkerIdentity {
  id: string;
  name: string;
  version: string;
  workloads: string[];
}

export interface WorkerRegistry {
  markStarted(identity: WorkerIdentity): Promise<void>;
  markAlive(id: string): Promise<void>;
  markStopped(id: string): Promise<void>;
}

export interface PendingRun {
  id: string;
  jobId: string;
}

/**
 * Supplies runs no worker currently holds a lease on.
 *
 * Separating this from WorkerRuntime keeps scheduling - slot accounting and
 * shutdown draining - testable without a database, and confines the query that
 * decides what is claimable to one place covered against real PostgreSQL.
 */
export interface PendingRunSource {
  claimable(limit: number, excludeIds: string[]): Promise<PendingRun[]>;
}

export class DrizzleWorkerRegistry implements WorkerRegistry {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async markStarted(identity: WorkerIdentity): Promise<void> {
    const now = new Date();
    await this.database
      .insert(workerNode)
      .values({
        id: identity.id,
        name: identity.name,
        version: identity.version,
        status: "ONLINE",
        workloads: identity.workloads,
        metadata: {},
        startedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: workerNode.id,
        set: {
          name: identity.name,
          version: identity.version,
          status: "ONLINE",
          workloads: identity.workloads,
          startedAt: now,
          lastSeenAt: now,
          stoppedAt: null,
        },
      });
  }

  async markAlive(id: string): Promise<void> {
    await this.database
      .update(workerNode)
      .set({ status: "ONLINE", lastSeenAt: new Date(), stoppedAt: null })
      .where(eq(workerNode.id, id));
  }

  async markStopped(id: string): Promise<void> {
    const now = new Date();
    await this.database
      .update(workerNode)
      .set({ status: "STOPPED", lastSeenAt: now, stoppedAt: now })
      .where(eq(workerNode.id, id));
  }
}

export class DrizzlePendingRunSource implements PendingRunSource {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async claimable(limit: number, excludeIds: string[]): Promise<PendingRun[]> {
    if (limit <= 0) return [];
    const rows = await this.database
      .select({ id: agentRun.id, jobId: agentRun.jobId })
      .from(agentRun)
      .where(
        and(
          isNotNull(agentRun.jobId),
          // WAITING_FOR_APPROVAL is durable state, not a transient in-process
          // phase. Omitting it stranded any run whose worker restarted while an
          // approval was outstanding.
          inArray(agentRun.status, ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"]),
          ...(excludeIds.length > 0 ? [notInArray(agentRun.id, excludeIds)] : []),
          or(
            isNull(agentRun.processorLeaseExpiresAt),
            lt(agentRun.processorLeaseExpiresAt, new Date()),
          ),
        ),
      )
      .orderBy(asc(agentRun.queuedAt))
      .limit(limit);

    return rows.flatMap((row) => (row.jobId ? [{ id: row.id, jobId: row.jobId }] : []));
  }
}
