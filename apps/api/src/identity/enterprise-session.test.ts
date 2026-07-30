import { describe, expect, it } from "vitest";
import { administratorRoleForGroups } from "./enterprise-session.js";

const mappings = {
  PLATFORM_ADMIN: ["AIHub-Platform"],
  SECURITY_ADMIN: ["AIHub-Security"],
  OPERATIONS_ADMIN: ["AIHub-Operations"],
  AUDITOR: ["AIHub-Auditors"],
} as const;

describe("enterprise administrator group mapping", () => {
  it("maps groups case-insensitively by default", () => {
    expect(administratorRoleForGroups(["aihub-operations"], mappings, false)).toBe("OPERATIONS_ADMIN");
  });

  it("uses the most privileged configured role when groups overlap", () => {
    expect(administratorRoleForGroups(["AIHub-Auditors", "AIHub-Security"], mappings, true)).toBe("SECURITY_ADMIN");
  });

  it("fails closed when no administrator group matches", () => {
    expect(administratorRoleForGroups(["AIHub-Users"], mappings, false)).toBeNull();
    expect(administratorRoleForGroups(["aihub-platform"], mappings, true)).toBeNull();
  });
});
