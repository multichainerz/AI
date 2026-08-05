import type { AgentRunJobPayload } from "@orcasynapse/contracts";
import type { PendingRunSource, WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface AgentWorkerHandler {
  process(payload: AgentRunJobPayload, jobId: string, workerId: string): Promise<object>;
}

export interface DocumentIngestionHandler {
  processNext(workerId: string): Promise<{ documentId: string; status: string } | null>;
}

/**
 * PostgreSQL remains the durable source of truth for asynchronous work.
 *
 * Both Hermes runs and knowledge ingestion are queued here. Ingestion moved off
 * the upload request because embedding loads ~2 GB of weights and outlived the
 * proxy timeout, and a crash mid-embed stranded the document with nothing to
 * recover it.
 */
export class WorkerRuntime {
  private heartbeatTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly inFlight = new Map<string, Promise<void>>();
  private dispatching: Promise<void> | undefined;
  private ingesting = false;
  private started = false;

  constructor(
    private readonly runs: PendingRunSource,
    private readonly registry: WorkerRegistry,
    private readonly identity: WorkerIdentity,
    private readonly logger: WorkerLogger,
    private readonly heartbeatIntervalMs = 15_000,
    private readonly agentHandler?: AgentWorkerHandler,
    private readonly reconcileIntervalMs = 1_000,
    private readonly maxConcurrentAgentRuns = 5,
    private readonly ingestionHandler?: DocumentIngestionHandler,
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
    await this.dispatchIngestion();
  }

  /**
   * Embeds one queued document per tick.
   *
   * Serialised deliberately: the embedder holds the model in this process, so
   * running several at once would multiply peak memory on the host that is
   * already the tightest part of the deployment. The guard also stops a slow
   * document from being started twice by overlapping ticks.
   */
  private async dispatchIngestion(): Promise<void> {
    if (!this.ingestionHandler || this.ingesting) return;
    this.ingesting = true;
    try {
      const outcome = await this.ingestionHandler.processNext(this.identity.id);
      if (outcome) {
        this.logger.info(`Document ${outcome.documentId} indexing finished as ${outcome.status}.`);
      }
    } catch (error) {
      this.logger.error("Document ingestion failed.", error);
    } finally {
      this.ingesting = false;
    }
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
        const work = await this.runs.claimable(capacity, [...this.inFlight.keys()]);
        for (const item of work) {
          if (this.inFlight.has(item.id)) continue;
          const execution = this.agentHandler!
            .process({ runId: item.id }, item.jobId, this.identity.id)
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
