import type { CreatePerson, Person, PersonList, UpdatePerson } from "@orcasynapse/contracts";
import {
  auditEvent,
  division,
  enterpriseUser,
  enterpriseUserSession,
  localAdministrator,
  localUser,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { LOCAL_PEOPLE_GROUP } from "@orcasynapse/contracts";
import { hashLocalPassword, localPasswordIsValid } from "@orcasynapse/security";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, isUniqueViolation } from "../database-support.js";

/**
 * The issuer a locally created person is keyed under.
 *
 * `EnterpriseUser` is unique on `(issuer, subject)`, and a real identity
 * provider owns its own issuer URL. A reserved non-URL value keeps locally
 * created people in the same table -- so divisions, sessions and
 * `profileVisibleTo` all work unchanged -- while making it impossible for an
 * IdP to collide with one.
 */
export const LOCAL_ISSUER = "orcasynapse:local";

export class PersonNotFoundError extends Error {
  constructor(message = "The person does not exist.") {
    super(message);
    this.name = "PersonNotFoundError";
  }
}

export class PersonConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonConflictError";
  }
}

type StoredUser = typeof enterpriseUser.$inferSelect;
type StoredCredential = typeof localUser.$inferSelect;

export class DrizzlePersonManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  private dto(user: StoredUser, credential: StoredCredential | null): Person {
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      divisionId: user.divisionId,
      enabled: user.enabled,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      credential: credential ? "LOCAL" : "FEDERATED",
      username: credential?.username ?? null,
      passwordChangeRequired: credential?.passwordChangeRequired ?? false,
      lockedUntil: credential?.lockedUntil?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  async list(): Promise<PersonList> {
    const rows = await this.database
      .select({ user: enterpriseUser, credential: localUser })
      .from(enterpriseUser)
      .leftJoin(localUser, eq(localUser.userId, enterpriseUser.id))
      .orderBy(asc(enterpriseUser.displayName))
      .limit(500);
    return { items: rows.map(({ user, credential }) => this.dto(user, credential)) };
  }

  async create(principal: AdminPrincipal, input: CreatePerson): Promise<Person> {
    /*
     * Checked here as well as by the contract because this is the one place a
     * password is chosen for somebody else. `localPasswordIsValid` is the same
     * predicate the administrator credential path uses, so the two cannot
     * diverge into different definitions of an acceptable password.
     */
    if (!localPasswordIsValid(input.password)) {
      throw new PersonConflictError("That password does not meet the local password policy.");
    }
    const passwordHash = await hashLocalPassword(input.password);
    try {
      return await this.database.transaction(async (transaction) => {
        if (input.divisionId) {
          const [target] = await transaction.select().from(division).where(eq(division.id, input.divisionId)).limit(1);
          if (!target) throw new PersonNotFoundError("The division does not exist.");
          if (target.status !== "ACTIVE") {
            throw new PersonConflictError(`${target.displayName} is suspended. Reactivate it before adding people to it.`);
          }
        }
        /*
         * One sign-in field, two stores. A person username that matches a
         * local administrator used to lock that administrator: the front page
         * probes admin first, a wrong password increments `failedLoginCount`,
         * and five People logins locked `admin` for fifteen minutes.
         */
        const [administrator] = await transaction
          .select({ id: localAdministrator.id })
          .from(localAdministrator)
          .where(eq(localAdministrator.username, input.username))
          .limit(1);
        if (administrator) throw new PersonConflictError("That username is already taken.");
        const [user] = await transaction
          .insert(enterpriseUser)
          .values({
            issuer: LOCAL_ISSUER,
            // The subject is the username, which is what makes the identity
            // stable across a display-name change and unique per issuer.
            subject: input.username,
            displayName: input.displayName,
            email: input.email ?? null,
            divisionId: input.divisionId ?? null,
            // Without this, no grant can ever match them: the matcher
            // intersects groups, and a person with none intersects nothing.
            groups: [LOCAL_PEOPLE_GROUP],
            // Never signed in yet, which is exactly what the nullable column
            // was widened to express.
            lastLoginAt: null,
          })
          .returning();
        if (!user) throw new PersonConflictError("The person could not be created.");
        const [credential] = await transaction
          .insert(localUser)
          .values({ userId: user.id, username: input.username, passwordHash, createdBy: principal.id })
          .returning();
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "person.created",
          resourceType: "EnterpriseUser", resourceId: user.id, outcome: "SUCCESS",
          metadata: { username: input.username, divisionId: input.divisionId ?? null },
        });
        return this.dto(user, credential ?? null);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new PersonConflictError("That username is already taken.");
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdatePerson): Promise<Person> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-person:${id}`));
      const [current] = await transaction.select().from(enterpriseUser).where(eq(enterpriseUser.id, id)).limit(1);
      if (!current) throw new PersonNotFoundError();
      if (input.divisionId) {
        const [target] = await transaction.select().from(division).where(eq(division.id, input.divisionId)).limit(1);
        if (!target) throw new PersonNotFoundError("The division does not exist.");
        if (target.status !== "ACTIVE") {
          throw new PersonConflictError(`${target.displayName} is suspended. Reactivate it before moving people into it.`);
        }
      }
      const [user] = await transaction
        .update(enterpriseUser)
        .set({
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.divisionId === undefined ? {} : { divisionId: input.divisionId }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        })
        .where(eq(enterpriseUser.id, id))
        .returning();
      if (!user) throw new PersonNotFoundError();
      /*
       * Disabling revokes every live session immediately.
       *
       * Without this the account is disabled for the next sign-in and unchanged
       * for the one already open, which is the opposite of what an
       * administrator disabling somebody means -- and the gap is as long as the
       * session's absolute lifetime.
       */
      if (input.enabled === false) {
        await transaction
          .update(enterpriseUserSession)
          .set({ revokedAt: new Date() })
          .where(and(eq(enterpriseUserSession.userId, id), isNull(enterpriseUserSession.revokedAt)));
      }
      const [credential] = await transaction.select().from(localUser).where(eq(localUser.userId, id)).limit(1);
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id,
        action: input.enabled === false ? "person.disabled" : "person.updated",
        resourceType: "EnterpriseUser", resourceId: id, outcome: "SUCCESS",
        metadata: { changedFields: Object.keys(input) },
      });
      return this.dto(user, credential ?? null);
    });
  }

  /**
   * Set a new password and require it to be changed at next sign-in.
   *
   * Also clears the lockout, because an administrator resetting a password is
   * the intended way out of one. Leaving it in force would mean a reset that
   * visibly succeeds and still refuses the new password.
   */
  async resetPassword(principal: AdminPrincipal, id: string, password: string): Promise<void> {
    if (!localPasswordIsValid(password)) {
      throw new PersonConflictError("That password does not meet the local password policy.");
    }
    const passwordHash = await hashLocalPassword(password);
    await this.database.transaction(async (transaction) => {
      const [credential] = await transaction.select().from(localUser).where(eq(localUser.userId, id)).limit(1);
      if (!credential) throw new PersonNotFoundError("That person signs in through an identity provider, so this product holds no password for them.");
      await transaction
        .update(localUser)
        .set({
          passwordHash,
          passwordChangeRequired: true,
          failedLoginCount: 0,
          lockedUntil: null,
          passwordChangedAt: new Date(),
        })
        .where(eq(localUser.id, credential.id));
      await transaction
        .update(enterpriseUserSession)
        .set({ revokedAt: new Date() })
        .where(and(eq(enterpriseUserSession.userId, id), isNull(enterpriseUserSession.revokedAt)));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "person.password_reset",
        resourceType: "EnterpriseUser", resourceId: id, outcome: "SUCCESS",
      });
    });
  }
}
