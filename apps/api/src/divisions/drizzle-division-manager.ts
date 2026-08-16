import type {
  CreateDivision,
  Division,
  DivisionList,
  UpdateDivision,
} from "@orcasynapse/contracts";
import {
  agentProfile,
  auditEvent,
  division,
  enterpriseUser,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, eq } from "drizzle-orm";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import {
  DivisionConflictError,
  DivisionNotFoundError,
  type DivisionManager,
} from "./division-manager.js";

type StoredDivision = typeof division.$inferSelect;

export class DrizzleDivisionManager implements DivisionManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  private dto(row: StoredDivision, profiles: number, users: number): Division {
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      description: row.description,
      status: row.status,
      profileCount: profiles,
      userCount: users,
      revision: row.revision,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * What each division currently holds.
   *
   * Two grouped counts rather than a counter column: a stored count that drifts
   * from the rows would be read as authoritative by the very screen that exists
   * to show an administrator what a change is about to affect.
   */
  private async membership(): Promise<{ profiles: Map<string, number>; users: Map<string, number> }> {
    const [profiles, users] = await Promise.all([
      this.database
        .select({ divisionId: agentProfile.divisionId, total: count() })
        .from(agentProfile)
        .groupBy(agentProfile.divisionId),
      this.database
        .select({ divisionId: enterpriseUser.divisionId, total: count() })
        .from(enterpriseUser)
        .groupBy(enterpriseUser.divisionId),
    ]);
    return {
      profiles: new Map(profiles.filter((row) => row.divisionId).map((row) => [row.divisionId!, row.total])),
      users: new Map(users.filter((row) => row.divisionId).map((row) => [row.divisionId!, row.total])),
    };
  }

  async list(includeSuspended: boolean): Promise<DivisionList> {
    const [rows, held] = await Promise.all([
      this.database
        .select()
        .from(division)
        .where(includeSuspended ? undefined : eq(division.status, "ACTIVE"))
        .orderBy(asc(division.displayName))
        .limit(500),
      this.membership(),
    ]);
    return {
      items: rows.map((row) => this.dto(row, held.profiles.get(row.id) ?? 0, held.users.get(row.id) ?? 0)),
    };
  }

  async create(principal: AdminPrincipal, input: CreateDivision): Promise<Division> {
    try {
      const created = await this.database.transaction(async (transaction) => {
        const [row] = await transaction
          .insert(division)
          .values({
            slug: input.slug,
            displayName: input.displayName,
            description: input.description ?? "",
            createdBy: principal.id,
            updatedBy: principal.id,
          })
          .returning();
        if (!row) throw new DivisionConflictError("The division could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "division.created",
          resourceType: "Division", resourceId: row.id, outcome: "SUCCESS",
          metadata: { slug: row.slug },
        });
        return row;
      });
      // Freshly created, so it holds nothing yet.
      return this.dto(created, 0, 0);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DivisionConflictError("A division with that slug already exists.");
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdateDivision): Promise<Division> {
    const { expectedRevision, ...changes } = input;
    const updated = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-division:${id}`));
      const [current] = await transaction.select().from(division).where(eq(division.id, id)).limit(1);
      if (!current) throw new DivisionNotFoundError();
      const [row] = await transaction
        .update(division)
        .set({
          ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.status === undefined ? {} : { status: changes.status }),
          revision: increment(division.revision),
          updatedBy: principal.id,
        })
        .where(and(eq(division.id, id), eq(division.revision, expectedRevision)))
        .returning();
      if (!row) throw new DivisionConflictError("The division changed in another session. Refresh and try again.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "division.updated",
        resourceType: "Division", resourceId: id, outcome: "SUCCESS",
        metadata: { changedFields: Object.keys(changes) },
      });
      return row;
    });
    const held = await this.membership();
    return this.dto(updated, held.profiles.get(id) ?? 0, held.users.get(id) ?? 0);
  }

  /**
   * Delete only an empty division.
   *
   * A division that still holds profiles or users cannot be deleted, and the
   * refusal says which. `ON DELETE RESTRICT` is the backstop; this exists so the
   * answer is a sentence an administrator can act on rather than a constraint
   * violation. Suspending is the way to take a division out of use without
   * deciding what happens to what it holds.
   */
  async remove(principal: AdminPrincipal, id: string): Promise<void> {
    const [current] = await this.database.select().from(division).where(eq(division.id, id)).limit(1);
    if (!current) throw new DivisionNotFoundError();
    const held = await this.membership();
    const profiles = held.profiles.get(id) ?? 0;
    const users = held.users.get(id) ?? 0;
    if (profiles > 0 || users > 0) {
      const parts = [
        profiles > 0 ? `${profiles} agent profile${profiles === 1 ? "" : "s"}` : null,
        users > 0 ? `${users} user${users === 1 ? "" : "s"}` : null,
      ].filter(Boolean).join(" and ");
      throw new DivisionConflictError(
        `${current.displayName} still holds ${parts}. Move them elsewhere, or suspend the division instead of deleting it.`,
      );
    }
    await this.database.transaction(async (transaction) => {
      await transaction.delete(division).where(eq(division.id, id));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "division.deleted",
        resourceType: "Division", resourceId: id, outcome: "SUCCESS",
        metadata: { slug: current.slug },
      });
    });
  }

  async assignProfile(
    principal: AdminPrincipal,
    profileId: string,
    divisionId: string | null,
    expectedRevision: number,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-agent-profile:${profileId}`));
      if (divisionId !== null) {
        const [target] = await transaction.select().from(division).where(eq(division.id, divisionId)).limit(1);
        if (!target) throw new DivisionNotFoundError();
        /*
         * A suspended division is one an administrator has taken out of use, so
         * moving a profile *into* it would create work nobody can reach. Moving
         * a profile out of one is always allowed, which is why this check is
         * only on the target.
         */
        if (target.status !== "ACTIVE") {
          throw new DivisionConflictError(`${target.displayName} is suspended. Reactivate it before assigning profiles to it.`);
        }
      }
      const [profile] = await transaction.select().from(agentProfile).where(eq(agentProfile.id, profileId)).limit(1);
      if (!profile) throw new DivisionNotFoundError("The agent profile does not exist.");
      /*
       * `currentVersion` stands in for a revision column the profile does not
       * have. It moves on every configuration change, so a caller holding a
       * stale profile cannot silently re-home it after somebody else edited it.
       */
      if (profile.currentVersion !== expectedRevision) {
        throw new DivisionConflictError("The agent profile changed in another session. Refresh and try again.");
      }
      await transaction.update(agentProfile).set({ divisionId }).where(eq(agentProfile.id, profileId));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id,
        action: divisionId === null ? "division.profile_unassigned" : "division.profile_assigned",
        resourceType: "AgentProfile", resourceId: profileId, outcome: "SUCCESS",
        metadata: { divisionId, previousDivisionId: profile.divisionId },
      });
    });
  }
}
