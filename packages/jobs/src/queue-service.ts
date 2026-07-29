import {
  JOB_QUEUE_NAMES,
  systemProbePayloadSchema,
  type JobQueueName,
  type JobQueueSnapshot,
  type SystemProbePayload,
} from "@aihub/contracts";
import { PgBoss, type Job, type QueueResult } from "pg-boss";
import { AIHUB_QUEUE_DEFINITIONS, queueDefinition } from "./queue-definitions.js";

export type QueueRuntimeMode = "api" | "worker" | "migration";

export interface QueueLogger {
  error(message: string, error?: unknown): void;
  warn(message: string, details?: unknown): void;
}

const silentLogger: QueueLogger = {
  error: () => undefined,
  warn: () => undefined,
};

export class PgBossQueueService {
  private readonly boss: PgBoss;
  private started = false;

  constructor(
    connectionString: string,
    mode: QueueRuntimeMode,
    private readonly logger: QueueLogger = silentLogger,
  ) {
    this.boss = new PgBoss({
      connectionString,
      schema: "aihub_jobs",
      application_name: `mpm-aihub-${mode}`,
      max: mode === "worker" ? 6 : 2,
      migrate: mode === "migration",
      createSchema: mode === "migration",
      supervise: mode === "worker",
      schedule: false,
      useListenNotify: mode === "worker",
      persistWarnings: true,
      persistQueueStats: true,
      queueStatRetentionDays: 14,
    });
    this.boss.on("error", (error) => this.logger.error("pg-boss runtime error", error));
    this.boss.on("warning", (warning) => this.logger.warn("pg-boss runtime warning", warning));
  }

  async start(options: { ensureQueues?: boolean } = {}): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    this.started = true;
    if (options.ensureQueues) await this.ensureQueues();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    this.started = false;
  }

  async ensureQueues(): Promise<void> {
    for (const definition of AIHUB_QUEUE_DEFINITIONS) {
      const existing = await this.boss.getQueue(definition.name);
      if (!existing) {
        await this.boss.createQueue(definition.name, definition.options);
        continue;
      }

      const { policy: _policy, partition: _partition, ...mutableOptions } = definition.options;
      await this.boss.updateQueue(definition.name, mutableOptions);
    }
  }

  async snapshot(): Promise<JobQueueSnapshot[]> {
    const queueResults = await this.boss.getQueues([...JOB_QUEUE_NAMES]);
    const byName = new Map(queueResults.map((queue) => [queue.name, queue]));
    const capturedAt = new Date().toISOString();

    return JOB_QUEUE_NAMES.map((name) => {
      const queue = byName.get(name);
      return this.toSnapshot(name, queue, capturedAt);
    });
  }

  async registerSystemProbeWorker(
    workerId: string,
  ): Promise<string> {
    return this.boss.work<SystemProbePayload, object>(
      "aihub.system.probe",
      { pollingIntervalSeconds: 10 },
      async ([job]) => this.handleSystemProbe(workerId, job),
    );
  }

  async sendSystemProbe(payload: SystemProbePayload): Promise<string> {
    const parsed = systemProbePayloadSchema.parse(payload);
    const id = await this.boss.send("aihub.system.probe", parsed);
    if (!id) throw new Error("System probe job was not created.");
    return id;
  }

  async retry(name: JobQueueName, jobId: string): Promise<void> {
    await this.boss.retry(name, jobId);
  }

  async redriveDeadLetters(limit = 100): Promise<number> {
    return this.boss.redrive("aihub.dead-letter", { limit });
  }

  private async handleSystemProbe(
    workerId: string,
    job: Job<SystemProbePayload> | undefined,
  ): Promise<object> {
    if (!job) throw new Error("pg-boss delivered an empty system probe batch.");
    const payload = systemProbePayloadSchema.parse(job.data);
    return {
      workerId,
      requestedAt: payload.requestedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private toSnapshot(
    name: JobQueueName,
    queue: QueueResult | undefined,
    capturedAt: string,
  ): JobQueueSnapshot {
    return {
      name,
      displayName: queueDefinition(name).displayName,
      configured: queue !== undefined,
      readyCount: queue?.readyCount ?? 0,
      deferredCount: queue?.deferredCount ?? 0,
      activeCount: queue?.activeCount ?? 0,
      failedCount: queue?.failedCount ?? 0,
      totalCount: queue?.totalCount ?? 0,
      capturedAt,
    };
  }
}
