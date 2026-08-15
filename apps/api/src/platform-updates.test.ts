import { describe, expect, it, vi } from "vitest";
import {
  checkForPlatformUpdate,
  latestReleaseVersion,
  parseReleaseVersion,
  resolveReleaseTarget,
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
    expect(update.target).toBeNull();
  });
});

describe("resolving an approved tag to a commit", () => {
  const COMMIT = "3f6a1c9d20b74e5a8c1d0f2b7e4a9c6d5b8e0134";
  const OLDER_COMMIT = "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
  const tags = (entries: unknown[]) =>
    vi.fn(async () => new Response(JSON.stringify(entries), { status: 200 }));

  it("pins the tag to the 40-character commit GitHub reports for it", async () => {
    // The commit is the point of the exercise: an operator approves a tag, but
    // a tag can be re-pointed afterwards, so what gets recorded is what the tag
    // meant at the moment of approval.
    const fetchImplementation = tags([
      { name: "documentation", commit: { sha: "c".repeat(40) } },
      { name: "v4.8.3", commit: { sha: COMMIT } },
      { name: "v4.8.2", commit: { sha: OLDER_COMMIT } },
    ]);

    expect(await resolveReleaseTarget("v4.8.3", fetchImplementation)).toEqual({ tag: "v4.8.3", commit: COMMIT });
    // The approved tag's commit, not the first entry's and not the newest.
    expect(await resolveReleaseTarget("v4.8.2", fetchImplementation)).toEqual({ tag: "v4.8.2", commit: OLDER_COMMIT });
  });

  it("refuses anything that is not a published release tag", async () => {
    const published = [{ name: "v4.8.3", commit: { sha: COMMIT } }, { name: "documentation", commit: { sha: "c".repeat(40) } }];

    // Not a release tag at all, so no lookup is worth making.
    expect(await resolveReleaseTarget("main", tags(published))).toBeNull();
    expect(await resolveReleaseTarget("v4.8.3-rc.1", tags(published))).toBeNull();
    // Correctly shaped, but no such release exists.
    expect(await resolveReleaseTarget("v9.9.9", tags(published))).toBeNull();
    // A branch or a moving ref that happens to be listed is still not a release.
    expect(await resolveReleaseTarget("documentation", tags(published))).toBeNull();
  });

  it("reports a lookup it cannot pin rather than storing a partial commit", async () => {
    // An abbreviated sha would still install *something*, just not provably the
    // approved commit, so this fails the approval instead of narrowing it.
    await expect(resolveReleaseTarget("v4.8.3", tags([{ name: "v4.8.3", commit: { sha: COMMIT.slice(0, 7) } }])))
      .rejects.toThrow(/commit/i);
    await expect(resolveReleaseTarget("v4.8.3", vi.fn(async () => new Response("", { status: 502 }))))
      .rejects.toThrow(/502/);
  });
});
