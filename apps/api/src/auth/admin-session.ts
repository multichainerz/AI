import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type AdminAuthenticationMethod,
  type AdminRole,
  type AdminScope,
} from "@orcasynapse/contracts";
import { and, eq, isNull, lt, lte, gt, or } from "drizzle-orm";
import {
  administratorSession,
  auditEvent,
  installationCredential,
  localAdministrator,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import {
  DUMMY_PASSWORD_DIGEST,
  hashLocalPassword,
  localPasswordIsValid,
  verifyLocalPassword,
} from "@orcasynapse/security";
import type { FastifyReply, FastifyRequest } from "fastify";
import { advisoryLock } from "../database-support.js";
import type { InstallationKeyVerifier } from "./installation-key-auth.js";

export const ADMIN_SESSION_COOKIE = "orcasynapse_admin_session";
export const ADMIN_SESSION_IDLE_MS = 15 * 60 * 1_000;
const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1_000;
export const ADMIN_SESSION_TOUCH_INTERVAL_MS = 60 * 1_000;
const ADMIN_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const LOCAL_LOGIN_FAILURE_LIMIT = 5;
/*
 * Exported so the local *user* sign-in path uses the same number.
 *
 * The plan's checklist names this explicitly: two credential stores are the real
 * cost of local passwords, and the mitigation is that both read one constant
 * rather than two that drift into different definitions of "locked out".
 */
export const LOCAL_LOGIN_LOCK_MS = 15 * 60 * 1_000;

const ROLE_SCOPES: Readonly<Record<AdminRole, readonly AdminScope[]>> = {
  PLATFORM_ADMIN: ADMIN_SCOPES,
  SECURITY_ADMIN: [
    "connections:read",
    "connections:write",
    "connections:test",
    "operations:read",
    "audit:read",
    "sessions:manage",
    "models:read",
    "models:manage",
    "guardrails:read",
    "guardrails:manage",
    "prompts:read",
    "prompts:manage",
    "agents:read",
    "agents:manage",
    "agents:control",
    "corpus:metadata:read",
    "corpus:content:read",
    "corpus:write",
    "corpus:approve",
    "corpus:delete",
    "tools:read",
    "tools:manage",
    "readiness:read",
    "readiness:manage",
    "readiness:approve",
  ],
  OPERATIONS_ADMIN: [
    "connections:read",
    "connections:test",
    "operations:read",
    "operations:execute",
    "corpus:metadata:read",
    "models:read",
    "guardrails:read",
    "prompts:read",
    "agents:read",
    "agents:control",
    "tools:read",
    "readiness:read",
    "readiness:manage",
  ],
  AUDITOR: ["connections:read", "operations:read", "audit:read", "models:read", "guardrails:read", "prompts:read", "agents:read", "corpus:metadata:read", "corpus:content:read", "tools:read", "readiness:read"],
};

export interface AdminPrincipal extends AdministratorSession {}

export interface AdminRequestContext {
  sourceIp?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedAdminSession {
  token: string;
  principal: AdminPrincipal;
}

export interface AdminSessionManager {
  createInstallationKeySession(
    installationKey: string | undefined,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null>;
  createLocalPasswordSession?(
    username: string,
    password: string,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null>;
  changeLocalPassword?(
    token: string | undefined,
    currentPassword: string,
    newPassword: string,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null>;
  recoverLocalAdministrator?(
    token: string | undefined,
    username: string,
    newPassword: string,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null>;
  issueFederatedSession?(
    subject: string,
    role: AdminRole,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession>;
  authenticate(token: string | undefined, requiredScope?: AdminScope): Promise<AdminPrincipal | null>;
  revoke(token: string | undefined): Promise<boolean>;
}

function tokenDigest(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(token, "utf8").digest();
  const result = new Uint8Array(digest.length);
  result.set(digest);
  return result;
}

function userAgentDigest(userAgent: string | undefined): string | undefined {
  return userAgent ? createHash("sha256").update(userAgent, "utf8").digest("hex") : undefined;
}

function sessionTokenIsValid(token: string | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function principalFromRecord(record: {
  id: string;
  subject: string;
  role: AdminRole;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  authenticationMethod: AdminAuthenticationMethod;
  passwordChangeRequired: boolean;
}): AdminPrincipal {
  return {
    id: record.id,
    subject: record.subject,
    role: record.role,
    scopes: record.authenticationMethod === "INSTALLATION_KEY_RECOVERY"
      ? ["sessions:manage"]
      : [...ROLE_SCOPES[record.role]],
    createdAt: record.createdAt.toISOString(),
    idleExpiresAt: record.idleExpiresAt.toISOString(),
    absoluteExpiresAt: record.absoluteExpiresAt.toISOString(),
    authenticationMethod: record.authenticationMethod,
    passwordChangeRequired: record.passwordChangeRequired,
  };
}

function normalizedLocalUsername(username: string): string | null {
  const normalized = username.trim().toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(normalized) ? normalized : null;
}

function activeSession(record: {
  revokedAt: Date | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}, now: Date): boolean {
  return !record.revokedAt && record.idleExpiresAt > now && record.absoluteExpiresAt > now;
}

/** The database handle or a transaction opened from it. */
type Executor = OrcaSynapseDatabase | Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0];

type StoredSession = typeof administratorSession.$inferSelect;

async function createSessionRecord(
  transaction: Executor,
  input: {
    token: string;
    subject: string;
    role: AdminRole;
    authenticationMethod: AdminAuthenticationMethod;
    passwordChangeRequired: boolean;
    context: AdminRequestContext;
    now: Date;
  },
): Promise<StoredSession> {
  const absoluteExpiresAt = new Date(input.now.getTime() + ADMIN_SESSION_ABSOLUTE_MS);
  // Expired sessions are pruned on issue rather than by a sweeper, so the table
  // stays bounded without another moving part.
  await transaction
    .delete(administratorSession)
    .where(lt(administratorSession.absoluteExpiresAt, new Date(input.now.getTime() - ADMIN_SESSION_RETENTION_MS)));

  const [created] = await transaction
    .insert(administratorSession)
    .values({
      tokenHash: tokenDigest(input.token),
      subject: input.subject,
      role: input.role,
      authenticationMethod: input.authenticationMethod,
      passwordChangeRequired: input.passwordChangeRequired,
      lastSeenAt: input.now,
      idleExpiresAt: new Date(input.now.getTime() + ADMIN_SESSION_IDLE_MS),
      absoluteExpiresAt,
      sourceIp: input.context.sourceIp && isIP(input.context.sourceIp) ? input.context.sourceIp : null,
      userAgentHash: userAgentDigest(input.context.userAgent) ?? null,
    })
    .returning();
  if (!created) throw new Error("The administrator session could not be created.");
  return created;
}

export class DrizzleAdminSessionManager implements AdminSessionManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly installationKeyAuthenticator: InstallationKeyVerifier,
  ) {}

  private async sessionByToken(executor: Executor, token: string): Promise<StoredSession | undefined> {
    const [session] = await executor
      .select()
      .from(administratorSession)
      .where(eq(administratorSession.tokenHash, tokenDigest(token)))
      .limit(1);
    return session;
  }

  /**
   * Revokes outstanding recovery sessions once the mounted Installation Key
   * stops matching the digest recorded for it.
   *
   * Rotation used to take effect only when somebody later signed in with the
   * new key. The operator response to a suspected leak is to write a new key
   * file and restart, and nothing in that sequence presents a key — so an
   * attacker's recovery row survived for its full absolute lifetime and could
   * still reset the local administrator password.
   */
  private async installationKeyRotated(executor: Executor, now: Date): Promise<boolean> {
    const [credential] = await executor
      .select({ keyHash: installationCredential.keyHash })
      .from(installationCredential)
      .where(eq(installationCredential.id, "primary"))
      .limit(1);
    if (!credential || this.installationKeyAuthenticator.matchesDigest(credential.keyHash)) return false;

    await executor
      .update(administratorSession)
      .set({ revokedAt: now })
      .where(
        and(
          eq(administratorSession.authenticationMethod, "INSTALLATION_KEY_RECOVERY"),
          isNull(administratorSession.revokedAt),
        ),
      );
    return true;
  }

  async createInstallationKeySession(
    installationKey: string | undefined,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null> {
    if (!installationKey || !this.installationKeyAuthenticator.verify(installationKey)) {
      // Nothing rate-limits break-glass, so a refusal that wrote nothing let the
      // Installation Key be probed indefinitely while the audit review showed a
      // clean log. The local-password path records every failure; so does this.
      await this.database.insert(auditEvent).values({
        actorType: "USER",
        action: "administrator.installation_key_login_failed",
        resourceType: "InstallationCredential",
        resourceId: "primary",
        outcome: "FAILED",
        sourceIp: context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null,
        metadata: { authenticationMethod: "installation-key-recovery" },
      });
      return null;
    }

    const token = randomBytes(32).toString("base64url");
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    const now = new Date();
    const idleExpiresAt = new Date(now.getTime() + ADMIN_SESSION_IDLE_MS);
    const absoluteExpiresAt = new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_MS);
    const session = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock("orcasynapse-installation-key"));
      const keyHash = tokenDigest(installationKey);
      const [existingCredential] = await transaction
        .select()
        .from(installationCredential)
        .where(eq(installationCredential.id, "primary"))
        .limit(1);

      if (existingCredential) {
        const expectedHash = Buffer.from(existingCredential.keyHash);
        const keyMatches = expectedHash.byteLength === keyHash.byteLength && timingSafeEqual(expectedHash, keyHash);
        if (!keyMatches) {
          // The root-owned mounted file is the authority for an intentional key
          // rotation. The candidate already passed constant-time verification
          // against that file before this transaction.
          await transaction
            .update(installationCredential)
            .set({ keyHash, activatedAt: null, lastSessionId: null, lastSourceIp: sourceIp })
            .where(eq(installationCredential.id, "primary"));
          await transaction
            .update(administratorSession)
            .set({ revokedAt: now })
            .where(
              and(
                eq(administratorSession.subject, "installation-key-administrator"),
                isNull(administratorSession.revokedAt),
              ),
            );
        }
      }

      await transaction
        .delete(administratorSession)
        .where(lt(administratorSession.absoluteExpiresAt, new Date(now.getTime() - ADMIN_SESSION_RETENTION_MS)));

      const [created] = await transaction
        .insert(administratorSession)
        .values({
          tokenHash: tokenDigest(token),
          subject: "installation-key-administrator",
          role: "PLATFORM_ADMIN",
          authenticationMethod: "INSTALLATION_KEY_RECOVERY",
          passwordChangeRequired: true,
          lastSeenAt: now,
          idleExpiresAt,
          absoluteExpiresAt,
          sourceIp,
          userAgentHash: userAgentDigest(context.userAgent) ?? null,
        })
        .returning();
      if (!created) throw new Error("The recovery session could not be created.");

      if (existingCredential) {
        await transaction
          .update(installationCredential)
          .set({
            keyHash,
            activatedAt: existingCredential.activatedAt ?? now,
            lastSessionId: created.id,
            lastSourceIp: sourceIp,
          })
          .where(eq(installationCredential.id, "primary"));
      } else {
        await transaction.insert(installationCredential).values({
          id: "primary",
          keyHash,
          activatedAt: now,
          lastSessionId: created.id,
          lastSourceIp: sourceIp,
        });
      }

      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: created.id,
        action: "administrator.session_created",
        resourceType: "AdministratorSession",
        resourceId: created.id,
        outcome: "SUCCESS",
        sourceIp,
        metadata: { role: created.role, authenticationMethod: "installation-key-recovery" },
      });
      return created;
    });

    return session ? { token, principal: principalFromRecord(session) } : null;
  }

  async createLocalPasswordSession(
    username: string,
    password: string,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null> {
    const normalizedUsername = normalizedLocalUsername(username);
    if (!normalizedUsername || !localPasswordIsValid(password)) return null;

    const token = randomBytes(32).toString("base64url");
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-local-admin:${normalizedUsername}`));
      const [account] = await transaction
        .select()
        .from(localAdministrator)
        .where(eq(localAdministrator.username, normalizedUsername))
        .limit(1);
      const passwordMatches = await verifyLocalPassword(password, account?.passwordHash ?? DUMMY_PASSWORD_DIGEST);
      const lockActive = Boolean(account?.lockedUntil && account.lockedUntil > now);
      const accepted = Boolean(account && !account.disabledAt && !lockActive && passwordMatches);

      if (!accepted) {
        if (account && !account.disabledAt && !lockActive) {
          const priorFailures = account.lockedUntil && account.lockedUntil <= now ? 0 : account.failedLoginCount;
          const failedLoginCount = priorFailures + 1;
          await transaction
            .update(localAdministrator)
            .set({
              failedLoginCount,
              lockedUntil: failedLoginCount >= LOCAL_LOGIN_FAILURE_LIMIT
                ? new Date(now.getTime() + LOCAL_LOGIN_LOCK_MS)
                : null,
            })
            .where(eq(localAdministrator.id, account.id));
        }
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: account?.id ?? null,
          action: "administrator.local_login_failed",
          resourceType: "LocalAdministrator",
          resourceId: account?.id ?? null,
          outcome: "FAILED",
          sourceIp,
          metadata: { authenticationMethod: "local-password" },
        });
        return null;
      }

      await transaction
        .update(localAdministrator)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
        .where(eq(localAdministrator.id, account!.id));
      const created = await createSessionRecord(transaction, {
        token,
        subject: `local-admin:${account!.id}`,
        role: account!.role,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: account!.passwordChangeRequired,
        context,
        now,
      });
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: account!.id,
        action: "administrator.session_created",
        resourceType: "AdministratorSession",
        resourceId: created.id,
        outcome: "SUCCESS",
        sourceIp,
        metadata: { role: created.role, authenticationMethod: "local-password" },
      });
      return { token, principal: principalFromRecord(created) };
    });
  }

  async changeLocalPassword(
    token: string | undefined,
    currentPassword: string,
    newPassword: string,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null> {
    if (
      !sessionTokenIsValid(token)
      || !localPasswordIsValid(currentPassword)
      || !localPasswordIsValid(newPassword)
      || currentPassword === newPassword
    ) return null;
    const now = new Date();
    const preliminarySession = await this.sessionByToken(this.database, token);
    if (
      !preliminarySession
      || !activeSession(preliminarySession, now)
      || preliminarySession.authenticationMethod !== "LOCAL_PASSWORD"
    ) return null;
    const replacementToken = randomBytes(32).toString("base64url");
    const newPasswordHash = await hashLocalPassword(newPassword);
    return this.database.transaction(async (transaction) => {
      const session = await this.sessionByToken(transaction, token);
      if (!session || !activeSession(session, now) || session.authenticationMethod !== "LOCAL_PASSWORD") return null;
      const accountId = session.subject.startsWith("local-admin:") ? session.subject.slice("local-admin:".length) : "";
      if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;
      await transaction.execute(advisoryLock(`orcasynapse-local-admin-id:${accountId}`));
      const [account] = await transaction
        .select()
        .from(localAdministrator)
        .where(eq(localAdministrator.id, accountId))
        .limit(1);
      if (!account || account.disabledAt || !(await verifyLocalPassword(currentPassword, account.passwordHash))) return null;

      await transaction
        .update(localAdministrator)
        .set({
          passwordHash: newPasswordHash,
          passwordChangeRequired: false,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(localAdministrator.id, account.id));
      // Recovery sessions carry `installation-key-administrator`, not this
      // subject, so revoking by subject alone left the break-glass way in open
      // behind an administrator who had just changed the password in response
      // to a suspected compromise. Same predicate as recoverLocalAdministrator.
      await transaction
        .update(administratorSession)
        .set({ revokedAt: now })
        .where(
          and(
            isNull(administratorSession.revokedAt),
            or(
              eq(administratorSession.subject, session.subject),
              eq(administratorSession.authenticationMethod, "INSTALLATION_KEY_RECOVERY"),
            ),
          ),
        );
      const created = await createSessionRecord(transaction, {
        token: replacementToken,
        subject: session.subject,
        role: account.role,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: false,
        context,
        now,
      });
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: account.id,
        action: "administrator.local_password_changed",
        resourceType: "LocalAdministrator",
        resourceId: account.id,
        outcome: "SUCCESS",
        metadata: { revokedOtherSessions: true },
      });
      return { token: replacementToken, principal: principalFromRecord(created) };
    });
  }

  async recoverLocalAdministrator(
    token: string | undefined,
    username: string,
    newPassword: string,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null> {
    const normalizedUsername = normalizedLocalUsername(username);
    if (!sessionTokenIsValid(token) || !normalizedUsername || !localPasswordIsValid(newPassword)) return null;
    const now = new Date();
    const preliminarySession = await this.sessionByToken(this.database, token);
    if (
      !preliminarySession
      || !activeSession(preliminarySession, now)
      || preliminarySession.authenticationMethod !== "INSTALLATION_KEY_RECOVERY"
    ) return null;
    const newPasswordHash = await hashLocalPassword(newPassword);
    const replacementToken = randomBytes(32).toString("base64url");
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    return this.database.transaction(async (transaction) => {
      const recoverySession = await this.sessionByToken(transaction, token);
      if (
        !recoverySession
        || !activeSession(recoverySession, now)
        || recoverySession.authenticationMethod !== "INSTALLATION_KEY_RECOVERY"
      ) return null;
      // Nothing else on this route re-reads the mounted key, and the route
      // resets a password without ever calling authenticate.
      if (await this.installationKeyRotated(transaction, now)) return null;
      await transaction.execute(advisoryLock(`orcasynapse-local-admin:${normalizedUsername}`));
      const [account] = await transaction
        .select()
        .from(localAdministrator)
        .where(eq(localAdministrator.username, normalizedUsername))
        .limit(1);
      if (!account || account.disabledAt) return null;

      await transaction
        .update(localAdministrator)
        .set({
          passwordHash: newPasswordHash,
          passwordChangeRequired: false,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(localAdministrator.id, account.id));
      // Recovery burns every other way in: the account's own sessions and any
      // other outstanding installation-key session.
      await transaction
        .update(administratorSession)
        .set({ revokedAt: now })
        .where(
          and(
            isNull(administratorSession.revokedAt),
            or(
              eq(administratorSession.subject, `local-admin:${account.id}`),
              eq(administratorSession.authenticationMethod, "INSTALLATION_KEY_RECOVERY"),
            ),
          ),
        );
      const created = await createSessionRecord(transaction, {
        token: replacementToken,
        subject: `local-admin:${account.id}`,
        role: account.role,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: false,
        context,
        now,
      });
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: account.id,
        action: "administrator.local_password_recovered",
        resourceType: "LocalAdministrator",
        resourceId: account.id,
        outcome: "SUCCESS",
        sourceIp,
        metadata: { authenticationMethod: "installation-key-recovery", revokedOtherSessions: true },
      });
      return { token: replacementToken, principal: principalFromRecord(created) };
    });
  }

  async issueFederatedSession(
    subject: string,
    role: AdminRole,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession> {
    if (!subject || subject.length > 160) throw new Error("Federated administrator subject is invalid.");
    const token = randomBytes(32).toString("base64url");
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    const now = new Date();
    const idleExpiresAt = new Date(now.getTime() + ADMIN_SESSION_IDLE_MS);
    const absoluteExpiresAt = new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_MS);
    const session = await this.database.transaction(async (transaction) => {
      await transaction
        .delete(administratorSession)
        .where(lt(administratorSession.absoluteExpiresAt, new Date(now.getTime() - ADMIN_SESSION_RETENTION_MS)));
      const [created] = await transaction
        .insert(administratorSession)
        .values({
          tokenHash: tokenDigest(token), subject, role, lastSeenAt: now, idleExpiresAt,
          absoluteExpiresAt, sourceIp, userAgentHash: userAgentDigest(context.userAgent) ?? null,
          authenticationMethod: "OIDC", passwordChangeRequired: false,
        })
        .returning();
      if (!created) throw new Error("The federated session could not be created.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: created.id, action: "administrator.session_created",
        resourceType: "AdministratorSession", resourceId: created.id, outcome: "SUCCESS", sourceIp,
        metadata: { role, authenticationMethod: "oidc-pkce-group-mapping" },
      });
      return created;
    });
    return { token, principal: principalFromRecord(session) };
  }

  async authenticate(
    token: string | undefined,
    requiredScope?: AdminScope,
  ): Promise<AdminPrincipal | null> {
    if (!sessionTokenIsValid(token)) return null;
    const now = new Date();
    const session = await this.sessionByToken(this.database, token);
    if (
      !session ||
      session.revokedAt ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      if (session && !session.revokedAt) {
        await this.database
          .update(administratorSession)
          .set({ revokedAt: now })
          .where(and(eq(administratorSession.id, session.id), isNull(administratorSession.revokedAt)));
      }
      return null;
    }

    // A rotated key has to end recovery sessions on its own; only a recovery
    // session pays for the extra read.
    if (
      session.authenticationMethod === "INSTALLATION_KEY_RECOVERY"
      && await this.installationKeyRotated(this.database, now)
    ) return null;

    const scopes: readonly AdminScope[] = session.authenticationMethod === "INSTALLATION_KEY_RECOVERY"
      ? ["sessions:manage"]
      : ROLE_SCOPES[session.role];
    if (requiredScope && !scopes.includes(requiredScope)) return null;

    // Preserve sliding expiry without turning every authenticated API request
    // into a PostgreSQL write.
    if (now.getTime() - session.lastSeenAt.getTime() < ADMIN_SESSION_TOUCH_INTERVAL_MS) {
      return principalFromRecord(session);
    }

    const idleExpiresAt = new Date(
      Math.min(now.getTime() + ADMIN_SESSION_IDLE_MS, session.absoluteExpiresAt.getTime()),
    );
    // The predicate re-checks every liveness condition so a concurrent revoke or
    // expiry between the read and the write loses rather than being overwritten.
    const updated = await this.database
      .update(administratorSession)
      .set({ lastSeenAt: now, idleExpiresAt })
      .where(
        and(
          eq(administratorSession.id, session.id),
          isNull(administratorSession.revokedAt),
          lte(administratorSession.lastSeenAt, new Date(now.getTime() - ADMIN_SESSION_TOUCH_INTERVAL_MS)),
          gt(administratorSession.idleExpiresAt, now),
          gt(administratorSession.absoluteExpiresAt, now),
        ),
      )
      .returning({ id: administratorSession.id });
    if (updated.length !== 1) return null;
    return principalFromRecord({ ...session, idleExpiresAt });
  }

  async revoke(token: string | undefined): Promise<boolean> {
    if (!sessionTokenIsValid(token)) return false;
    const now = new Date();
    const [session] = await this.database
      .select({ id: administratorSession.id, revokedAt: administratorSession.revokedAt })
      .from(administratorSession)
      .where(eq(administratorSession.tokenHash, tokenDigest(token)))
      .limit(1);
    if (!session || session.revokedAt) return false;

    return this.database.transaction(async (transaction) => {
      const revoked = await transaction
        .update(administratorSession)
        .set({ revokedAt: now })
        .where(and(eq(administratorSession.id, session.id), isNull(administratorSession.revokedAt)))
        .returning({ id: administratorSession.id });
      if (revoked.length !== 1) return false;
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: session.id,
        action: "administrator.session_revoked",
        resourceType: "AdministratorSession",
        resourceId: session.id,
        outcome: "SUCCESS",
        metadata: {},
      });
      return true;
    });
  }
}

export function adminSessionToken(request: FastifyRequest): string | undefined {
  const cookies = request.headers.cookie;
  if (!cookies) return undefined;
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === ADMIN_SESSION_COOKIE) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "Path=/api/v1",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(ADMIN_SESSION_ABSOLUTE_MS / 1_000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredSessionCookie(secure: boolean): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "Path=/api/v1",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * The result of resolving an administrator session, with "refused" separated
 * from "absent" so a caller cannot conflate them.
 *
 * Modules that accept an enterprise identity as well need all three: an absent
 * admin session means "try the other identity", while a refused one means a
 * reply has already been sent and the request is over.
 */
export type AdminAuthentication =
  | { outcome: "ADMINISTRATOR"; principal: AdminPrincipal }
  | { outcome: "NO_SESSION" }
  | { outcome: "REFUSED" };

/**
 * Resolve an administrator session and apply the forced-rotation gate.
 *
 * `authenticate` deliberately returns a principal whose password change is
 * still pending, because the change and recovery endpoints in `auth/routes.ts`
 * have to accept exactly that session — they are the only two call sites that
 * may use the manager directly. Every other surface must refuse it: the
 * installer prints the temporary password to a terminal and a log, so a
 * session holding it is a credential in transit rather than an administrator.
 *
 * The gate used to be written out at each call site, and two of the four
 * forgot it — `agents/routes.ts` and `chat/routes.ts` accepted a pending
 * session, so the temporary password could flip the agent-execution kill
 * switch, activate a profile, and run a real turn. It lives here now, and
 * `admin-session.gate.test.ts` fails if a new module resolves a session
 * without it.
 */
export async function authenticateAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  manager: AdminSessionManager | undefined,
  requiredScope?: AdminScope,
): Promise<AdminAuthentication> {
  const principal = await manager?.authenticate(adminSessionToken(request), requiredScope);
  if (!principal) return { outcome: "NO_SESSION" };
  if (principal.passwordChangeRequired) {
    await reply.code(403).send({
      error: "PASSWORD_CHANGE_REQUIRED",
      message: "Change or recover the local administrator password before using OrcaSynapse administration.",
    });
    return { outcome: "REFUSED" };
  }
  return { outcome: "ADMINISTRATOR", principal };
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  manager: AdminSessionManager | undefined,
  requiredScope: AdminScope,
): Promise<AdminPrincipal | null> {
  if (!manager) {
    await reply.code(423).send({
      error: "PLATFORM_LOCKED",
      message: "OrcaSynapse administrator sessions are not ready.",
    });
    return null;
  }
  const authentication = await authenticateAdministrator(request, reply, manager);
  if (authentication.outcome === "REFUSED") return null;
  if (authentication.outcome === "NO_SESSION") {
    await reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "An active administrator session with the required scope is required.",
    });
    return null;
  }
  const { principal } = authentication;
  if (!principal.scopes.includes(requiredScope)) {
    await reply.code(403).send({
      error: "FORBIDDEN",
      message: `The administrator session does not grant '${requiredScope}'.`,
    });
    return null;
  }
  return principal;
}
