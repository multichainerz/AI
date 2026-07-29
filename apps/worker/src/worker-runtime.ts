import type { PgBossQueueService } from "@aihub/jobs";
import type { WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface WorkerQueueRuntime {
  start(options?: { ensureQueues?: boolean }): Promise<void>;
  stop(): Promise<void>;
  registerSystemProbeWorker(workerId: string): Promise<string>;
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
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.queue.start();
    try {
      await this.registry.markStarted(this.identity);
      await this.queue.registerSystemProbeWorker(this.identity.id);
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
