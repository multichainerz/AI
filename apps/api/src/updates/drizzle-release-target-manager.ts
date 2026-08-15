import type {
  ApproveReleaseTarget,
  PlatformReleaseTarget,
  PlatformUpdate,
  PlatformUpdateActivity,
  PlatformUpdateAgent,
  PlatformUpdatePhase,
} from "@orcasynapse/contracts";
import { ORCASYNAPSE_VERSION, platformUpdateActivitySchema, platformUpdatePhaseSchema } from "@orcasynapse/contracts";
import {
  auditEvent,
  platformReleaseTarget,
  platformUpdateAgent,
  platformUpdateRun,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { desc, eq } from "drizzle-orm";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, increment } from "../database-support.js";
import {
  checkForPlatformUpdate,
  compareReleaseVersions,
  parseReleaseVersion,
  resolveReleaseTarget,
  type ReleaseTarget,
} from "../platform-updates.js";
import {
  ReleaseTargetConflictError,
  ReleaseTargetUnavailableError,
  ReleaseTargetValidationError,
  type PlatformReleaseTargetManager,
} from "./release-target-manager.js";

export interface PlatformReleaseTargetOptions {
  /** The release this deployment is running. A target below it is refused. */
  currentVersion?: string;
  /** Injected the way the update check injects it, so tests reach no network. */
  fetchImplementation?: typeof fetch;
}

type StoredTarget = typeof platformReleaseTarget.$inferSelect;
type StoredRun = typeof platformUpdateRun.$inferSelect;

const KNOWN_PHASES: ReadonlySet<string> = new Set(platformUpdatePhaseSchema.options);

/**
 * The column is free text as far as the database is concerned, and it is
 * written by a root program on the host rather than by this process. Text this
 * release does not recognise becomes `unknown` instead of failing to parse: an
 * operator opens this screen because an upgrade went wrong, and a 500 here
 * would take away the only account of it they have.
 */
function phaseOf(value: string): PlatformUpdatePhase {
  return KNOWN_PHASES.has(value) ? (value as PlatformUpdatePhase) : "unknown";
}

/** Everything a run carries except its log, which only the newest one returns. */
function runFields(row: StoredRun) {
  return {
    id: row.id,
    phase: phaseOf(row.phase),
    detail: row.detail,
    targetVersion: row.targetVersion,
    targetCommit: row.targetCommit,
    installedVersion: row.installedVersion,
    installedCommit: row.installedCommit,
    rollback: row.rollback,
    logTruncated: row.logTruncated,
    startedAt: row.startedAt.toISOString(),
    apiUnavailableUntil: row.apiUnavailableUntil?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    recordedAt: row.recordedAt.toISOString(),
  };
}

/**
 * The stored row is "approved" or it is empty; the database constraint refuses
 * anything between. Reading it back the same way keeps a half-written row from
 * reaching a host agent as a usable target if that ever changes.
 */
function targetDto(row: StoredTarget): PlatformReleaseTarget | null {
  if (!row.desiredVersion || !row.desiredCommit || !row.approvedBySubject || !row.approvedAt) return null;
  return {
    desiredVersion: row.desiredVersion,
    desiredCommit: row.desiredCommit,
    approvedBy: row.approvedBy,
    approvedBySubject: row.approvedBySubject,
    approvedAt: row.approvedAt.toISOString(),
    revision: row.revision,
  };
}

export class DrizzlePlatformReleaseTargetManager implements PlatformReleaseTargetManager {
  private readonly currentVersion: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    options: PlatformReleaseTargetOptions = {},
  ) {
    this.currentVersion = options.currentVersion ?? ORCASYNAPSE_VERSION;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async snapshot(): Promise<PlatformUpdate> {
    const [stored, agent] = await Promise.all([this.storedTarget(), this.storedAgent()]);
    try {
      return await checkForPlatformUpdate(this.currentVersion, this.fetchImplementation, stored, agent);
    } catch (error) {
      throw new ReleaseTargetUnavailableError(
        error instanceof Error ? error.message : "The release service returned an unknown error.",
      );
    }
  }

  async activity(): Promise<PlatformUpdateActivity> {
    // Eleven, so the newest can be lifted out with its log and ten summaries
    // remain. One query rather than two, because a run that finishes between
    // them would otherwise appear in neither.
    const [agent, rows] = await Promise.all([
      this.storedAgent(),
      this.database
        .select().from(platformUpdateRun)
        .orderBy(desc(platformUpdateRun.startedAt), desc(platformUpdateRun.recordedAt))
        .limit(11),
    ]);
    const [newest, ...older] = rows;
    return platformUpdateActivitySchema.parse({
      agent,
      latest: newest ? { ...runFields(newest), log: newest.log } : null,
      recent: older.map((row) => ({ ...runFields(row), hasLog: row.log !== null })),
    });
  }

  async approve(principal: AdminPrincipal, input: ApproveReleaseTarget): Promise<PlatformReleaseTarget> {
    const installed = parseReleaseVersion(this.currentVersion);
    if (!installed) {
      throw new ReleaseTargetUnavailableError(`The installed version '${this.currentVersion}' is not a release tag.`);
    }
    const desired = parseReleaseVersion(input.desiredVersion);
    if (!desired) {
      throw new ReleaseTargetValidationError(`'${input.desiredVersion}' is not an OrcaSynapse release tag.`);
    }
    /*
     * Compared against what is installed, not against a pending target. The
     * migrations are forward-only and there is no schema rollback, so moving
     * below the running release is the one direction that cannot be applied.
     * Replacing an approved-but-unapplied target with a lower one is a
     * correction, and stays allowed.
     */
    if (compareReleaseVersions(desired, installed) < 0) {
      throw new ReleaseTargetValidationError(
        `${desired.tag} is older than the installed ${installed.tag}, and the migrations are forward-only.`,
      );
    }

    // Resolved before the transaction opens: this is an eight-second network
    // budget, and holding a row lock across it would stall every other reader.
    const resolved = await this.resolve(desired.tag);
    if (!resolved) {
      throw new ReleaseTargetValidationError(`${desired.tag} is not a published OrcaSynapse release.`);
    }

    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock("orcasynapse-platform-release-target"));
      await transaction.insert(platformReleaseTarget).values({ id: "global" }).onConflictDoNothing();
      const [current] = await transaction
        .select().from(platformReleaseTarget)
        .where(eq(platformReleaseTarget.id, "global")).limit(1);
      if (!current) throw new ReleaseTargetConflictError("The release target record is missing.");
      if (current.revision !== input.expectedRevision) {
        throw new ReleaseTargetConflictError("The release target changed in another session. Refresh and try again.");
      }

      const [saved] = await transaction
        .update(platformReleaseTarget)
        .set({
          desiredVersion: resolved.tag,
          desiredCommit: resolved.commit,
          approvedBy: principal.id,
          approvedBySubject: principal.subject,
          approvedAt: new Date(),
          revision: increment(platformReleaseTarget.revision),
        })
        .where(eq(platformReleaseTarget.id, "global"))
        .returning();
      const approved = saved ? targetDto(saved) : null;
      if (!approved) throw new ReleaseTargetConflictError("The release target could not be recorded.");

      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "platform.release-target.approved",
        resourceType: "PlatformReleaseTarget",
        resourceId: "global",
        outcome: "SUCCESS",
        metadata: {
          desiredVersion: approved.desiredVersion,
          desiredCommit: approved.desiredCommit,
          installedVersion: installed.tag,
          previousVersion: current.desiredVersion,
        },
      });
      return approved;
    });
  }

  /*
   * No expected revision. Clearing only withdraws intent, so a stale caller can
   * at worst remove an approval that was about to be applied — never cause a
   * different version to be applied — and requiring a revision here would leave
   * an operator unable to withdraw an approval from a screen they had open.
   */
  async clear(principal: AdminPrincipal): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock("orcasynapse-platform-release-target"));
      await transaction.insert(platformReleaseTarget).values({ id: "global" }).onConflictDoNothing();
      const [current] = await transaction
        .select().from(platformReleaseTarget)
        .where(eq(platformReleaseTarget.id, "global")).limit(1);
      // Nothing approved: no state change, and therefore nothing to audit.
      if (!current || !targetDto(current)) return;

      await transaction
        .update(platformReleaseTarget)
        .set({
          desiredVersion: null,
          desiredCommit: null,
          approvedBy: null,
          approvedBySubject: null,
          approvedAt: null,
          revision: increment(platformReleaseTarget.revision),
        })
        .where(eq(platformReleaseTarget.id, "global"));
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "platform.release-target.cleared",
        resourceType: "PlatformReleaseTarget",
        resourceId: "global",
        outcome: "SUCCESS",
        metadata: {
          desiredVersion: current.desiredVersion,
          desiredCommit: current.desiredCommit,
        },
      });
    });
  }

  private async storedTarget(): Promise<PlatformReleaseTarget | null> {
    const [row] = await this.database
      .select().from(platformReleaseTarget)
      .where(eq(platformReleaseTarget.id, "global")).limit(1);
    return row ? targetDto(row) : null;
  }

  private async storedAgent(): Promise<PlatformUpdateAgent | null> {
    const [row] = await this.database
      .select().from(platformUpdateAgent)
      .where(eq(platformUpdateAgent.id, "global")).limit(1);
    if (!row) return null;
    return {
      phase: phaseOf(row.phase),
      detail: row.detail,
      installedVersion: row.installedVersion,
      installedCommit: row.installedCommit,
      currentRunId: row.currentRunId,
      checkedAt: row.checkedAt.toISOString(),
    };
  }

  /** A lookup failure is not a refusal, so the two reach the operator apart. */
  private async resolve(tag: string): Promise<ReleaseTarget | null> {
    try {
      return await resolveReleaseTarget(tag, this.fetchImplementation);
    } catch (error) {
      throw new ReleaseTargetUnavailableError(
        error instanceof Error ? error.message : "The release service returned an unknown error.",
      );
    }
  }
}
