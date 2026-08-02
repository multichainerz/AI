import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { hashLocalPassword } from "@orcasynapse/security";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationKeyVerifier } from "./installation-key-auth.js";
import {
  ADMIN_SESSION_IDLE_MS,
  PrismaAdminSessionManager,
  requireAdmin,
  type AdminSessionManager,
} from "./admin-session.js";

const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const SESSION_TOKEN = "s".repeat(43);

afterEach(() => vi.useRealTimers());

function storedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    tokenHash: new Uint8Array(32),
    subject: "installation-key-administrator",
    role: "PLATFORM_ADMIN" as const,
    createdAt: new Date("2026-07-30T00:00:00.000Z"),
    lastSeenAt: new Date("2026-07-30T00:01:00.000Z"),
    idleExpiresAt: new Date("2026-07-30T00:16:00.000Z"),
    absoluteExpiresAt: new Date("2026-07-30T08:00:00.000Z"),
    revokedAt: null,
    sourceIp: "127.0.0.1",
    userAgentHash: null,
    authenticationMethod: "INSTALLATION_KEY_RECOVERY" as const,
    passwordChangeRequired: true,
    ...overrides,
  };
}

describe("PrismaAdminSessionManager", () => {
  it("blocks recovery and temporary-password sessions from operational scopes", async () => {
    const recoveryPrincipal = {
      id: SESSION_ID,
      subject: "installation-key-administrator",
      role: "PLATFORM_ADMIN" as const,
      scopes: ["sessions:manage" as const],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T00:15:00.000Z",
      absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
      authenticationMethod: "INSTALLATION_KEY_RECOVERY" as const,
      passwordChangeRequired: true,
    };
    const manager = {
      createInstallationKeySession: vi.fn(async () => null),
      authenticate: vi.fn(async () => recoveryPrincipal),
      revoke: vi.fn(async () => true),
    } satisfies AdminSessionManager;
    const send = vi.fn(async () => undefined);
    const reply = { code: vi.fn(() => ({ send })) };

    const result = await requireAdmin({ headers: {} } as any, reply as any, manager, "connections:read");

    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: "PASSWORD_CHANGE_REQUIRED" }));
  });

  it("authenticates the PostgreSQL-backed local administrator and preserves the first-login password gate", async () => {
    const passwordHash = await hashLocalPassword("temporary-password", Buffer.alloc(16, 3));
    const account = {
      id: SESSION_ID,
      username: "admin",
      displayName: "Local Administrator",
      passwordHash,
      role: "PLATFORM_ADMIN" as const,
      passwordChangeRequired: true,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      passwordChangedAt: new Date(),
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      localAdministrator: {
        findUnique: vi.fn(async () => account),
        update: vi.fn(async () => account),
      },
      administratorSession: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => storedSession(data)),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    const issued = await new PrismaAdminSessionManager(prisma, { verify: () => false })
      .createLocalPasswordSession("ADMIN", "temporary-password", { sourceIp: "127.0.0.1" });

    expect(issued).toMatchObject({
      principal: {
        subject: `local-admin:${SESSION_ID}`,
        authenticationMethod: "LOCAL_PASSWORD",
        passwordChangeRequired: true,
      },
    });
    expect(transaction.localAdministrator.findUnique).toHaveBeenCalledWith({ where: { username: "admin" } });
  }, 20_000);

  it("issues a 256-bit opaque token and stores only its digest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));
    let storedData: Record<string, unknown> | undefined;
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({}));
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      installationCredential: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
      },
      administratorSession: {
        deleteMany,
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          storedData = data;
          return storedSession(data);
        }),
      },
      auditEvent: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction)),
    } as unknown as OrcaSynapsePrismaClient;
    const authenticator: InstallationKeyVerifier = { verify: (key) => key === "valid-installation-key" };

    const issued = await new PrismaAdminSessionManager(prisma, authenticator)
      .createInstallationKeySession("valid-installation-key", {
        sourceIp: "127.0.0.1",
        userAgent: "OrcaSynapse test",
      });

    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storedData?.tokenHash).toBeInstanceOf(Uint8Array);
    expect((storedData?.tokenHash as Uint8Array).byteLength).toBe(32);
    expect(JSON.stringify(storedData)).not.toContain(issued?.token);
    expect(issued?.principal).toMatchObject({
      role: "PLATFORM_ADMIN",
      authenticationMethod: "INSTALLATION_KEY_RECOVERY",
      passwordChangeRequired: true,
    });
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(transaction.installationCredential.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSessionId: SESSION_ID, activatedAt: new Date("2026-07-30T00:00:00.000Z") }),
    }));
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it("reuses the offline Installation Key for a new bounded recovery session", async () => {
    const token = "a-secure-permanent-installation-key";
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      installationCredential: {
        findUnique: vi.fn(async () => ({
          keyHash: new Uint8Array(await import("node:crypto").then(({ createHash }) => createHash("sha256").update(token).digest())),
          activatedAt: new Date("2026-07-30T00:00:00.000Z"),
        })),
        update: vi.fn(async () => ({})),
      },
      administratorSession: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => storedSession(data)),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaAdminSessionManager(prisma, { verify: (candidate) => candidate === token })
      .createInstallationKeySession(token, {})).resolves.toMatchObject({ principal: { role: "PLATFORM_ADMIN" } });
    expect(transaction.administratorSession.create).toHaveBeenCalledOnce();
    expect(transaction.installationCredential.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ activatedAt: new Date("2026-07-30T00:00:00.000Z") }),
    }));
  });

  it("issues a scoped administrator session for a verified federated subject", async () => {
    const transaction = {
      administratorSession: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => storedSession({ ...data, role: "AUDITOR", subject: `oidc:${"b".repeat(64)}`, authenticationMethod: "OIDC", passwordChangeRequired: false })),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as OrcaSynapsePrismaClient;
    const issued = await new PrismaAdminSessionManager(prisma, { verify: () => false })
      .issueFederatedSession(`oidc:${"b".repeat(64)}`, "AUDITOR", { sourceIp: "127.0.0.1" });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.principal.role).toBe("AUDITOR");
    expect(issued.principal.scopes).toContain("audit:read");
    expect(issued.principal.scopes).not.toContain("connections:write");
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ metadata: { role: "AUDITOR", authenticationMethod: "oidc-pkce-group-mapping" } }),
    }));
  });

  it("extends idle expiry without passing the absolute session limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T07:55:00.000Z"));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      administratorSession: {
        findUnique: vi.fn(async () => storedSession({
          idleExpiresAt: new Date("2026-07-30T07:59:00.000Z"),
        })),
        updateMany,
      },
    } as unknown as OrcaSynapsePrismaClient;

    const principal = await new PrismaAdminSessionManager(prisma, { verify: () => false })
      .authenticate(SESSION_TOKEN);

    expect(principal?.idleExpiresAt).toBe("2026-07-30T08:00:00.000Z");
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        lastSeenAt: new Date("2026-07-30T07:55:00.000Z"),
        idleExpiresAt: new Date("2026-07-30T08:00:00.000Z"),
      },
    }));
    expect(ADMIN_SESSION_IDLE_MS).toBe(15 * 60 * 1_000);
  });

  it("fails closed when revocation wins the authentication update race", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:02:00.000Z"));
    const prisma = {
      administratorSession: {
        findUnique: vi.fn(async () => storedSession()),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as OrcaSynapsePrismaClient;

    const principal = await new PrismaAdminSessionManager(prisma, { verify: () => false })
      .authenticate(SESSION_TOKEN);

    expect(principal).toBeNull();
  });
});
