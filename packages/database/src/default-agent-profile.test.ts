import { DEFAULT_AGENT_PROFILE } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { defaultAgentProfileDigest } from "./drizzle/migrate.js";

describe("default Hermes profile seed", () => {
  it("is immediately usable by a fresh chat workspace", () => {
    expect(DEFAULT_AGENT_PROFILE).toMatchObject({
      slug: "hermes-enterprise",
      maxTurns: 1,
      safeMode: true,
    });
    expect(DEFAULT_AGENT_PROFILE.instructions).toContain("Hermes native memory");
  });

  it("has a stable distribution digest", () => {
    expect(defaultAgentProfileDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(defaultAgentProfileDigest()).toBe(defaultAgentProfileDigest());
  });

  it("contains only the Hermes-native profile contract", () => {
    expect(Object.keys(DEFAULT_AGENT_PROFILE).sort()).toEqual([
      "displayName", "instructions", "maxConcurrentRuns", "maxTurns", "modelAlias",
      "purpose", "safeMode", "slug", "soulMd", "timeoutSeconds",
    ]);
  });
});
