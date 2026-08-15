import { describe, expect, it, vi } from "vitest";
import {
  checkForPlatformUpdate,
  latestReleaseVersion,
  parseReleaseVersion,
} from "./platform-updates.js";

/*
 * The one place the retired `ai-` spelling still appears, and it is a
 * compatibility requirement rather than leniency.
 *
 * No release tag carries the prefix any more. A deployment installed before the
 * rename still reports its own version to this parser, so a pattern accepting
 * only the current form would make `checkForPlatformUpdate` throw on every one
 * of those installs — a 503 on the update check for precisely the deployments
 * that most need to be told an update exists.
 *
 * This literal is a fossil on purpose. It names no release that exists, and it
 * must not be "corrected" to track the current version: every renumbering pass
 * so far has rewritten this fixture in place, and each time the test went on
 * passing while measuring less. The prefix is the subject here, not the number,
 * which is why the assertions below pin both and why this is the only `ai-v`
 * literal left in the repository.
 */
const RETIRED_SPELLING = "ai-v1.99.0";

describe("platform update checks", () => {
  it("accepts stable release tags with or without the retired ai- prefix", () => {
    expect(RETIRED_SPELLING.startsWith("ai-v"), "the fixture must keep the retired prefix").toBe(true);
    expect(parseReleaseVersion(RETIRED_SPELLING)?.parts).toEqual([1, 99, 0]);
    expect(parseReleaseVersion("v5.0.0")?.parts).toEqual([5, 0, 0]);
    expect(parseReleaseVersion(`${RETIRED_SPELLING}-rc.1`)).toBeNull();
    expect(parseReleaseVersion("v5.0.0-rc.1")).toBeNull();
    expect(parseReleaseVersion("3.9.0")).toBeNull();
    expect(parseReleaseVersion("release-v1.0.0")).toBeNull();
  });

  it("ranks a prefixed tag against an unprefixed one by number alone", () => {
    // The rename must not make an older `ai-v` tag outrank a newer `v` one.
    expect(latestReleaseVersion([
      { name: RETIRED_SPELLING },
      { name: "v5.0.0" },
    ]).tag).toBe("v5.0.0");
  });

  it("selects by semantic version rather than GitHub response order", () => {
    expect(latestReleaseVersion([
      { name: RETIRED_SPELLING },
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
