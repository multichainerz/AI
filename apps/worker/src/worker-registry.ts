import { and, asc, eq, inArray, isNull, isNotNull, lt, notInArray, or } from "drizzle-orm";
import { agentRun, workerNode, type OrcaSynapseDatabase } from "@orcasynapse/database";
import { PROCESSOR_ELIGIBLE_STATUSES } from "./agent-processor.js";

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
          /*
           * The processor's own list, not a second one that agrees with it by
           * hand. This carried `WAITING_FOR_APPROVAL` as well, on the reasoning
           * that it is durable state rather than a transient in-process phase
           * and that omitting it stranded a run whose worker restarted while an
           * approval was outstanding -- true of the status, but offering it
           * here never rescued anything: `process` refuses it before taking a
           * lease, so every reconcile tick claimed the same run and discarded
           * it again. A run that outlives its own timeout with nobody executing
           * it is ended server-side instead, by the abandoned-run reconcile in
           * the API's DrizzleOperationsManager, which does cover that status.
           */
          inArray(agentRun.status, [...PROCESSOR_ELIGIBLE_STATUSES]),
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
