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
}

export interface MemoryWorkerHandler {
  process(payload: MemoryIndexJobPayload, jobId: string, workerId: string): Promise<object>;
}

export interface AgentWorkerHandler {
  process(payload: AgentRunJobPayload, jobId: string, workerId: string): Promise<object>;
}

export class WorkerRuntime {
  private heartbeatTimer?: NodeJS.Timeout;
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
}
