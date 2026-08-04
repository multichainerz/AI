import { randomUUID } from "node:crypto";
import type {
  ConnectionMonitoringControl,
  UpdateConnectionMonitoringControl,
} from "@orcasynapse/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  auditEvent,
  connectionMonitoringControl,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { AdminActor } from "./connection-manager.js";
import type { ConnectionTestService } from "./diagnostics/connection-test-service.js";

const DEFAULT_REASON = "Scheduled connection monitoring has not been enabled.";
const DEFAULT_CYCLE_LIMIT = 32;
const DEFAULT_CYCLE_CONCURRENCY = 8;

export interface ConnectionMonitorLogger {
  error(message: string, error?: unknown): void;
}

export interface ConnectionMonitoringManager {
  getControl(): Promise<ConnectionMonitoringControl>;
  updateControl(actor: AdminActor, input: UpdateConnectionMonitoringControl): Promise<ConnectionMonitoringControl>;
}

export interface ConnectionMonitorService extends ConnectionMonitoringManager {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class ConnectionMonitorRuntime implements ConnectionMonitorService {
  private timer: NodeJS.Timeout | undefined;
  private activeCycle: Promise<void> | undefined;
  private started = false;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly tester: ConnectionTestService,
    private readonly logger: ConnectionMonitorLogger,
    private readonly instanceId: string = randomUUID(),
    private readonly tickIntervalMs = 5_000,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.triggerCycle(), this.tickIntervalMs);
    this.timer.unref();
    void this.triggerCycle();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.activeCycle) await this.activeCycle;
  }

  async getControl(): Promise<ConnectionMonitoringControl> {
    const [control] = await this.database
      .select()
      .from(connectionMonitoringControl)
      .where(eq(connectionMonitoringControl.id, "global"))
      .limit(1);
    return {
      enabled: control?.enabled ?? false,
      intervalSeconds: control?.intervalSeconds ?? 300,
      reason: control?.reason ?? DEFAULT_REASON,
      updatedAt: (control?.updatedAt ?? new Date(0)).toISOString(),
      updatedBy: control?.updatedBy ?? null,
    };
  }

  async updateControl(
    actor: AdminActor,
    input: UpdateConnectionMonitoringControl,
  ): Promise<ConnectionMonitoringControl> {
    const control = await this.database.transaction(async (transaction) => {
      const [saved] = await transaction
        .insert(connectionMonitoringControl)
        .values({ id: "global", ...input, updatedBy: actor.id })
        .onConflictDoUpdate({
          target: connectionMonitoringControl.id,
          set: { ...input, updatedBy: actor.id },
        })
        .returning();
      if (!saved) throw new Error("The monitoring control row could not be written.");

      // Disabling releases every outstanding claim, so re-enabling starts from a
      // clean slate rather than waiting out stale two-minute reservations.
      if (!input.enabled) {
        await transaction
          .update(serviceConnection)
          .set({ monitoringClaimedAt: null, monitoringClaimedBy: null, monitoringClaimToken: null })
          .where(isNotNull(serviceConnection.monitoringClaimToken));
      }

      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: actor.id,
        action: input.enabled ? "connection.monitoring_enabled" : "connection.monitoring_disabled",
        resourceType: "ConnectionMonitoringControl",
        resourceId: "global",
        outcome: "SUCCESS",
        metadata: { intervalSeconds: input.intervalSeconds, reason: input.reason },
      });
      return saved;
    });

    if (input.enabled && this.started) void this.triggerCycle();
    return {
      enabled: control.enabled,
      intervalSeconds: control.intervalSeconds,
      reason: control.reason,
      updatedAt: control.updatedAt.toISOString(),
      updatedBy: control.updatedBy,
    };
  }

  async processOneDueConnection(): Promise<boolean> {
    const claim = await this.claimOne();
    if (!claim) return false;
    try {
      await this.tester.test(claim.connectionId);
    } catch {
      await this.recordMonitorFailure(claim.connectionId, claim.claimToken);
      return true;
    }
    await this.database
      .update(serviceConnection)
      .set({ monitoringClaimedAt: null, monitoringClaimedBy: null, monitoringClaimToken: null })
      .where(
        and(
          eq(serviceConnection.id, claim.connectionId),
          eq(serviceConnection.monitoringClaimToken, claim.claimToken),
        ),
      );
    return true;
  }

  async processDueConnections(
    limit = DEFAULT_CYCLE_LIMIT,
    concurrency = DEFAULT_CYCLE_CONCURRENCY,
  ): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const lanes = Math.max(1, Math.min(boundedLimit, Math.trunc(concurrency)));
    let reservations = 0;
    const drainLane = async () => {
      let processed = 0;
      while (reservations < boundedLimit) {
        reservations += 1;
        if (!(await this.processOneDueConnection())) break;
        processed += 1;
      }
      return processed;
    };
    const processed = await Promise.all(Array.from({ length: lanes }, () => drainLane()));
    return processed.reduce((total, count) => total + count, 0);
  }

  private async triggerCycle(): Promise<void> {
    if (this.activeCycle) return this.activeCycle;
    const cycle = (async () => {
      try {
        await this.processDueConnections();
      } catch (error) {
        this.logger.error("Scheduled connection monitoring cycle failed.", error);
      }
    })();
    this.activeCycle = cycle;
    try {
      await cycle;
    } finally {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
    }
  }

  /**
   * Reserves one due connection for this instance.
   *
   * The control row is locked FOR UPDATE so a cycle cannot start against an
   * interval that is being changed, and the candidate is taken with SKIP LOCKED
   * so parallel lanes and other API instances never contend for the same row.
   */
  private async claimOne(): Promise<{ connectionId: string; claimToken: string } | null> {
    return this.database.transaction(async (transaction) => {
      const controls = await transaction.execute<{ enabled: boolean; intervalSeconds: number }>(sql`
        SELECT "enabled", "intervalSeconds"
        FROM "ConnectionMonitoringControl"
        WHERE "id" = 'global'
        FOR UPDATE
      `);
      const control = controls.rows[0];
      if (!control?.enabled) return null;

      const candidates = await transaction.execute<{ id: string }>(sql`
        SELECT "id"
        FROM "ServiceConnection"
        WHERE "enabled" = true
          AND (
            "lastHealthcheckAt" IS NULL
            OR "lastHealthcheckAt" <= CURRENT_TIMESTAMP - (${control.intervalSeconds} * INTERVAL '1 second')
          )
          AND (
            "monitoringClaimedAt" IS NULL
            OR "monitoringClaimedAt" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes'
          )
        ORDER BY "lastHealthcheckAt" ASC NULLS FIRST, "updatedAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const candidate = candidates.rows[0];
      if (!candidate) return null;

      const claimToken = randomUUID();
      await transaction
        .update(serviceConnection)
        .set({
          monitoringClaimedAt: new Date(),
          monitoringClaimedBy: this.instanceId,
          monitoringClaimToken: claimToken,
        })
        .where(eq(serviceConnection.id, candidate.id));
      return { connectionId: candidate.id, claimToken };
    });
  }

  private async recordMonitorFailure(connectionId: string, claimToken: string): Promise<void> {
    const checkedAt = new Date();
    await this.database.transaction(async (transaction) => {
      const failed = await transaction
        .update(serviceConnection)
        .set({
          status: "DEGRADED",
          lastHealthcheckAt: checkedAt,
          lastHealthcheckMessage: "Automated check could not resolve the stored connection configuration.",
          monitoringClaimedAt: null,
          monitoringClaimedBy: null,
          monitoringClaimToken: null,
        })
        .where(
          and(
            eq(serviceConnection.id, connectionId),
            eq(serviceConnection.monitoringClaimToken, claimToken),
          ),
        )
        .returning({ id: serviceConnection.id });
      // Another instance re-claimed the row; recording a failure against its
      // check would attribute the wrong outcome.
      if (failed.length !== 1) return;

      await transaction.insert(auditEvent).values({
        actorType: "SYSTEM",
        action: "connection.monitor_failed",
        resourceType: "ServiceConnection",
        resourceId: connectionId,
        outcome: "FAILURE",
        metadata: { failure: "configuration_resolution" },
      });
    });
  }
}
