import {
  jobQueueNameSchema,
  type JobOperationsSnapshot,
  type JobProbeResult,
  type JobQueueName,
  type WorkerNodeSnapshot,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import type { JobQueueSnapshot } from "@aihub/contracts";
import type { OperationsManager } from "./operations-manager.js";
import type { AdminActor } from "../connections/connection-manager.js";

export interface JobQueueOperations {
  start(options?: { ensureQueues?: boolean }): Promise<void>;
  stop(): Promise<void>;
  snapshot(): Promise<JobQueueSnapshot[]>;
  sendSystemProbe(payload: { requestedAt: string; requestedBy: string }): Promise<string>;
  retry(name: JobQueueName, jobId: string): Promise<void>;
  redriveDeadLetters(limit?: number): Promise<number>;
}

const STALE_AFTER_MS = 45_000;
const VISIBLE_WORKER_HISTORY_MS = 24 * 60 * 60 * 1_000;
const WORKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class PrismaOperationsManager implements OperationsManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly queue: JobQueueOperations,
  ) {}

  async start(): Promise<void> {
    await this.prisma.workerNode.deleteMany({
      where: { lastSeenAt: { lt: new Date(Date.now() - WORKER_RETENTION_MS) } },
    });
    await this.queue.start();
  }

  async stop(): Promise<void> {
    await this.queue.stop();
  }

  async snapshot(): Promise<JobOperationsSnapshot> {
    const capturedAt = new Date();
    const [queues, workerRecords] = await Promise.all([
      this.queue.snapshot(),
      this.prisma.workerNode.findMany({
        where: {
          lastSeenAt: { gte: new Date(capturedAt.getTime() - VISIBLE_WORKER_HISTORY_MS) },
        },
        orderBy: { lastSeenAt: "desc" },
        take: 50,
      }),
    ]);
    const workers: WorkerNodeSnapshot[] = workerRecords.map((worker) => {
      const isStale =
        worker.status === "ONLINE" &&
        capturedAt.getTime() - worker.lastSeenAt.getTime() > STALE_AFTER_MS;
      const queues = worker.queues.flatMap((name) => {
        const parsed = jobQueueNameSchema.safeParse(name);
        return parsed.success ? [parsed.data] : [];
      });
      return {
        id: worker.id,
        name: worker.name,
        status: worker.status === "STOPPED" ? "STOPPED" : isStale ? "STALE" : "ONLINE",
        startedAt: worker.startedAt.toISOString(),
        lastSeenAt: worker.lastSeenAt.toISOString(),
        version: worker.version,
        queues,
      };
    });
    const hasOnlineWorker = workers.some(({ status }) => status === "ONLINE");
    const missingQueues = queues.filter(({ configured }) => !configured);
    const onlineWorkerQueues = new Set(
      workers
        .filter(({ status }) => status === "ONLINE")
        .flatMap(({ queues: workerQueues }) => workerQueues),
    );
    const unservedBacklogs = queues.filter(
      ({ configured, name, readyCount }) =>
        configured &&
        name !== "aihub.dead-letter" &&
        readyCount > 0 &&
        !onlineWorkerQueues.has(name),
    );
    const statusReasons = [
      ...(!hasOnlineWorker ? ["No online worker heartbeat is available."] : []),
      ...missingQueues.map(({ displayName }) => `${displayName} queue is not configured.`),
      ...unservedBacklogs.map(
        ({ displayName, readyCount }) =>
          `${displayName} has ${readyCount} ready job${readyCount === 1 ? "" : "s"} but no online worker.`,
      ),
    ];

    return {
      engine: "pg-boss",
      status: statusReasons.length === 0 ? "ONLINE" : "DEGRADED",
      statusReasons,
      queues,
      workers,
      capturedAt: capturedAt.toISOString(),
    };
  }

  async sendProbe(requestedBy: string, actor?: AdminActor): Promise<JobProbeResult> {
    const queuedAt = new Date().toISOString();
    const jobId = await this.queue.sendSystemProbe({ requestedAt: queuedAt, requestedBy });
    await this.audit("job.probe_requested", "Job", jobId, {
      queue: "aihub.system.probe",
    }, actor);
    return { jobId, queue: "aihub.system.probe", queuedAt };
  }

  async retry(queue: JobQueueName, jobId: string, actor?: AdminActor): Promise<void> {
    await this.queue.retry(queue, jobId);
    await this.audit("job.retry_requested", "Job", jobId, { queue }, actor);
  }

  async redriveDeadLetters(limit: number, actor?: AdminActor): Promise<number> {
    const moved = await this.queue.redriveDeadLetters(limit);
    await this.audit("job.dead_letters_redriven", "JobQueue", "aihub.dead-letter", {
      limit,
      moved,
    }, actor);
    return moved;
  }

  private async audit(
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
    actor?: AdminActor,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorType: actor ? "USER" : "SYSTEM",
        actorId: actor?.id ?? null,
        action,
        resourceType,
        resourceId,
        outcome: "SUCCESS",
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
