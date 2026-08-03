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
  private readonly inFlight = new Map<string, Promise<void>>();
  private dispatching: Promise<void> | undefined;
  private started = false;

  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly registry: WorkerRegistry,
    private readonly identity: WorkerIdentity,
    private readonly logger: WorkerLogger,
    private readonly heartbeatIntervalMs = 15_000,
    private readonly agentHandler?: AgentWorkerHandler,
    private readonly reconcileIntervalMs = 1_000,
    private readonly maxConcurrentAgentRuns = 5,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.registry.markStarted(this.identity);
    this.started = true;
    await this.dispatchAgents();
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
    // Clear the flag before draining so an in-flight tick cannot admit new work
    // behind the shutdown.
    this.started = false;
    await this.dispatching?.catch(() => undefined);
    await Promise.allSettled([...this.inFlight.values()]);
    await this.registry.markStopped(this.identity.id);
  }

  private async reconcile(): Promise<void> {
    await this.dispatchAgents();
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.registry.markAlive(this.identity.id);
    } catch (error) {
      this.logger.error("Runtime heartbeat update failed.", error);
    }
  }

  /**
   * Fills free execution slots and returns as soon as the new work is handed
   * off. Awaiting a whole batch here would hold every free slot hostage to the
   * slowest run in it, so a queued conversation could wait out an unrelated
   * long-running agent before starting.
   */
  private async dispatchAgents(): Promise<void> {
    if (!this.agentHandler || this.dispatching) return this.dispatching;
    const dispatch = (async () => {
      try {
        const capacity = this.maxConcurrentAgentRuns - this.inFlight.size;
        if (capacity <= 0) return;
        const active = [...this.inFlight.keys()];
        const work = await this.prisma.agentRun.findMany({
          where: {
            jobId: { not: null },
            // WAITING_FOR_APPROVAL is durable state, not a transient in-process
            // phase. Omitting it here stranded any run whose worker restarted
            // while an approval was outstanding.
            status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"] },
            ...(active.length > 0 ? { id: { notIn: active } } : {}),
            OR: [
              { processorLeaseExpiresAt: null },
              { processorLeaseExpiresAt: { lt: new Date() } },
            ],
          },
          select: { id: true, jobId: true },
          orderBy: { queuedAt: "asc" },
          take: capacity,
        });
        for (const item of work) {
          if (this.inFlight.has(item.id)) continue;
          const execution = this.agentHandler!
            .process({ runId: item.id }, item.jobId!, this.identity.id)
            .then(() => undefined)
            .catch((error: unknown) => {
              this.logger.error("A durable Hermes run failed to process.", error);
            })
            .finally(() => { this.inFlight.delete(item.id); });
          this.inFlight.set(item.id, execution);
        }
      } catch (error) {
        this.logger.error("Hermes run reconciliation failed.", error);
      }
    })();
    this.dispatching = dispatch;
    try { await dispatch; } finally { if (this.dispatching === dispatch) this.dispatching = undefined; }
  }
}
