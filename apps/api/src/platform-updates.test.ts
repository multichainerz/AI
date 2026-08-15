import { describe, expect, it, vi } from "vitest";
import {
  checkForPlatformUpdate,
  latestReleaseVersion,
  parseReleaseVersion,
} from "./platform-updates.js";

describe("platform update checks", () => {
  /*
   * Both spellings, and that is a compatibility requirement rather than
   * leniency.
   *
   * Releases through ai-v1.99.0 are tagged `ai-vX.Y.Z`; from v2.0.0 the prefix
   * is dropped. A deployment installed before the rename reports its own
   * version to this parser, so a pattern that accepted only the new form would
   * make `checkForPlatformUpdate` throw on every existing install — a 503 on
   * the update check for precisely the deployments that most need to be told
   * an update exists. The old tags also stay in GitHub's list, so refusing them
   * would silently narrow the set the latest release is chosen from.
   */
  it("accepts stable release tags with or without the retired ai- prefix", () => {
    expect(parseReleaseVersion("ai-v1.99.0")?.parts).toEqual([1, 99, 0]);
    expect(parseReleaseVersion("v5.0.0")?.parts).toEqual([5, 0, 0]);
    expect(parseReleaseVersion("ai-v1.99.0-rc.1")).toBeNull();
    expect(parseReleaseVersion("v5.0.0-rc.1")).toBeNull();
    expect(parseReleaseVersion("3.9.0")).toBeNull();
    expect(parseReleaseVersion("release-v1.0.0")).toBeNull();
  });

  it("ranks a prefixed tag against an unprefixed one by number alone", () => {
    // The rename must not make an older `ai-v` tag outrank a newer `v` one.
    expect(latestReleaseVersion([
      { name: "ai-v1.99.0" },
      { name: "v5.0.0" },
    ]).tag).toBe("v5.0.0");
  });

  it("selects by semantic version rather than GitHub response order", () => {
    expect(latestReleaseVersion([
      { name: "ai-v1.99.9" },
      { name: "documentation" },
      { name: "v4.8.1" },
      { name: "v3.9.20" },
    ]).tag).toBe("v4.8.1");
  });

  it("returns an immutable, operator-run update command", async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify([
      { name: "v4.8.3" },
      { name: "v4.8.2" },
    ]), { status: 200 }));

    const update = await checkForPlatformUpdate("v4.8.2", fetchImplementation);

    expect(update.updateAvailable).toBe(true);
    expect(update.latestVersion).toBe("v4.8.3");
    expect(update.updateCommand).toContain("ORCASYNAPSE_REF=v4.8.3");
    expect(update.automaticUpdateSupported).toBe(false);
  });
});
