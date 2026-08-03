import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type AdminAuthenticationMethod,
  type AdminRole,
  type AdminScope,
} from "@orcasynapse/contracts";
import type { OrcaSynapsePrismaClient, Prisma } from "@orcasynapse/database";
import {
  DUMMY_PASSWORD_DIGEST,
  hashLocalPassword,
  localPasswordIsValid,
  verifyLocalPassword,
} from "@orcasynapse/security";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { InstallationKeyVerifier } from "./installation-key-auth.js";

export const ADMIN_SESSION_COOKIE = "orcasynapse_admin_session";
export const ADMIN_SESSION_IDLE_MS = 15 * 60 * 1_000;
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1_000;
const ADMIN_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCAL_LOGIN_FAILURE_LIMIT = 5;
const LOCAL_LOGIN_LOCK_MS = 15 * 60 * 1_000;

const ROLE_SCOPES: Readonly<Record<AdminRole, readonly AdminScope[]>> = {
  PLATFORM_ADMIN: ADMIN_SCOPES,
  SECURITY_ADMIN: [
    "connections:read",
    "connections:write",
    "connections:test",
    "operations:read",
    "audit:read",
    "sessions:manage",
    "documents:read",
    "documents:review",
    "documents:delete",
    "models:read",
    "models:manage",
    "guardrails:read",
    "guardrails:manage",
    "prompts:read",
    "prompts:manage",
    "agents:read",
    "agents:manage",
    "agents:control",
    "tools:read",
    "tools:manage",
    "approvals:read",
    "approvals:review",
    "evaluations:read",
    "evaluations:manage",
    "evaluations:promote",
    "readiness:read",
    "readiness:manage",
    "readiness:approve",
  ],
  OPERATIONS_ADMIN: [
    "connections:read",
    "connections:test",
    "operations:read",
    "operations:execute",
    "documents:read",
    "documents:review",
    "models:read",
    "guardrails:read",
    "prompts:read",
    "agents:read",
    "agents:control",
    "tools:read",
    "approvals:read",
    "approvals:review",
    "evaluations:read",
    "readiness:read",
    "readiness:manage",
  ],
  AUDITOR: ["connections:read", "operations:read", "audit:read", "documents:read", "models:read", "guardrails:read", "prompts:read", "agents:read", "tools:read", "approvals:read", "evaluations:read", "readiness:read"],
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

async function createSessionRecord(
  transaction: Prisma.TransactionClient,
  input: {
    token: string;
    subject: string;
    role: AdminRole;
    authenticationMethod: AdminAuthenticationMethod;
    passwordChangeRequired: boolean;
    context: AdminRequestContext;
    now: Date;
  },
) {
  const absoluteExpiresAt = new Date(input.now.getTime() + ADMIN_SESSION_ABSOLUTE_MS);
  await transaction.administratorSession.deleteMany({
    where: { absoluteExpiresAt: { lt: new Date(input.now.getTime() - ADMIN_SESSION_RETENTION_MS) } },
  });
  return transaction.administratorSession.create({
    data: {
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
    },
  });
}

export class PrismaAdminSessionManager implements AdminSessionManager {
  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly installationKeyAuthenticator: InstallationKeyVerifier,
  ) {}

  async createInstallationKeySession(
    installationKey: string | undefined,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null> {
    if (!installationKey || !this.installationKeyAuthenticator.verify(installationKey)) return null;

    const token = randomBytes(32).toString("base64url");
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    const now = new Date();
    const idleExpiresAt = new Date(now.getTime() + ADMIN_SESSION_IDLE_MS);
    const absoluteExpiresAt = new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_MS);
    const session = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('orcasynapse-installation-key', 0))`;
      const keyHash = tokenDigest(installationKey);
      const existingCredential = await transaction.installationCredential.findUnique({ where: { id: "primary" } });
      if (existingCredential) {
        const expectedHash = Buffer.from(existingCredential.keyHash);
        const keyMatches = expectedHash.byteLength === keyHash.byteLength && timingSafeEqual(expectedHash, keyHash);
        if (!keyMatches) {
          // The root-owned mounted file is the authority for an intentional key
          // rotation. The candidate already passed constant-time verification
          // against that file before this transaction.
          await transaction.installationCredential.update({
            where: { id: "primary" },
            data: { keyHash, activatedAt: null, lastSessionId: null, lastSourceIp: sourceIp },
          });
          await transaction.administratorSession.updateMany({
            where: { subject: "installation-key-administrator", revokedAt: null },
            data: { revokedAt: now },
          });
        }
      }
      await transaction.administratorSession.deleteMany({
        where: {
          absoluteExpiresAt: { lt: new Date(now.getTime() - ADMIN_SESSION_RETENTION_MS) },
        },
      });
      const created = await transaction.administratorSession.create({
        data: {
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
        },
      });
      if (existingCredential) {
        await transaction.installationCredential.update({
          where: { id: "primary" },
          data: {
            keyHash,
            activatedAt: existingCredential.activatedAt ?? now,
            lastSessionId: created.id,
            lastSourceIp: sourceIp,
          },
        });
      } else {
        await transaction.installationCredential.create({
          data: {
            id: "primary",
            keyHash,
            activatedAt: now,
            lastSessionId: created.id,
            lastSourceIp: sourceIp,
          },
        });
      }
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: created.id,
          action: "administrator.session_created",
          resourceType: "AdministratorSession",
          resourceId: created.id,
          outcome: "SUCCESS",
          sourceIp,
          metadata: { role: created.role, authenticationMethod: "installation-key-recovery" },
        },
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
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`orcasynapse-local-admin:${normalizedUsername}`}, 0))`;
      const account = await transaction.localAdministrator.findUnique({ where: { username: normalizedUsername } });
      const passwordMatches = await verifyLocalPassword(password, account?.passwordHash ?? DUMMY_PASSWORD_DIGEST);
      const lockActive = Boolean(account?.lockedUntil && account.lockedUntil > now);
      const accepted = Boolean(account && !account.disabledAt && !lockActive && passwordMatches);

      if (!accepted) {
        if (account && !account.disabledAt && !lockActive) {
          const priorFailures = account.lockedUntil && account.lockedUntil <= now ? 0 : account.failedLoginCount;
          const failedLoginCount = priorFailures + 1;
          await transaction.localAdministrator.update({
            where: { id: account.id },
            data: {
              failedLoginCount,
              lockedUntil: failedLoginCount >= LOCAL_LOGIN_FAILURE_LIMIT
                ? new Date(now.getTime() + LOCAL_LOGIN_LOCK_MS)
                : null,
            },
          });
        }
        await transaction.auditEvent.create({ data: {
          actorType: "USER",
          actorId: account?.id ?? null,
          action: "administrator.local_login_failed",
          resourceType: "LocalAdministrator",
          resourceId: account?.id ?? null,
          outcome: "FAILED",
          sourceIp,
          metadata: { authenticationMethod: "local-password" },
        } });
        return null;
      }

      await transaction.localAdministrator.update({
        where: { id: account!.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      });
      const created = await createSessionRecord(transaction, {
        token,
        subject: `local-admin:${account!.id}`,
        role: account!.role,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: account!.passwordChangeRequired,
        context,
        now,
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: account!.id,
        action: "administrator.session_created",
        resourceType: "AdministratorSession",
        resourceId: created.id,
        outcome: "SUCCESS",
        sourceIp,
        metadata: { role: created.role, authenticationMethod: "local-password" },
      } });
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
    const preliminarySession = await this.prisma.administratorSession.findUnique({ where: { tokenHash: tokenDigest(token) } });
    if (
      !preliminarySession
      || !activeSession(preliminarySession, now)
      || preliminarySession.authenticationMethod !== "LOCAL_PASSWORD"
    ) return null;
    const replacementToken = randomBytes(32).toString("base64url");
    const newPasswordHash = await hashLocalPassword(newPassword);
    return this.prisma.$transaction(async (transaction) => {
      const session = await transaction.administratorSession.findUnique({ where: { tokenHash: tokenDigest(token) } });
      if (!session || !activeSession(session, now) || session.authenticationMethod !== "LOCAL_PASSWORD") return null;
      const accountId = session.subject.startsWith("local-admin:") ? session.subject.slice("local-admin:".length) : "";
      if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`orcasynapse-local-admin-id:${accountId}`}, 0))`;
      const account = await transaction.localAdministrator.findUnique({ where: { id: accountId } });
      if (!account || account.disabledAt || !(await verifyLocalPassword(currentPassword, account.passwordHash))) return null;

      await transaction.localAdministrator.update({
        where: { id: account.id },
        data: {
          passwordHash: newPasswordHash,
          passwordChangeRequired: false,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await transaction.administratorSession.updateMany({
        where: { subject: session.subject, revokedAt: null },
        data: { revokedAt: now },
      });
      const created = await createSessionRecord(transaction, {
        token: replacementToken,
        subject: session.subject,
        role: account.role,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: false,
        context,
        now,
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: account.id,
        action: "administrator.local_password_changed",
        resourceType: "LocalAdministrator",
        resourceId: account.id,
        outcome: "SUCCESS",
        metadata: { revokedOtherSessions: true },
      } });
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
    const preliminarySession = await this.prisma.administratorSession.findUnique({ where: { tokenHash: tokenDigest(token) } });
    if (
      !preliminarySession
      || !activeSession(preliminarySession, now)
      || preliminarySession.authenticationMethod !== "INSTALLATION_KEY_RECOVERY"
    ) return null;
    const newPasswordHash = await hashLocalPassword(newPassword);
    const replacementToken = randomBytes(32).toString("base64url");
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    return this.prisma.$transaction(async (transaction) => {
      const recoverySession = await transaction.administratorSession.findUnique({ where: { tokenHash: tokenDigest(token) } });
      if (
        !recoverySession
        || !activeSession(recoverySession, now)
        || recoverySession.authenticationMethod !== "INSTALLATION_KEY_RECOVERY"
      ) return null;
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`orcasynapse-local-admin:${normalizedUsername}`}, 0))`;
      const account = await transaction.localAdministrator.findUnique({ where: { username: normalizedUsername } });
      if (!account || account.disabledAt) return null;

      await transaction.localAdministrator.update({
        where: { id: account.id },
        data: {
          passwordHash: newPasswordHash,
          passwordChangeRequired: false,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await transaction.administratorSession.updateMany({
        where: {
          revokedAt: null,
          OR: [
            { subject: `local-admin:${account.id}` },
            { authenticationMethod: "INSTALLATION_KEY_RECOVERY" },
          ],
        },
        data: { revokedAt: now },
      });
      const created = await createSessionRecord(transaction, {
        token: replacementToken,
        subject: `local-admin:${account.id}`,
        role: account.role,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: false,
        context,
        now,
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: account.id,
        action: "administrator.local_password_recovered",
        resourceType: "LocalAdministrator",
        resourceId: account.id,
        outcome: "SUCCESS",
        sourceIp,
        metadata: { authenticationMethod: "installation-key-recovery", revokedOtherSessions: true },
      } });
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
    const session = await this.prisma.$transaction(async (transaction) => {
      await transaction.administratorSession.deleteMany({
        where: { absoluteExpiresAt: { lt: new Date(now.getTime() - ADMIN_SESSION_RETENTION_MS) } },
      });
      const created = await transaction.administratorSession.create({
        data: {
          tokenHash: tokenDigest(token), subject, role, lastSeenAt: now, idleExpiresAt,
          absoluteExpiresAt, sourceIp, userAgentHash: userAgentDigest(context.userAgent) ?? null,
          authenticationMethod: "OIDC", passwordChangeRequired: false,
        },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: created.id, action: "administrator.session_created",
        resourceType: "AdministratorSession", resourceId: created.id, outcome: "SUCCESS", sourceIp,
        metadata: { role, authenticationMethod: "oidc-pkce-group-mapping" },
      } });
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
    const session = await this.prisma.administratorSession.findUnique({
      where: { tokenHash: tokenDigest(token) },
    });
    if (
      !session ||
      session.revokedAt ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      if (session && !session.revokedAt) {
        await this.prisma.administratorSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      return null;
    }

    const scopes: readonly AdminScope[] = session.authenticationMethod === "INSTALLATION_KEY_RECOVERY"
      ? ["sessions:manage"]
      : ROLE_SCOPES[session.role];
    if (requiredScope && !scopes.includes(requiredScope)) return null;

    const idleExpiresAt = new Date(
      Math.min(now.getTime() + ADMIN_SESSION_IDLE_MS, session.absoluteExpiresAt.getTime()),
    );
    const updated = await this.prisma.administratorSession.updateMany({
      where: {
        id: session.id,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      data: { lastSeenAt: now, idleExpiresAt },
    });
    if (updated.count !== 1) return null;
    return principalFromRecord({ ...session, idleExpiresAt });
  }

  async revoke(token: string | undefined): Promise<boolean> {
    if (!sessionTokenIsValid(token)) return false;
    const now = new Date();
    const session = await this.prisma.administratorSession.findUnique({
      where: { tokenHash: tokenDigest(token) },
      select: { id: true, revokedAt: true },
    });
    if (!session || session.revokedAt) return false;

    return this.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.administratorSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return false;
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: session.id,
          action: "administrator.session_revoked",
          resourceType: "AdministratorSession",
          resourceId: session.id,
          outcome: "SUCCESS",
          metadata: {},
        },
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
  const principal = await manager.authenticate(adminSessionToken(request));
  if (!principal) {
    await reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "An active administrator session with the required scope is required.",
    });
    return null;
  }
  if (principal.passwordChangeRequired) {
    await reply.code(403).send({
      error: "PASSWORD_CHANGE_REQUIRED",
      message: "Change or recover the local administrator password before using OrcaSynapse administration.",
    });
    return null;
  }
  if (!principal.scopes.includes(requiredScope)) {
    await reply.code(403).send({
      error: "FORBIDDEN",
      message: `The administrator session does not grant '${requiredScope}'.`,
    });
    return null;
  }
  return principal;
}
