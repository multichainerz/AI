import type { AgentRunJobPayload, DocumentConversionJobPayload, MemoryIndexJobPayload } from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import type { WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface DocumentWorkerHandlers {
  convert(payload: DocumentConversionJobPayload, jobId: string, workerId: string): Promise<object>;
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

/**
 * A small PostgreSQL state reconciler. Domain rows are the durable source of
 * truth; no second queue database or broker is involved. Every processor uses
 * compare-and-set claims, so a restart or a second runtime safely replays only
 * unfinished work.
 */
export class WorkerRuntime {
  private heartbeatTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private documentDrain: Promise<void> | undefined;
  private memoryDrain: Promise<void> | undefined;
  private agentDrain: Promise<void> | undefined;
  private toolDrain: Promise<void> | undefined;
  private cleanupDrain: Promise<void> | undefined;
  private started = false;

  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly registry: WorkerRegistry,
    private readonly identity: WorkerIdentity,
    private readonly logger: WorkerLogger,
    private readonly heartbeatIntervalMs = 15_000,
    private readonly documentHandlers?: DocumentWorkerHandlers,
    private readonly memoryHandler?: MemoryWorkerHandler,
    private readonly agentHandler?: AgentWorkerHandler,
    private readonly toolActionHandler?: ToolActionWorkerHandler,
    private readonly reconcileIntervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.registry.markStarted(this.identity);
    this.started = true;
    await Promise.all([
      this.drainDocuments(),
      this.drainMemory(),
      this.drainAgents(),
      this.drainToolActions(),
      this.cleanupExpiredDocuments(),
    ]);
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
    this.reconcileTimer.unref();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    this.cleanupTimer = setInterval(() => void this.cleanupExpiredDocuments(), 5 * 60 * 1_000);
    this.cleanupTimer.unref();
    this.logger.info(`PostgreSQL runtime '${this.identity.name}' is online.`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.allSettled([
      this.documentDrain,
      this.memoryDrain,
      this.agentDrain,
      this.toolDrain,
      this.cleanupDrain,
    ].filter((value): value is Promise<void> => Boolean(value)));
    await this.registry.markStopped(this.identity.id);
    this.started = false;
  }

  private async reconcile(): Promise<void> {
    await Promise.all([
      this.drainDocuments(),
      this.drainMemory(),
      this.drainAgents(),
      this.drainToolActions(),
    ]);
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.registry.markAlive(this.identity.id);
    } catch (error) {
      this.logger.error("Runtime heartbeat update failed.", error);
    }
  }

  private async drainDocuments(): Promise<void> {
    if (!this.documentHandlers || this.documentDrain) return this.documentDrain;
    const drain = (async () => {
      try {
        const work = await this.prisma.documentProcessingRun.findMany({
          where: {
            conversionJobId: { not: null },
            completedAt: null,
            failedAt: null,
            document: { status: { in: ["QUEUED", "CONVERTING"] } },
          },
          select: { documentId: true, generation: true, conversionJobId: true },
          orderBy: { createdAt: "asc" },
          take: 5,
        });
        await Promise.all(work.map((item) => this.documentHandlers!.convert(
          { documentId: item.documentId, generation: item.generation },
          item.conversionJobId!,
          this.identity.id,
        )));
      } catch (error) {
        this.logger.error("Document reconciliation failed.", error);
      }
    })();
    this.documentDrain = drain;
    try { await drain; } finally { if (this.documentDrain === drain) this.documentDrain = undefined; }
  }

  private async drainMemory(): Promise<void> {
    if (!this.memoryHandler || this.memoryDrain) return this.memoryDrain;
    const drain = (async () => {
      try {
        const work = await this.prisma.documentMemoryPublication.findMany({
          where: { jobId: { not: null }, status: { in: ["QUEUED", "PROCESSING", "DELETE_PENDING"] } },
          select: { documentId: true, generation: true, jobId: true, status: true, document: { select: { status: true } } },
          orderBy: { queuedAt: "asc" },
          take: 5,
        });
        await Promise.all(work.map((item) => this.memoryHandler!.process({
          documentId: item.documentId,
          generation: item.generation,
          action: item.status === "DELETE_PENDING" || item.document.status === "DELETED" ? "DELETE" : "UPSERT",
        }, item.jobId!, this.identity.id)));
      } catch (error) {
        this.logger.error("Memory reconciliation failed.", error);
      }
    })();
    this.memoryDrain = drain;
    try { await drain; } finally { if (this.memoryDrain === drain) this.memoryDrain = undefined; }
  }

  private async drainAgents(): Promise<void> {
    if (!this.agentHandler || this.agentDrain) return this.agentDrain;
    const drain = (async () => {
      try {
        const work = await this.prisma.agentRun.findMany({
          where: { jobId: { not: null }, status: { in: ["QUEUED", "RUNNING", "CANCEL_REQUESTED"] } },
          select: { id: true, jobId: true },
          orderBy: { queuedAt: "asc" },
          take: 5,
        });
        await Promise.all(work.map((item) => this.agentHandler!.process(
          { runId: item.id }, item.jobId!, this.identity.id,
        )));
      } catch (error) {
        this.logger.error("Hermes run reconciliation failed.", error);
      }
    })();
    this.agentDrain = drain;
    try { await drain; } finally { if (this.agentDrain === drain) this.agentDrain = undefined; }
  }

  private async drainToolActions(): Promise<void> {
    if (!this.toolActionHandler || this.toolDrain) return this.toolDrain;
    const drain = this.toolActionHandler.processAvailable(this.identity.id)
      .then(() => undefined)
      .catch((error) => this.logger.error("Approved tool-action reconciliation failed.", error));
    this.toolDrain = drain;
    try { await drain; } finally { if (this.toolDrain === drain) this.toolDrain = undefined; }
  }

  private async cleanupExpiredDocuments(): Promise<void> {
    if (!this.documentHandlers?.cleanupExpired || this.cleanupDrain) return this.cleanupDrain;
    const drain = this.documentHandlers.cleanupExpired(this.identity.id)
      .then(() => undefined)
      .catch((error) => this.logger.error("Transient document staging cleanup failed.", error));
    this.cleanupDrain = drain;
    try { await drain; } finally { if (this.cleanupDrain === drain) this.cleanupDrain = undefined; }
  }
}
