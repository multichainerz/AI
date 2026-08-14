import { describe, expect, it, vi } from "vitest";
import {
  checkForPlatformUpdate,
  latestReleaseVersion,
  parseReleaseVersion,
} from "./platform-updates.js";

describe("platform update checks", () => {
  it("accepts only stable OrcaSynapse release tags", () => {
    expect(parseReleaseVersion("ai-v3.18.2")?.parts).toEqual([3, 18, 2]);
    expect(parseReleaseVersion("v3.18.2")).toBeNull();
    expect(parseReleaseVersion("ai-v3.18.2-rc.1")).toBeNull();
  });

  it("selects by semantic version rather than GitHub response order", () => {
    expect(latestReleaseVersion([
      { name: "ai-v3.9.9" },
      { name: "documentation" },
      { name: "ai-v3.18.1" },
      { name: "ai-v3.10.20" },
    ]).tag).toBe("ai-v3.18.1");
  });

  it("returns an immutable, operator-run update command", async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify([
      { name: "ai-v3.18.3" },
      { name: "ai-v3.18.2" },
    ]), { status: 200 }));

    const update = await checkForPlatformUpdate("ai-v3.18.2", fetchImplementation);

    expect(update.updateAvailable).toBe(true);
    expect(update.latestVersion).toBe("ai-v3.18.3");
    expect(update.updateCommand).toContain("ORCASYNAPSE_REF=ai-v3.18.3");
    expect(update.automaticUpdateSupported).toBe(false);
  });
});
