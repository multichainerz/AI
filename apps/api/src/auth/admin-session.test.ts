import type { AIHubPrismaClient } from "@aihub/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminAuthenticator } from "./bootstrap-auth.js";
import {
  ADMIN_SESSION_IDLE_MS,
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
    expect(auditCreate).toHaveBeenCalledOnce();
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
