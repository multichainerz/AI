import {
  platformUpdateSchema,
  type PlatformReleaseTarget,
  type PlatformUpdate,
} from "@orcasynapse/contracts";

/**
 * A stable release tag, in either spelling.
 *
 * The `ai-` prefix is fully retired: no release tag carries it any more. It
 * stays optional here rather than being dropped because a deployment installed
 * before the rename reports its own version to this parser, and matching only
 * the current form would throw for exactly those installations — turning their
 * update check into a 503 at the moment it would have told them an update
 * exists.
 */
const RELEASE_TAG_PATTERN = /^(?:ai-)?v(\d+)\.(\d+)\.(\d+)$/;
/** A full git object name. Nothing shorter is a pin. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TAGS_PAGE_SIZE = 100;
/**
 * Five pages is 500 tags, far above this repository, and five GitHub calls
 * stay inside the unauthenticated budget even if the 5-minute cache misses
 * a few times an hour. Twenty would have spent a third of that budget on
 * a single check.
 */
const TAGS_MAX_PAGES = 5;
const TAGS_ENDPOINT = `https://api.github.com/repos/multichainerz/AI/tags?per_page=${TAGS_PAGE_SIZE}`;
const INSTALLER_URL = "https://raw.githubusercontent.com/multichainerz/AI/main/install.sh";

export interface ReleaseVersion {
  tag: string;
  parts: readonly [number, number, number];
}

/** A release tag together with the commit it resolved to at that moment. */
export interface ReleaseTarget {
  tag: string;
  commit: string;
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

/**
 * The published tag list. One endpoint serves both the "is there an update"
 * check and the tag-to-commit lookup an approval needs, so an approval costs
 * no second call and cannot disagree with the check the operator just read.
 */
async function fetchReleaseTags(fetchImplementation: typeof fetch): Promise<unknown> {
  const collected: unknown[] = [];
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "OrcaSynapse-update-check",
    "x-github-api-version": "2022-11-28",
  } as const;
  for (let page = 1; page <= TAGS_MAX_PAGES; page += 1) {
    const response = await fetchImplementation(`${TAGS_ENDPOINT}&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`GitHub release lookup returned HTTP ${response.status}.`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("GitHub returned an invalid tag list.");
    collected.push(...body);
    if (body.length < TAGS_PAGE_SIZE) break;
  }
  return collected;
}

/**
 * Resolve the tag an operator approved to the commit it points at right now.
 *
 * Null means "not a release this deployment may be moved to" — the wrong shape,
 * an unpublished tag, or a moving ref such as a branch that happens to appear
 * in the tag list. Callers turn that into a refusal rather than a lookup
 * failure. A tag list that cannot be pinned at all throws instead, because a
 * missing or abbreviated commit is a broken lookup, not an operator mistake:
 * recording a partial commit would let a host agent install *something* rather
 * than provably the approved release.
 *
 * Walks the same published tag pages as the update check. The tag an operator
 * approves is one the check just showed them, so the two cannot disagree about
 * whether it exists.
 */
export async function resolveReleaseTarget(
  desiredVersion: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ReleaseTarget | null> {
  const desired = parseReleaseVersion(desiredVersion);
  if (!desired) return null;

  const tags = await fetchReleaseTags(fetchImplementation);
  if (!Array.isArray(tags)) throw new Error("GitHub returned an invalid tag list.");

  const match = tags.find((entry) =>
    entry && typeof entry === "object" && (entry as { name?: unknown }).name === desired.tag);
  if (!match) return null;

  const commit = (match as { commit?: { sha?: unknown } }).commit?.sha;
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
    throw new Error(`GitHub reported no usable commit for ${desired.tag}.`);
  }
  return { tag: desired.tag, commit };
}

/**
 * How stale the agent's last check may be before this stops calling it present.
 *
 * Six times its timer. The unit fires every ten minutes with up to ten seconds
 * of jitter, and an upgrade it is performing holds the lock for far longer than
 * one interval — so a window of one or two would report the agent as gone
 * during precisely the run it is executing.
 */
export const UPDATE_AGENT_STALE_AFTER_MS = 60 * 60 * 1000;

export function updateAgentPresence(
  agent: { checkedAt: string } | null,
  now: number = Date.now(),
): { supported: boolean; reason: string } {
  if (!agent) {
    return {
      supported: false,
      reason: "No update agent has reported on this host. It is installed by install.sh from v5.6.0; a deployment installed before that runs the command below once to gain it, and updates from the dashboard after.",
    };
  }
  if (now - new Date(agent.checkedAt).getTime() > UPDATE_AGENT_STALE_AFTER_MS) {
    return {
      supported: false,
      reason: "The update agent on this host has not checked in for over an hour, so an approval would not be picked up. Confirm orcasynapse-update.timer is enabled on VM1.",
    };
  }
  return {
    supported: true,
    reason: "The update agent on VM1 applies an approved release, gates it on readiness, and restores the previous one if it does not serve. The dashboard still has no host-root or Docker control: the host reads the approval, nothing is pushed to it.",
  };
}

export async function checkForPlatformUpdate(
  currentTag: string,
  fetchImplementation: typeof fetch = fetch,
  target: PlatformReleaseTarget | null = null,
  agent: { checkedAt: string } | null = null,
): Promise<PlatformUpdate> {
  const current = parseReleaseVersion(currentTag);
  if (!current) throw new Error(`The installed version '${currentTag}' is not a release tag.`);

  const latest = latestReleaseVersion(await fetchReleaseTags(fetchImplementation));
  const presence = updateAgentPresence(agent);
  return platformUpdateSchema.parse({
    currentVersion: current.tag,
    latestVersion: latest.tag,
    updateAvailable: compareReleaseVersions(latest, current) > 0,
    releaseUrl: `https://github.com/multichainerz/AI/tree/${latest.tag}`,
    // Still returned when the agent is present. It is what an operator falls
    // back to when the agent is not reporting, and what a reader compares
    // against the commit the agent says it applied.
    updateCommand: `curl -fsSL ${INSTALLER_URL} | sudo ORCASYNAPSE_REF=${latest.tag} bash`,
    automaticUpdateSupported: presence.supported,
    automaticUpdateReason: presence.reason,
    checkedAt: new Date().toISOString(),
    target,
  });
}
