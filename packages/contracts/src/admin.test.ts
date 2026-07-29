import { describe, expect, it } from "vitest";
import {
  administratorSessionSchema,
  bootstrapSessionRequestSchema,
} from "./admin.js";

describe("administrator contracts", () => {
  it("requires a sufficiently strong bootstrap credential payload", () => {
    expect(bootstrapSessionRequestSchema.safeParse({ token: "short" }).success).toBe(false);
    expect(bootstrapSessionRequestSchema.safeParse({ token: "a".repeat(32) }).success).toBe(true);
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
