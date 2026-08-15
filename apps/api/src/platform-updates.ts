import { platformUpdateSchema, type PlatformUpdate } from "@orcasynapse/contracts";

/**
 * A stable release tag, in either spelling.
 *
 * Releases through `ai-v1.99.0` carried the `ai-` prefix; from `v2.0.0` they
 * do not. The prefix is optional here rather than replaced because a
 * deployment installed before the rename reports its own version to this
 * parser: matching only the new form would throw for exactly those
 * installations, turning their update check into a 503 at the moment it would
 * have told them an update exists. Old tags also remain in the upstream list,
 * and dropping them would narrow the set the latest release is chosen from.
 */
const RELEASE_TAG_PATTERN = /^(?:ai-)?v(\d+)\.(\d+)\.(\d+)$/;
const TAGS_ENDPOINT = "https://api.github.com/repos/multichainerz/AI/tags?per_page=100";
const INSTALLER_URL = "https://raw.githubusercontent.com/multichainerz/AI/main/install.sh";

export interface ReleaseVersion {
  tag: string;
  parts: readonly [number, number, number];
}

export function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = RELEASE_TAG_PATTERN.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as unknown as [number, number, number];
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { tag: value, parts };
}

export function compareReleaseVersions(left: ReleaseVersion, right: ReleaseVersion): number {
  for (let index = 0; index < left.parts.length; index += 1) {
    const difference = left.parts[index]! - right.parts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function latestReleaseVersion(tags: unknown): ReleaseVersion {
  if (!Array.isArray(tags)) throw new Error("GitHub returned an invalid tag list.");

  const versions = tags.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") return [];
    const parsed = parseReleaseVersion(entry.name);
    return parsed ? [parsed] : [];
  });
  if (versions.length === 0) throw new Error("No OrcaSynapse release tags were found.");

  return versions.reduce((latest, candidate) =>
    compareReleaseVersions(candidate, latest) > 0 ? candidate : latest,
  );
}

export async function checkForPlatformUpdate(
  currentTag: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PlatformUpdate> {
  const current = parseReleaseVersion(currentTag);
  if (!current) throw new Error(`The installed version '${currentTag}' is not a release tag.`);

  const response = await fetchImplementation(TAGS_ENDPOINT, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "OrcaSynapse-update-check",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`GitHub release lookup returned HTTP ${response.status}.`);

  const latest = latestReleaseVersion(await response.json());
  return platformUpdateSchema.parse({
    currentVersion: current.tag,
    latestVersion: latest.tag,
    updateAvailable: compareReleaseVersions(latest, current) > 0,
    releaseUrl: `https://github.com/multichainerz/AI/tree/${latest.tag}`,
    updateCommand: `curl -fsSL ${INSTALLER_URL} | sudo ORCASYNAPSE_REF=${latest.tag} bash`,
    automaticUpdateSupported: false,
    automaticUpdateReason:
      "The dashboard runs inside the application container and intentionally has no host-root or Docker control.",
    checkedAt: new Date().toISOString(),
  });
}
