import type { AgentRunJobPayload } from "@orcasynapse/contracts";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import type { WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface AgentWorkerHandler {
  process(payload: AgentRunJobPayload, jobId: string, workerId: string): Promise<object>;
}

/**
 * PostgreSQL remains the durable source of truth for asynchronous Hermes runs.
 * Knowledge ingestion is streamed synchronously to Supermemory by the API and
 * therefore has no duplicate worker or retry queue.
 */
export class WorkerRuntime {
  private heartbeatTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private agentDrain: Promise<void> | undefined;
  private started = false;

  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly registry: WorkerRegistry,
    private readonly identity: WorkerIdentity,
    private readonly logger: WorkerLogger,
    private readonly heartbeatIntervalMs = 15_000,
    private readonly agentHandler?: AgentWorkerHandler,
    private readonly reconcileIntervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.registry.markStarted(this.identity);
    this.started = true;
    await this.drainAgents();
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
    this.reconcileTimer.unref();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    this.logger.info(`PostgreSQL runtime '${this.identity.name}' is online.`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await Promise.allSettled([this.agentDrain].filter((value): value is Promise<void> => Boolean(value)));
    await this.registry.markStopped(this.identity.id);
    this.started = false;
  }

  private async reconcile(): Promise<void> {
    await this.drainAgents();
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.registry.markAlive(this.identity.id);
    } catch (error) {
      this.logger.error("Runtime heartbeat update failed.", error);
    }
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
          { runId: item.id },
          item.jobId!,
          this.identity.id,
        )));
      } catch (error) {
        this.logger.error("Hermes run reconciliation failed.", error);
      }
    })();
    this.agentDrain = drain;
    try { await drain; } finally { if (this.agentDrain === drain) this.agentDrain = undefined; }
  }
}
