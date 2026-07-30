import {
  JOB_QUEUE_NAMES,
  systemProbePayloadSchema,
  documentConversionJobPayloadSchema,
  documentOcrJobPayloadSchema,
  memoryIndexJobPayloadSchema,
  agentRunJobPayloadSchema,
  type JobQueueName,
  type JobQueueSnapshot,
  type SystemProbePayload,
  type DocumentConversionJobPayload,
  type DocumentOcrJobPayload,
  type MemoryIndexJobPayload,
  type AgentRunJobPayload,
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

  async sendDocumentConversion(payload: DocumentConversionJobPayload): Promise<string> {
    const parsed = documentConversionJobPayloadSchema.parse(payload);
    const id = await this.boss.send("aihub.documents.convert", parsed, {
      singletonKey: `${parsed.documentId}:${parsed.generation}`,
    });
    if (!id) throw new Error("Document conversion job was not created.");
    return id;
  }

  async sendDocumentOcr(payload: DocumentOcrJobPayload): Promise<string> {
    const parsed = documentOcrJobPayloadSchema.parse(payload);
    const id = await this.boss.send("aihub.documents.ocr", parsed, {
      singletonKey: `${parsed.documentId}:${parsed.generation}`,
    });
    if (!id) throw new Error("Document OCR job was not created.");
    return id;
  }

  async sendMemoryIndex(payload: MemoryIndexJobPayload): Promise<string> {
    const id = await this.ensureMemoryIndex(payload);
    if (!id) throw new Error("Memory synchronization job was not created.");
    return id;
  }

  async ensureMemoryIndex(payload: MemoryIndexJobPayload): Promise<string | null> {
    const parsed = memoryIndexJobPayloadSchema.parse(payload);
    return this.boss.send("aihub.memory.index", parsed, {
      singletonKey: `${parsed.documentId}:${parsed.generation}:${parsed.action}`,
    });
  }

  async sendAgentRun(payload: AgentRunJobPayload): Promise<string> {
    const parsed = agentRunJobPayloadSchema.parse(payload);
    const id = await this.boss.send("aihub.agents.run", parsed, {
      singletonKey: parsed.runId,
    });
    if (!id) throw new Error("Agent run job was not created.");
    return id;
  }

  async registerDocumentConversionWorker(
    workerId: string,
    handler: (payload: DocumentConversionJobPayload, jobId: string, workerId: string) => Promise<object>,
  ): Promise<string> {
    return this.boss.work<DocumentConversionJobPayload, object>(
      "aihub.documents.convert",
      { pollingIntervalSeconds: 5, localConcurrency: 1 },
      async ([job]) => {
        if (!job) throw new Error("pg-boss delivered an empty document conversion batch.");
        return handler(documentConversionJobPayloadSchema.parse(job.data), job.id, workerId);
      },
    );
  }

  async registerDocumentOcrWorker(
    workerId: string,
    handler: (payload: DocumentOcrJobPayload, jobId: string, workerId: string) => Promise<object>,
  ): Promise<string> {
    return this.boss.work<DocumentOcrJobPayload, object>(
      "aihub.documents.ocr",
      { pollingIntervalSeconds: 5, localConcurrency: 1 },
      async ([job]) => {
        if (!job) throw new Error("pg-boss delivered an empty document OCR batch.");
        return handler(documentOcrJobPayloadSchema.parse(job.data), job.id, workerId);
      },
    );
  }

  async registerMemoryIndexWorker(
    workerId: string,
    handler: (payload: MemoryIndexJobPayload, jobId: string, workerId: string) => Promise<object>,
  ): Promise<string> {
    return this.boss.work<MemoryIndexJobPayload, object>(
      "aihub.memory.index",
      { pollingIntervalSeconds: 5, localConcurrency: 1 },
      async ([job]) => {
        if (!job) throw new Error("pg-boss delivered an empty memory synchronization batch.");
        return handler(memoryIndexJobPayloadSchema.parse(job.data), job.id, workerId);
      },
    );
  }

  async registerAgentRunWorker(
    workerId: string,
    handler: (payload: AgentRunJobPayload, jobId: string, workerId: string) => Promise<object>,
  ): Promise<string> {
    return this.boss.work<AgentRunJobPayload, object>(
      "aihub.agents.run",
      { pollingIntervalSeconds: 2, localConcurrency: 2 },
      async ([job]) => {
        if (!job) throw new Error("pg-boss delivered an empty agent run batch.");
        return handler(agentRunJobPayloadSchema.parse(job.data), job.id, workerId);
      },
    );
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
