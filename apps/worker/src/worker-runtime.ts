import type { AgentRunJobPayload } from "@orcasynapse/contracts";
import type { PendingRunSource, WorkerIdentity, WorkerRegistry } from "./worker-registry.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface AgentWorkerHandler {
  process(payload: AgentRunJobPayload, jobId: string, workerId: string): Promise<object>;
  /**
   * Optional: a handler with no extractor configured has nothing to drain, and
   * a deployment with no approved model is one of those. Absence here is a
   * configuration rather than a wiring mistake -- unlike the run capability,
   * whose absence is silent and total.
   */
  drainMemoryExtraction?(): Promise<number>;
}

/** PostgreSQL is the durable queue and audit source for asynchronous Hermes runs. */
export class WorkerRuntime {
  private heartbeatTimer?: NodeJS.Timeout;
  private memoryTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly inFlight = new Map<string, Promise<void>>();
  private dispatching: Promise<void> | undefined;
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
    private readonly memorySweepIntervalMs = 30_000,
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
    /*
     * Its own timer, and slower than the dispatch one.
     *
     * Memory extraction is the only work here that nobody is waiting for: it
     * runs after an answer is delivered, and being a minute late costs nothing.
     * A separate interval is what keeps it from competing with dispatch for the
     * same tick, and from occupying one of the processor slots that answer
     * people -- which is exactly what it did until v8.7.0.
     */
    this.memoryTimer = setInterval(() => void this.sweepMemory(), this.memorySweepIntervalMs);
    this.memoryTimer.unref();
    this.logger.info(`PostgreSQL runtime '${this.identity.name}' is online.`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.started = false;
    await this.dispatching?.catch(() => undefined);
    await Promise.allSettled([...this.inFlight.values()]);
    await this.registry.markStopped(this.identity.id);
  }

  async dispatchNow(): Promise<void> {
    if (!this.started) return;
    try {
      await this.dispatchAgents();
    } catch (error) {
      this.logger.error("Woken dispatch failed.", error);
    }
  }

  private async reconcile(): Promise<void> {
    await this.dispatchAgents();
  }

  /**
   * Drains the runs that still owe memory.
   *
   * Failure is logged rather than raised: a sweep that cannot reach the model
   * has lost some notes, and the next sweep will take the next batch. Nothing
   * about answering people depends on this succeeding.
   */
  private async sweepMemory(): Promise<void> {
    if (!this.agentHandler?.drainMemoryExtraction) return;
    try {
      await this.agentHandler.drainMemoryExtraction();
    } catch (error) {
      this.logger.error("Memory extraction sweep failed.", error);
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.registry.markAlive(this.identity.id);
    } catch (error) {
      this.logger.error("Runtime heartbeat update failed.", error);
    }
  }

  private async dispatchAgents(): Promise<void> {
    const handler = this.agentHandler;
    if (!handler || this.dispatching) return this.dispatching;
    const dispatch = (async () => {
      try {
        const capacity = this.maxConcurrentAgentRuns - this.inFlight.size;
        if (capacity <= 0) return;
        const work = await this.runs.claimable(capacity, [...this.inFlight.keys()]);
        for (const item of work) {
          if (this.inFlight.has(item.id)) continue;
          const execution = handler
            .process({ runId: item.id }, item.jobId, this.identity.id)
            .then(() => undefined)
            .catch((error: unknown) => this.logger.error("A durable Hermes run failed to process.", error))
            .finally(() => { this.inFlight.delete(item.id); });
          this.inFlight.set(item.id, execution);
        }
      } catch (error) {
        this.logger.error("Hermes run reconciliation failed.", error);
      }
    })();
    this.dispatching = dispatch;
    try {
      await dispatch;
    } finally {
      if (this.dispatching === dispatch) this.dispatching = undefined;
    }
  }
}
