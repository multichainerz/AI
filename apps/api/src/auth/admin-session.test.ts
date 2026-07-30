import type { AIHubPrismaClient } from "@aihub/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminAuthenticator } from "./bootstrap-auth.js";
import {
  ADMIN_SESSION_IDLE_MS,
  InstallationClaimRejectedError,
  PrismaAdminSessionManager,
} from "./admin-session.js";

const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const SESSION_TOKEN = "s".repeat(43);

afterEach(() => vi.useRealTimers());

function storedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    tokenHash: new Uint8Array(32),
    subject: "bootstrap-administrator",
    role: "PLATFORM_ADMIN" as const,
    createdAt: new Date("2026-07-30T00:00:00.000Z"),
    lastSeenAt: new Date("2026-07-30T00:01:00.000Z"),
    idleExpiresAt: new Date("2026-07-30T00:16:00.000Z"),
    absoluteExpiresAt: new Date("2026-07-30T08:00:00.000Z"),
    revokedAt: null,
    sourceIp: "127.0.0.1",
    userAgentHash: null,
    ...overrides,
  };
}

describe("PrismaAdminSessionManager", () => {
  it("issues a 256-bit opaque token and stores only its digest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));
    let storedData: Record<string, unknown> | undefined;
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({}));
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      installationClaim: {
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
    } as unknown as AIHubPrismaClient;
    const authenticator: AdminAuthenticator = { verify: (token) => token === "valid-bootstrap" };

    const issued = await new PrismaAdminSessionManager(prisma, authenticator)
      .createBootstrapSession("valid-bootstrap", {
        sourceIp: "127.0.0.1",
        userAgent: "AIHub test",
      });

    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storedData?.tokenHash).toBeInstanceOf(Uint8Array);
    expect((storedData?.tokenHash as Uint8Array).byteLength).toBe(32);
    expect(JSON.stringify(storedData)).not.toContain(issued?.token);
    expect(issued?.principal).toMatchObject({ role: "PLATFORM_ADMIN" });
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(transaction.installationClaim.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ redeemedSessionId: SESSION_ID, redeemedAt: new Date("2026-07-30T00:00:00.000Z") }),
    }));
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it("rejects replay after the installation claim has been consumed", async () => {
    const token = "a-secure-single-use-installation-claim";
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      installationClaim: {
        findUnique: vi.fn(async () => ({
          tokenHash: new Uint8Array(await import("node:crypto").then(({ createHash }) => createHash("sha256").update(token).digest())),
          redeemedAt: new Date("2026-07-30T00:00:00.000Z"),
          expiresAt: new Date("2026-07-30T01:00:00.000Z"),
        })),
      },
      administratorSession: { deleteMany: vi.fn(), create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)) } as unknown as AIHubPrismaClient;

    await expect(new PrismaAdminSessionManager(prisma, { verify: (candidate) => candidate === token })
      .createBootstrapSession(token, {})).rejects.toBeInstanceOf(InstallationClaimRejectedError);
    expect(transaction.administratorSession.create).not.toHaveBeenCalled();
  });

  it("issues a scoped administrator session for a verified federated subject", async () => {
    const transaction = {
      administratorSession: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => storedSession({ ...data, role: "AUDITOR", subject: `oidc:${"b".repeat(64)}` })),
      },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as AIHubPrismaClient;
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
    } as unknown as AIHubPrismaClient;

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
    } as unknown as AIHubPrismaClient;

    const principal = await new PrismaAdminSessionManager(prisma, { verify: () => false })
      .authenticate(SESSION_TOKEN);

    expect(principal).toBeNull();
  });
});
