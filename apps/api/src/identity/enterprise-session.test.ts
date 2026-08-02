import { describe, expect, it } from "vitest";
import { administratorRoleForGroups } from "./enterprise-session.js";

const mappings = {
  PLATFORM_ADMIN: ["OrcaSynapse-Platform"],
  SECURITY_ADMIN: ["OrcaSynapse-Security"],
  OPERATIONS_ADMIN: ["OrcaSynapse-Operations"],
  AUDITOR: ["OrcaSynapse-Auditors"],
} as const;

describe("enterprise administrator group mapping", () => {
  it("maps groups case-insensitively by default", () => {
    expect(administratorRoleForGroups(["orcasynapse-operations"], mappings, false)).toBe("OPERATIONS_ADMIN");
  });

  it("uses the most privileged configured role when groups overlap", () => {
    expect(administratorRoleForGroups(["OrcaSynapse-Auditors", "OrcaSynapse-Security"], mappings, true)).toBe("SECURITY_ADMIN");
  });

  it("fails closed when no administrator group matches", () => {
    expect(administratorRoleForGroups(["OrcaSynapse-Users"], mappings, false)).toBeNull();
    expect(administratorRoleForGroups(["orcasynapse-platform"], mappings, true)).toBeNull();
  });
});
