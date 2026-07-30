import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type AdminRole,
  type AdminScope,
} from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminAuthenticator } from "./bootstrap-auth.js";

export const ADMIN_SESSION_COOKIE = "aihub_admin_session";
export const ADMIN_SESSION_IDLE_MS = 15 * 60 * 1_000;
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1_000;
const ADMIN_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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
    "memory:read",
    "memory:manage",
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
    "documents:reprocess",
    "memory:read",
    "memory:manage",
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
  AUDITOR: ["connections:read", "operations:read", "audit:read", "documents:read", "memory:read", "models:read", "guardrails:read", "prompts:read", "agents:read", "tools:read", "approvals:read", "evaluations:read", "readiness:read"],
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
  createBootstrapSession(
    bootstrapToken: string | undefined,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null>;
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
}): AdminPrincipal {
  return {
    id: record.id,
    subject: record.subject,
    role: record.role,
    scopes: [...ROLE_SCOPES[record.role]],
    createdAt: record.createdAt.toISOString(),
    idleExpiresAt: record.idleExpiresAt.toISOString(),
    absoluteExpiresAt: record.absoluteExpiresAt.toISOString(),
  };
}

export class PrismaAdminSessionManager implements AdminSessionManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly bootstrapAuthenticator: AdminAuthenticator,
  ) {}

  async createBootstrapSession(
    bootstrapToken: string | undefined,
    context: AdminRequestContext,
  ): Promise<IssuedAdminSession | null> {
    if (!this.bootstrapAuthenticator.verify(bootstrapToken)) return null;

    const token = randomBytes(32).toString("base64url");
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;
    const now = new Date();
    const idleExpiresAt = new Date(now.getTime() + ADMIN_SESSION_IDLE_MS);
    const absoluteExpiresAt = new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_MS);
    const session = await this.prisma.$transaction(async (transaction) => {
      await transaction.administratorSession.deleteMany({
        where: {
          absoluteExpiresAt: { lt: new Date(now.getTime() - ADMIN_SESSION_RETENTION_MS) },
        },
      });
      const created = await transaction.administratorSession.create({
        data: {
          tokenHash: tokenDigest(token),
          subject: "bootstrap-administrator",
          role: "PLATFORM_ADMIN",
          lastSeenAt: now,
          idleExpiresAt,
          absoluteExpiresAt,
          sourceIp,
          userAgentHash: userAgentDigest(context.userAgent) ?? null,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: created.id,
          action: "administrator.session_created",
          resourceType: "AdministratorSession",
          resourceId: created.id,
          outcome: "SUCCESS",
          sourceIp,
          metadata: { role: created.role, authenticationMethod: "bootstrap-token" },
        },
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

    const scopes = ROLE_SCOPES[session.role];
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
      message: "AIHub administrator sessions are not ready.",
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
  if (!principal.scopes.includes(requiredScope)) {
    await reply.code(403).send({
      error: "FORBIDDEN",
      message: `The administrator session does not grant '${requiredScope}'.`,
    });
    return null;
  }
  return principal;
}
