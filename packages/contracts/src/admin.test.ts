import { describe, expect, it } from "vitest";
import {
  administratorSessionSchema,
  installationKeyRecoveryRequestSchema,
  installationKeySessionRequestSchema,
  localAdministratorLoginRequestSchema,
  localAdministratorPasswordChangeRequestSchema,
} from "./admin.js";

describe("administrator contracts", () => {
  it("requires a sufficiently strong Installation Key payload", () => {
    expect(installationKeySessionRequestSchema.safeParse({ installationKey: "short" }).success).toBe(false);
    expect(installationKeySessionRequestSchema.safeParse({ installationKey: "a".repeat(32) }).success).toBe(true);
  });

  it("validates bounded local administrator credentials and recovery requests", () => {
    expect(localAdministratorLoginRequestSchema.safeParse({ username: "admin", password: "temporary-password" }).success).toBe(true);
    expect(localAdministratorLoginRequestSchema.safeParse({ username: "admin", password: "short" }).success).toBe(false);
    expect(localAdministratorPasswordChangeRequestSchema.safeParse({ currentPassword: "temporary-password", newPassword: "replacement-password" }).success).toBe(true);
    expect(installationKeyRecoveryRequestSchema.safeParse({ username: "admin", newPassword: "replacement-password" }).success).toBe(true);
  });

  it("rejects invented roles and scopes from a session response", () => {
    const base = {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "administrator",
      role: "PLATFORM_ADMIN",
      scopes: ["connections:read"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T00:15:00.000Z",
      absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
    };

    expect(administratorSessionSchema.safeParse(base).success).toBe(true);
    expect(administratorSessionSchema.safeParse({ ...base, role: "ROOT" }).success).toBe(false);
    expect(administratorSessionSchema.safeParse({ ...base, scopes: ["everything"] }).success).toBe(false);
  });
});
