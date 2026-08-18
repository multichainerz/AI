import {
  createHash,
  randomBytes,
} from "node:crypto";
import { isIP } from "node:net";
import type { EnterpriseSession } from "@orcasynapse/contracts";
import {
  auditEvent,
  enterpriseUser,
  enterpriseUserSession,
  localUser,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import {
  DUMMY_PASSWORD_DIGEST,
  hashLocalPassword,
  localPasswordIsValid,
  verifyLocalPassword,
} from "@orcasynapse/security";
import { advisoryLock } from "../database-support.js";
import {
  LOCAL_LOGIN_FAILURE_LIMIT,
  LOCAL_LOGIN_LOCK_MS,
} from "../auth/admin-session.js";

export const ENTERPRISE_SESSION_COOKIE = "orcasynapse_user_session";
const ENTERPRISE_SESSION_IDLE_MS = 8 * 60 * 60 * 1_000;
const ENTERPRISE_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1_000;
const ENTERPRISE_SESSION_TOUCH_INTERVAL_MS = 60 * 1_000;

export interface IdentityRequestContext {
  sourceIp?: string | undefined;
  userAgent?: string | undefined;
}

export interface EnterprisePrincipal {
  id: string;
  subject: string;
  identityMode: "ENTERPRISE";
  displayName: string;
  email: string | null;
  scopes: ["chat:use", "agents:use"];
  /** The user's division, or null for a user in none. */
  divisionId: string | null;
  session: EnterpriseSession;
}

export interface IssuedEnterpriseSession {
  token: string;
  principal: EnterprisePrincipal;
}

export interface EnterpriseIdentityManager {
  /** Local sign-in, for a person an administrator created rather than an IdP. */
  signInWithPassword(
    username: string,
    password: string,
    context: IdentityRequestContext,
  ): Promise<IssuedEnterpriseSession>;
  /**
   * Replace a locally created person's temporary password and mint a new
   * session. Federated identities have no password here and are refused.
   */
  changeLocalPassword(
    token: string | undefined,
    currentPassword: string,
    newPassword: string,
    context: IdentityRequestContext,
  ): Promise<IssuedEnterpriseSession>;
  authenticate(token: string | undefined): Promise<EnterprisePrincipal | null>;
  revoke(token: string | undefined): Promise<boolean>;
}

export class EnterpriseIdentityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 401,
  ) {
    super(message);
    this.name = "EnterpriseIdentityError";
  }
}

function tokenDigest(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(token, "utf8").digest();
  const copy = new Uint8Array(digest.length);
  copy.set(digest);
  return copy;
}


function userAgentDigest(value: string | undefined): string | undefined {
  return value ? createHash("sha256").update(value, "utf8").digest("hex") : undefined;
}

function validOpaqueToken(token: string | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}









function principalFromRecord(record: {
  id: string;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  user: { id: string; displayName: string; email: string | null; divisionId?: string | null };
  passwordChangeRequired?: boolean;
}): EnterprisePrincipal {
  const session: EnterpriseSession = {
    id: record.id,
    identityMode: "ENTERPRISE",
    user: {
      id: record.user.id,
      displayName: record.user.displayName,
      email: record.user.email,
    },
    scopes: ["chat:use", "agents:use"],
    createdAt: record.createdAt.toISOString(),
    idleExpiresAt: record.idleExpiresAt.toISOString(),
    absoluteExpiresAt: record.absoluteExpiresAt.toISOString(),
    ...(record.passwordChangeRequired === true ? { passwordChangeRequired: true } : {}),
  };
  return {
    id: record.id,
    subject: `user:${record.user.id}`,
    identityMode: "ENTERPRISE",
    displayName: record.user.displayName,
    email: record.user.email,
    scopes: ["chat:use", "agents:use"],
    divisionId: record.user.divisionId ?? null,
    session,
  };
}

type LoadedSession = typeof enterpriseUserSession.$inferSelect & {
  user: typeof enterpriseUser.$inferSelect;
  passwordChangeRequired?: boolean;
};

export class DrizzleEnterpriseIdentityManager implements EnterpriseIdentityManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  /**
   * Sign in a locally created person with a username and password.
   *
   * Mirrors the administrator local-login path deliberately, down to the shared
   * failure limit and lock window: two credential stores are the real cost of
   * this option, and the mitigation is that neither can drift into its own
   * definition of "locked out".
   *
   * Three properties this borrows rather than reinvents, because each is easy
   * to get subtly wrong:
   *
   * - the password is verified against `DUMMY_PASSWORD_DIGEST` when no account
   *   matches, so an unknown username costs the same time as a wrong password
   *   and cannot be distinguished by timing;
   * - every rejection answers with one message, so the response cannot
   *   enumerate usernames either;
   * - an expired lock resets the count rather than resuming it, so somebody who
   *   waited out a lockout starts from zero.
   *
   * The session it mints is an ordinary `EnterpriseUserSession`. Everything
   * downstream -- the principal, its `divisionId`, `profileVisibleTo` -- is the
   * federated path unchanged, which is the whole reason locally created people
   * live in `EnterpriseUser` under a reserved issuer.
   */
  async signInWithPassword(
    username: string,
    password: string,
    context: IdentityRequestContext,
  ): Promise<IssuedEnterpriseSession> {
    const now = new Date();
    const sessionToken = randomBytes(32).toString("base64url");
    /*
     * The rejection is returned from the transaction, never thrown inside it.
     *
     * Throwing rolls the transaction back -- including the very row that records
     * the failed attempt. Written that way first, and the lockout test caught
     * it: `failedLoginCount` stayed at 0 no matter how many attempts were made,
     * so the account never locked and an attacker had unlimited guesses. The
     * counter has to commit before the caller is told no.
     */
    /*
     * The read and the hash happen before the transaction opens, not inside it.
     *
     * scrypt at the parameters this deployment uses costs about 800ms and
     * 128 MiB. Held inside a transaction it also held one of the connection
     * pool's ten clients for that whole time, so ten concurrent sign-ins --
     * unauthenticated, and the cheapest request an attacker can make -- drained
     * the pool and blocked every other database-backed route, including the
     * `/readyz` the api container's own healthcheck calls.
     *
     * The hash still runs for an unknown username, against a dummy digest, so
     * the answer takes the same time either way and does not disclose whether an
     * account exists.
     */
    const [found] = await this.database
      .select({ credential: localUser, user: enterpriseUser })
      .from(localUser)
      .innerJoin(enterpriseUser, eq(enterpriseUser.id, localUser.userId))
      .where(eq(localUser.username, username))
      .limit(1);
    const passwordMatches = await verifyLocalPassword(
      password,
      found?.credential.passwordHash ?? DUMMY_PASSWORD_DIGEST,
    );

    const outcome = await this.database.transaction(async (transaction) => {
      /*
       * Re-read under the transaction, because ~800ms passed.
       *
       * The lockout state and the failure counter must come from committed state
       * rather than from the row this attempt read before hashing, or two
       * concurrent attempts would each increment from the same starting value
       * and the account would take twice as many guesses to lock. The password
       * hash is compared too: if it changed while this attempt was hashing, the
       * password just verified is no longer the account's, and accepting it
       * would let a rotated credential keep working for the length of one KDF.
       */
      const [current] = found
        ? await transaction
          .select({ credential: localUser, user: enterpriseUser })
          .from(localUser)
          .innerJoin(enterpriseUser, eq(enterpriseUser.id, localUser.userId))
          .where(eq(localUser.id, found.credential.id))
          .limit(1)
        : [undefined];
      const stale = Boolean(found && current && current.credential.passwordHash !== found.credential.passwordHash);
      const lockActive = Boolean(current?.credential.lockedUntil && current.credential.lockedUntil > now);
      const accepted = Boolean(current && current.user.enabled && !lockActive && passwordMatches && !stale);

      if (!accepted) {
        if (current && current.user.enabled && !lockActive) {
          const priorFailures = current.credential.lockedUntil && current.credential.lockedUntil <= now
            ? 0
            : current.credential.failedLoginCount;
          const failedLoginCount = priorFailures + 1;
          await transaction
            .update(localUser)
            .set({
              failedLoginCount,
              lockedUntil: failedLoginCount >= LOCAL_LOGIN_FAILURE_LIMIT
                ? new Date(now.getTime() + LOCAL_LOGIN_LOCK_MS)
                : null,
            })
            .where(eq(localUser.id, current.credential.id));
        }
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: current?.user.id ?? null, action: "user.local_login_failed",
          resourceType: "EnterpriseUser", resourceId: current?.user.id ?? null, outcome: "FAILURE",
          metadata: { username, reason: lockActive ? "LOCKED" : "REJECTED" },
        });
        return { rejected: true as const };
      }

      await transaction
        .update(localUser)
        .set({ failedLoginCount: 0, lockedUntil: null })
        .where(eq(localUser.id, current!.credential.id));
      const [user] = await transaction
        .update(enterpriseUser)
        .set({ lastLoginAt: now })
        .where(eq(enterpriseUser.id, current!.user.id))
        .returning();
      if (!user) throw new EnterpriseIdentityError("USER_UNAVAILABLE", "The account could not be read.", 503);
      const [created] = await transaction
        .insert(enterpriseUserSession)
        .values({
          tokenHash: tokenDigest(sessionToken),
          userId: user.id,
          lastSeenAt: now,
          idleExpiresAt: new Date(now.getTime() + ENTERPRISE_SESSION_IDLE_MS),
          absoluteExpiresAt: new Date(now.getTime() + ENTERPRISE_SESSION_ABSOLUTE_MS),
          sourceIp: context.sourceIp ?? null,
          userAgentHash: userAgentDigest(context.userAgent) ?? null,
        })
        .returning();
      if (!created) throw new EnterpriseIdentityError("USER_SESSION_UNAVAILABLE", "The session could not be created.", 503);
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: user.id, action: "user.local_login_succeeded",
        resourceType: "EnterpriseUser", resourceId: user.id, outcome: "SUCCESS",
      });
      return {
        rejected: false as const,
        principal: principalFromRecord({
          ...created,
          user,
          passwordChangeRequired: current!.credential.passwordChangeRequired,
        }),
      };
    });
    if (outcome.rejected) {
      throw new EnterpriseIdentityError("USER_LOGIN_REJECTED", "That username and password do not match an account.", 401);
    }
    return { token: sessionToken, principal: outcome.principal };
  }

  /**
   * Replace a locally created person's password and burn every other session.
   *
   * The route checks `authenticate` first so an expired cookie is not reported
   * as a wrong password — the same split the administrator change uses, and
   * for the same reason: this is the first screen after a generated password
   * is copied out of a vault.
   *
   * Same password, a password that fails the policy, and an IdP account are
   * 400s rather than the administrator path's collapsed `null` → 401. The
   * current password being wrong is the only 401 this method itself raises.
   */
  async changeLocalPassword(
    token: string | undefined,
    currentPassword: string,
    newPassword: string,
    context: IdentityRequestContext,
  ): Promise<IssuedEnterpriseSession> {
    if (!validOpaqueToken(token)) {
      throw new EnterpriseIdentityError(
        "SESSION_EXPIRED",
        "This session expired. Sign in again to set a new password.",
        401,
      );
    }
    if (!localPasswordIsValid(currentPassword) || !localPasswordIsValid(newPassword)) {
      throw new EnterpriseIdentityError(
        "USER_PASSWORD_INVALID",
        "A valid current password and a different new password are required.",
        400,
      );
    }
    if (currentPassword === newPassword) {
      throw new EnterpriseIdentityError(
        "USER_PASSWORD_INVALID",
        "The new password must be different from the current password.",
        400,
      );
    }
    const now = new Date();
    const replacementToken = randomBytes(32).toString("base64url");
    const newPasswordHash = await hashLocalPassword(newPassword);
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ session: enterpriseUserSession, user: enterpriseUser, credential: localUser })
        .from(enterpriseUserSession)
        .innerJoin(enterpriseUser, eq(enterpriseUserSession.userId, enterpriseUser.id))
        .leftJoin(localUser, eq(localUser.userId, enterpriseUser.id))
        .where(eq(enterpriseUserSession.tokenHash, tokenDigest(token)))
        .limit(1);
      if (
        !row
        || row.session.revokedAt
        || !row.user.enabled
        || row.session.idleExpiresAt <= now
        || row.session.absoluteExpiresAt <= now
      ) {
        throw new EnterpriseIdentityError(
          "SESSION_EXPIRED",
          "This session expired. Sign in again to set a new password.",
          401,
        );
      }
      if (!row.credential) {
        throw new EnterpriseIdentityError(
          "USER_PASSWORD_UNSUPPORTED",
          "This account signs in through an identity provider, so this product holds no password for it.",
          400,
        );
      }
      await transaction.execute(advisoryLock(`orcasynapse-person:${row.user.id}`));
      const [credential] = await transaction
        .select()
        .from(localUser)
        .where(eq(localUser.id, row.credential.id))
        .limit(1);
      if (!credential || !(await verifyLocalPassword(currentPassword, credential.passwordHash))) {
        throw new EnterpriseIdentityError("UNAUTHORIZED", "The current password is incorrect.", 401);
      }
      await transaction
        .update(localUser)
        .set({
          passwordHash: newPasswordHash,
          passwordChangeRequired: false,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(localUser.id, credential.id));
      await transaction
        .update(enterpriseUserSession)
        .set({ revokedAt: now })
        .where(and(eq(enterpriseUserSession.userId, row.user.id), isNull(enterpriseUserSession.revokedAt)));
      const [created] = await transaction
        .insert(enterpriseUserSession)
        .values({
          tokenHash: tokenDigest(replacementToken),
          userId: row.user.id,
          lastSeenAt: now,
          idleExpiresAt: new Date(now.getTime() + ENTERPRISE_SESSION_IDLE_MS),
          absoluteExpiresAt: new Date(now.getTime() + ENTERPRISE_SESSION_ABSOLUTE_MS),
          sourceIp,
          userAgentHash: userAgentDigest(context.userAgent) ?? null,
        })
        .returning();
      if (!created) {
        throw new EnterpriseIdentityError("USER_SESSION_UNAVAILABLE", "The session could not be created.", 503);
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: row.user.id,
        action: "user.local_password_changed",
        resourceType: "EnterpriseUser",
        resourceId: row.user.id,
        outcome: "SUCCESS",
        sourceIp,
        metadata: { revokedOtherSessions: true },
      });
      return {
        token: replacementToken,
        principal: principalFromRecord({ ...created, user: row.user }),
      };
    });
  }

  async authenticate(token: string | undefined): Promise<EnterprisePrincipal | null> {
    if (!validOpaqueToken(token)) return null;
    const now = new Date();
    const [row] = await this.database
      .select({ session: enterpriseUserSession, user: enterpriseUser, credential: localUser })
      .from(enterpriseUserSession)
      .innerJoin(enterpriseUser, eq(enterpriseUserSession.userId, enterpriseUser.id))
      .leftJoin(localUser, eq(localUser.userId, enterpriseUser.id))
      .where(eq(enterpriseUserSession.tokenHash, tokenDigest(token)))
      .limit(1);
    const session: LoadedSession | undefined = row
      ? {
          ...row.session,
          user: row.user,
          passwordChangeRequired: row.credential?.passwordChangeRequired === true,
        }
      : undefined;
    if (
      !session || session.revokedAt || !session.user.enabled ||
      session.idleExpiresAt <= now || session.absoluteExpiresAt <= now
    ) {
      if (session && !session.revokedAt) {
        await this.database
          .update(enterpriseUserSession)
          .set({ revokedAt: now })
          .where(and(eq(enterpriseUserSession.id, session.id), isNull(enterpriseUserSession.revokedAt)));
      }
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() < ENTERPRISE_SESSION_TOUCH_INTERVAL_MS) {
      return principalFromRecord(session);
    }
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + ENTERPRISE_SESSION_IDLE_MS, session.absoluteExpiresAt.getTime()),
    );
    // The predicate re-checks every liveness condition so a concurrent revoke or
    // expiry between the read and the write loses rather than being overwritten.
    const updated = await this.database
      .update(enterpriseUserSession)
      .set({ lastSeenAt: now, idleExpiresAt })
      .where(and(
        eq(enterpriseUserSession.id, session.id),
        isNull(enterpriseUserSession.revokedAt),
        lte(enterpriseUserSession.lastSeenAt, new Date(now.getTime() - ENTERPRISE_SESSION_TOUCH_INTERVAL_MS)),
        gt(enterpriseUserSession.idleExpiresAt, now),
        gt(enterpriseUserSession.absoluteExpiresAt, now),
      ))
      .returning({ id: enterpriseUserSession.id });
    if (updated.length === 1) return principalFromRecord({ ...session, idleExpiresAt });
    return this.touchLost(session, now);
  }

  /**
   * Answers a touch that matched no row, which is not by itself a refusal.
   *
   * Only three of that predicate's clauses are about whether the session is
   * alive; the lastSeenAt clause is a write throttle, and it is the one a
   * concurrent *success* falsifies. Under READ COMMITTED the second writer
   * blocks on the winner's row lock and then re-evaluates against the winner's
   * tuple, where lastSeenAt is a moment old rather than a minute. Reading that
   * as an authentication failure signed users out whenever a burst of requests
   * followed a gap longer than the touch interval -- which is what a dashboard
   * screen loading seven endpoints at once produces every time.
   *
   * The throttle may therefore lose the write; liveness is then asked again,
   * against the row as it stands rather than the copy read before the race, so
   * a revoke, an expiry or a disabled user landing in the same window still
   * refuses. The twin of this is in auth/admin-session.ts, on the same shape.
   */
  private async touchLost(session: LoadedSession, now: Date): Promise<EnterprisePrincipal | null> {
    const [current] = await this.database
      .select({
        revokedAt: enterpriseUserSession.revokedAt,
        idleExpiresAt: enterpriseUserSession.idleExpiresAt,
        absoluteExpiresAt: enterpriseUserSession.absoluteExpiresAt,
        enabled: enterpriseUser.enabled,
      })
      .from(enterpriseUserSession)
      .innerJoin(enterpriseUser, eq(enterpriseUserSession.userId, enterpriseUser.id))
      .where(eq(enterpriseUserSession.id, session.id))
      .limit(1);
    if (
      !current || current.revokedAt || !current.enabled ||
      current.idleExpiresAt <= now || current.absoluteExpiresAt <= now
    ) return null;
    // The winner's idle window, which is the one now on record.
    return principalFromRecord({ ...session, idleExpiresAt: current.idleExpiresAt });
  }

  async revoke(token: string | undefined): Promise<boolean> {
    if (!validOpaqueToken(token)) return false;
    const [session] = await this.database
      .select({ id: enterpriseUserSession.id, revokedAt: enterpriseUserSession.revokedAt })
      .from(enterpriseUserSession)
      .where(eq(enterpriseUserSession.tokenHash, tokenDigest(token)))
      .limit(1);
    if (!session || session.revokedAt) return false;
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const revoked = await transaction
        .update(enterpriseUserSession)
        .set({ revokedAt: now })
        .where(and(eq(enterpriseUserSession.id, session.id), isNull(enterpriseUserSession.revokedAt)))
        .returning({ id: enterpriseUserSession.id });
      if (revoked.length !== 1) return false;
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: session.id,
        action: "enterprise.session_revoked",
        resourceType: "EnterpriseUserSession",
        resourceId: session.id,
        outcome: "SUCCESS",
        metadata: {},
      });
      return true;
    });
  }

}

export function enterpriseSessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieValue(cookieHeader, ENTERPRISE_SESSION_COOKIE);
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function cookie(
  name: string,
  value: string,
  path: string,
  maxAge: number,
  secure: boolean,
): string {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function enterpriseSessionCookie(token: string, secure: boolean): string {
  return cookie(
    ENTERPRISE_SESSION_COOKIE,
    token,
    "/api/v1",
    Math.floor(ENTERPRISE_SESSION_ABSOLUTE_MS / 1_000),
    secure,
  );
}

export function expiredEnterpriseSessionCookie(secure: boolean): string {
  return cookie(ENTERPRISE_SESSION_COOKIE, "", "/api/v1", 0, secure);
}

