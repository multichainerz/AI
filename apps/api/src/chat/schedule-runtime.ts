import {
  auditEvent,
  chatSchedule,
  enterpriseUser,
  localAdministrator,
  localUser,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { scopesForAdminRole } from "../auth/admin-session.js";
import {
  ChatConfigurationError,
  ChatConversationArchivedError,
  ChatConversationConflictError,
  ChatConversationNotFoundError,
  ChatPolicyViolationError,
  ChatRateLimitError,
  type ChatManager,
  type ChatPrincipal,
} from "./chat-manager.js";

export interface ScheduleRuntimeLogger {
  info(message: string): void;
  error(message: string, error: unknown): void;
}

/**
 * How long a fire may take before the next tick is allowed to start one.
 *
 * `submitMessage` returns as soon as the run is queued -- it does not wait for
 * the model -- so this bounds a database round trip and a guardrail pass, not a
 * turn. It exists because the tick is a timer rather than a queue: without it a
 * database that has become slow would have every tick pile another cycle on top
 * of the last.
 */
const CYCLE_TICK_MS = 15_000;

/**
 * Fires scheduled conversation turns.
 *
 * The shape is `ConnectionMonitorRuntime`'s, and deliberately so: periodic work
 * that needs an API-layer manager lives in the API process, because that is
 * where the manager is. The worker is a separate application and never learns
 * this feature exists -- once `submitMessage` writes the run, the wake fires and
 * the dispatcher that already claims runs claims this one too.
 *
 * Nothing here reimplements a rule. Every guardrail, rate limit and ownership
 * test a typed message passes through is the one `submitMessage` applies, at the
 * moment of the fire, against the policy that is active then.
 */
export class ScheduleRuntime {
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private activeCycle: Promise<void> | undefined;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly chat: ChatManager,
    private readonly logger: ScheduleRuntimeLogger,
    private readonly tickIntervalMs = CYCLE_TICK_MS,
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

  private async triggerCycle(): Promise<void> {
    if (this.activeCycle) return this.activeCycle;
    const cycle = (async () => {
      try {
        await this.runCycle();
      } catch (error) {
        this.logger.error("Scheduled turn cycle failed.", error);
      } finally {
        this.activeCycle = undefined;
      }
    })();
    this.activeCycle = cycle;
    return cycle;
  }

  /**
   * One pass over the schedules that are due.
   *
   * Claimed one at a time by conditional UPDATE rather than read-then-fire. The
   * API may run as more than one replica, and two replicas that both read a row
   * as due would both post a message into somebody's thread. A duplicate probe
   * is survivable for the connection monitor; a duplicate turn is not.
   */
  async runCycle(now: Date = new Date()): Promise<number> {
    let fired = 0;
    for (;;) {
      const claimed = await this.claimNext(now);
      if (!claimed) return fired;
      fired += 1;
      await this.fire(claimed);
    }
  }

  private async claimNext(now: Date): Promise<ClaimedSchedule | null> {
    /*
     * `nextRunAt` moves forward from the claim instant, not from the time the
     * fire was due. A deployment that was down for a day would otherwise come
     * back and fire every missed window in a burst -- which is a stampede of
     * model calls, and a wall of identical messages for whoever opens the
     * thread. One catch-up turn is the useful part of a missed schedule; the
     * other ninety-five are noise.
     */
    const [row] = await this.database
      .update(chatSchedule)
      .set({
        nextRunAt: sql`${now.toISOString()}::timestamptz + make_interval(secs => ${chatSchedule.intervalSeconds})`,
        lastRunAt: now,
      })
      .where(and(
        eq(chatSchedule.enabled, true),
        lte(chatSchedule.nextRunAt, now),
        eq(chatSchedule.id, sql`(
          select ${chatSchedule.id} from ${chatSchedule}
          where ${chatSchedule.enabled} = true and ${chatSchedule.nextRunAt} <= ${now.toISOString()}::timestamptz
          order by ${chatSchedule.nextRunAt} asc
          limit 1
          for update skip locked
        )`),
      ))
      .returning({
        id: chatSchedule.id,
        conversationId: chatSchedule.conversationId,
        prompt: chatSchedule.prompt,
        createdBy: chatSchedule.createdBy,
        createdBySubject: chatSchedule.createdBySubject,
        createdByMode: chatSchedule.createdByMode,
      });
    return row ?? null;
  }

  private async fire(schedule: ClaimedSchedule): Promise<void> {
    const principal = await this.resolvePrincipal(schedule);
    if (!principal) {
      /*
       * The creator is gone, disabled, or no longer allowed to use chat. A
       * schedule is a standing grant of one person's authority, so it stops
       * when that authority does -- and says so where the panel reads it,
       * because a schedule that silently stopped is indistinguishable from one
       * that is simply not due yet.
       */
      const detail = `${schedule.createdBySubject} can no longer start conversations, so this schedule was disabled.`;
      await this.settle(schedule.id, "DISABLED", detail, false);
      await this.recordFire(schedule, "DISABLED", detail);
      return;
    }

    try {
      await this.chat.submitMessage(principal, schedule.conversationId, schedule.prompt);
      await this.settle(schedule.id, "OK", "The scheduled turn was queued.", true);
      await this.recordFire(schedule, "OK", "The scheduled turn was queued.");
    } catch (error) {
      const outcome = this.classify(error);
      await this.settle(schedule.id, outcome.status, outcome.detail, outcome.status !== "DISABLED");
      if (outcome.status === "DISABLED") {
        this.logger.info(`Scheduled turn ${schedule.id} disabled: ${outcome.detail}`);
        await this.recordFire(schedule, "DISABLED", outcome.detail);
      }
    }
  }

  /**
   * Which refusals are worth retrying, and which will refuse identically forever.
   *
   * A rate limit is a moment; the next tick may well succeed, so the schedule
   * stays armed and the reason is recorded as a skip. A guardrail block, an
   * archived conversation or a conversation with no profile are properties of
   * the schedule itself -- retrying them every interval produces an identical
   * refusal, an audit event, and no turn, forever.
   *
   * `ChatConversationConflictError` used to be listed with those, and it is the
   * one that does not belong: three of its four causes are races. A run still in
   * progress from the previous fire, a person typing in the thread at the same
   * instant, or a response cancelled mid-submission all clear on their own, and
   * disabling for one meant a schedule stopped by the very traffic it was
   * competing with -- reachable in one pass whenever the API restarts after
   * downtime and claims two catch-up schedules at once. Only the archived case
   * is permanent, so only it is a subclass that lands in the disabling branch,
   * and it must be tested before its parent.
   */
  private classify(error: unknown): { status: "SKIPPED" | "DISABLED"; detail: string } {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof ChatRateLimitError) {
      return { status: "SKIPPED", detail };
    }
    if (
      error instanceof ChatPolicyViolationError
      || error instanceof ChatConversationArchivedError
      || error instanceof ChatConfigurationError
      || error instanceof ChatConversationNotFoundError
    ) {
      return { status: "DISABLED", detail };
    }
    // Every other conflict is a race that the next interval may not lose.
    if (error instanceof ChatConversationConflictError) {
      return { status: "SKIPPED", detail };
    }
    // An unrecognised failure is a skip, not a disable. Disabling on a database
    // blip would turn a transient outage into every schedule in the deployment
    // needing an operator to switch it back on.
    return { status: "SKIPPED", detail };
  }

  private async settle(
    scheduleId: string,
    outcome: "OK" | "SKIPPED" | "DISABLED",
    detail: string,
    keepEnabled: boolean,
  ): Promise<void> {
    await this.database
      .update(chatSchedule)
      .set({
        lastOutcome: outcome,
        lastDetail: detail.slice(0, 500),
        ...(keepEnabled ? {} : { enabled: false }),
      })
      .where(eq(chatSchedule.id, scheduleId));
  }

  /**
   * The trail the panel does not write. Create/update/delete are operator
   * actions on the row; a fire is unattended execution, and a self-disable is
   * a standing grant ending itself. Neither was recorded, so a morning report
   * that stopped was indistinguishable in the audit trail from one that was
   * never due. Skips stay off the trail: a rate limit every 15 seconds is not
   * a decision.
   */
  private async recordFire(
    schedule: ClaimedSchedule,
    outcome: "OK" | "DISABLED",
    detail: string,
  ): Promise<void> {
    await this.database.insert(auditEvent).values({
      actorType: "SERVICE",
      actorId: schedule.createdBy,
      action: outcome === "OK" ? "chat.schedule_fired" : "chat.schedule_disabled",
      resourceType: "ChatSchedule",
      resourceId: schedule.id,
      outcome: outcome === "OK" ? "SUCCESS" : "FAILURE",
      metadata: {
        conversationId: schedule.conversationId,
        createdBySubject: schedule.createdBySubject,
        detail: detail.slice(0, 500),
      },
    });
  }

  /**
   * The creator's authority, re-read now rather than stored.
   *
   * A principal captured at creation would be a frozen grant: the schedule would
   * go on firing with the scopes and division its creator had that day, for as
   * long as the row existed. Re-reading on every fire is what makes disabling
   * somebody actually stop their schedules, and is the reason `createdByMode`
   * is a column.
   */
  private async resolvePrincipal(schedule: ClaimedSchedule): Promise<ChatPrincipal | null> {
    if (!schedule.createdBy) return null;

    if (schedule.createdByMode === "ADMINISTRATOR_PREVIEW") {
      const [administrator] = await this.database
        .select({
          id: localAdministrator.id,
          role: localAdministrator.role,
          passwordChangeRequired: localAdministrator.passwordChangeRequired,
        })
        .from(localAdministrator)
        .where(and(
          eq(localAdministrator.id, schedule.createdBy),
          isNull(localAdministrator.disabledAt),
        ))
        .limit(1);
      if (!administrator || administrator.passwordChangeRequired) return null;
      const scopes = scopesForAdminRole(administrator.role);
      if (!scopes.includes("chat:use")) return null;
      return {
        id: administrator.id,
        subject: schedule.createdBySubject,
        identityMode: "ADMINISTRATOR_PREVIEW",
        scopes: [...scopes],
      };
    }

    if (schedule.createdByMode === "ENTERPRISE") {
      const [person] = await this.database
        .select({
          id: enterpriseUser.id,
          divisionId: enterpriseUser.divisionId,
          passwordChangeRequired: localUser.passwordChangeRequired,
        })
        .from(enterpriseUser)
        .leftJoin(localUser, eq(localUser.userId, enterpriseUser.id))
        .where(and(eq(enterpriseUser.id, schedule.createdBy), eq(enterpriseUser.enabled, true)))
        .limit(1);
      if (!person || person.passwordChangeRequired) return null;
      // The scope pair every enterprise session carries. A literal in
      // `EnterprisePrincipal`, so there is nothing per-user to read.
      return {
        id: person.id,
        subject: schedule.createdBySubject,
        identityMode: "ENTERPRISE",
        scopes: ["chat:use", "agents:use"],
        divisionId: person.divisionId,
      };
    }

    // A mode this release does not know. Refusing is the only safe reading:
    // firing would mean guessing what somebody is allowed to do.
    return null;
  }

}

interface ClaimedSchedule {
  id: string;
  conversationId: string;
  prompt: string;
  createdBy: string | null;
  createdBySubject: string;
  createdByMode: string;
}
