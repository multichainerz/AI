import type { PgBossQueueService } from "@aihub/jobs";
import type { AgentRunJobPayload, DocumentConversionJobPayload, DocumentOcrJobPayload, MemoryIndexJobPayload } from "@aihub/contracts";
import type { WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface WorkerQueueRuntime {
  start(options?: { ensureQueues?: boolean }): Promise<void>;
  stop(): Promise<void>;
  registerSystemProbeWorker(workerId: string): Promise<string>;
  registerDocumentConversionWorker?: (
    workerId: string,
    handler: (payload: DocumentConversionJobPayload, jobId: string, workerId: string) => Promise<object>,
  ) => Promise<string>;
  registerDocumentOcrWorker?: (
    workerId: string,
    handler: (payload: DocumentOcrJobPayload, jobId: string, workerId: string) => Promise<object>,
  ) => Promise<string>;
  registerMemoryIndexWorker?: (
    workerId: string,
    handler: (payload: MemoryIndexJobPayload, jobId: string, workerId: string) => Promise<object>,
  ) => Promise<string>;
  registerAgentRunWorker?: (
    workerId: string,
    handler: (payload: AgentRunJobPayload, jobId: string, workerId: string) => Promise<object>,
  ) => Promise<string>;
}

export interface DocumentWorkerHandlers {
  convert(payload: DocumentConversionJobPayload, jobId: string, workerId: string): Promise<object>;
  runOcr(payload: DocumentOcrJobPayload, jobId: string, workerId: string): Promise<object>;
  cleanupExpired?(workerId: string): Promise<number>;
}

export interface MemoryWorkerHandler {
  process(payload: MemoryIndexJobPayload, jobId: string, workerId: string): Promise<object>;
}

export interface AgentWorkerHandler {
  process(payload: AgentRunJobPayload, jobId: string, workerId: string): Promise<object>;
}

export interface ToolActionWorkerHandler {
  processAvailable(workerId: string): Promise<number>;
}

export class WorkerRuntime {
  private heartbeatTimer?: NodeJS.Timeout;
  private toolActionTimer?: NodeJS.Timeout;
  private documentCleanupTimer?: NodeJS.Timeout;
  private documentCleanupDrain: Promise<void> | undefined;
  private toolActionDrain: Promise<void> | undefined;
  private started = false;

  constructor(
    private readonly queue: WorkerQueueRuntime | PgBossQueueService,
    private readonly registry: WorkerRegistry,
    private readonly identity: WorkerIdentity,
    private readonly logger: WorkerLogger,
    private readonly heartbeatIntervalMs = 15_000,
    private readonly documentHandlers?: DocumentWorkerHandlers,
    private readonly memoryHandler?: MemoryWorkerHandler,
    private readonly agentHandler?: AgentWorkerHandler,
    private readonly toolActionHandler?: ToolActionWorkerHandler,
    private readonly toolActionIntervalMs = 5_000,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.queue.start();
    try {
      await this.registry.markStarted(this.identity);
      await this.queue.registerSystemProbeWorker(this.identity.id);
      if (this.documentHandlers && this.queue.registerDocumentConversionWorker && this.queue.registerDocumentOcrWorker) {
        await this.queue.registerDocumentConversionWorker(
          this.identity.id,
          (payload, jobId, workerId) => this.documentHandlers!.convert(payload, jobId, workerId),
        );
        await this.queue.registerDocumentOcrWorker(
          this.identity.id,
          (payload, jobId, workerId) => this.documentHandlers!.runOcr(payload, jobId, workerId),
        );
        if (this.documentHandlers.cleanupExpired) {
          await this.cleanupExpiredDocuments();
          this.documentCleanupTimer = setInterval(() => void this.cleanupExpiredDocuments(), 5 * 60 * 1_000);
          this.documentCleanupTimer.unref();
        }
      }
      if (this.memoryHandler && this.queue.registerMemoryIndexWorker) {
        await this.queue.registerMemoryIndexWorker(
          this.identity.id,
          (payload, jobId, workerId) => this.memoryHandler!.process(payload, jobId, workerId),
        );
      }
      if (this.agentHandler && this.queue.registerAgentRunWorker) {
        await this.queue.registerAgentRunWorker(
          this.identity.id,
          (payload, jobId, workerId) => this.agentHandler!.process(payload, jobId, workerId),
        );
      }
      if (this.toolActionHandler) {
        await this.drainToolActions();
        this.toolActionTimer = setInterval(() => void this.drainToolActions(), this.toolActionIntervalMs);
        this.toolActionTimer.unref();
      }
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs);
      this.heartbeatTimer.unref();
      this.started = true;
      this.logger.info(`Worker '${this.identity.name}' is online.`);
    } catch (error) {
      await Promise.allSettled([
        this.registry.markStopped(this.identity.id),
        this.queue.stop(),
      ]);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.toolActionTimer) clearInterval(this.toolActionTimer);
    if (this.documentCleanupTimer) clearInterval(this.documentCleanupTimer);
    if (this.documentCleanupDrain) await this.documentCleanupDrain;
    if (this.toolActionDrain) await this.toolActionDrain;
    const results = await Promise.allSettled([
      this.registry.markStopped(this.identity.id),
      this.queue.stop(),
    ]);
    this.started = false;
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.registry.markAlive(this.identity.id);
    } catch (error) {
      this.logger.error("Worker heartbeat update failed.", error);
    }
  }

  private async cleanupExpiredDocuments(): Promise<void> {
    if (!this.documentHandlers?.cleanupExpired || this.documentCleanupDrain) {
      return this.documentCleanupDrain;
    }
    const drain = (async () => {
      try {
        await this.documentHandlers!.cleanupExpired!(this.identity.id);
      } catch (error) {
        this.logger.error("Transient document staging cleanup failed.", error);
      }
    })();
    this.documentCleanupDrain = drain;
    try {
      await drain;
    } finally {
      if (this.documentCleanupDrain === drain) this.documentCleanupDrain = undefined;
    }
  }

  private async drainToolActions(): Promise<void> {
    if (!this.toolActionHandler) return;
    if (this.toolActionDrain) return this.toolActionDrain;
    const drain = (async () => {
      try {
        await this.toolActionHandler!.processAvailable(this.identity.id);
      } catch (error) {
        this.logger.error("Approved tool action recovery failed.", error);
      }
    })();
    this.toolActionDrain = drain;
    try {
      await drain;
    } finally {
      if (this.toolActionDrain === drain) this.toolActionDrain = undefined;
    }
  }
}
