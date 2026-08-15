import {
  auditEvent,
  createTestDatabase,
  platformReleaseTarget,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { DrizzlePlatformReleaseTargetManager } from "./drizzle-release-target-manager.js";
import {
  ReleaseTargetConflictError,
  ReleaseTargetUnavailableError,
  ReleaseTargetValidationError,
} from "./release-target-manager.js";

let context: TestDatabase;
beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const INSTALLED = "v5.2.2";
const NEXT_COMMIT = "3f6a1c9d20b74e5a8c1d0f2b7e4a9c6d5b8e0134";
const PREVIOUS_COMMIT = "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

const approver = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
} as AdminPrincipal;

const PUBLISHED = [
  { name: "v5.3.0", commit: { sha: NEXT_COMMIT } },
  { name: "v5.2.2", commit: { sha: "b".repeat(40) } },
  { name: "v5.2.1", commit: { sha: PREVIOUS_COMMIT } },
  { name: "documentation", commit: { sha: "c".repeat(40) } },
];

function manager(overrides: { tags?: unknown; status?: number } = {}) {
  const fetchImplementation = vi.fn(async () => new Response(
    JSON.stringify(overrides.tags ?? PUBLISHED),
    { status: overrides.status ?? 200 },
  ));
  return {
    releases: new DrizzlePlatformReleaseTargetManager(context.database, {
      currentVersion: INSTALLED,
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    }),
    fetchImplementation,
  };
}

const storedTargets = () => context.database.select().from(platformReleaseTarget);
const auditEvents = () => context.database.select().from(auditEvent);

describe("DrizzlePlatformReleaseTargetManager", () => {
  it("records one approved target and one audit event, pinned to the resolved commit", async () => {
    const { releases } = manager();

    const target = await releases.approve(approver, { desiredVersion: "v5.3.0", expectedRevision: 0 });

    expect(target).toMatchObject({
      desiredVersion: "v5.3.0",
      desiredCommit: NEXT_COMMIT,
      approvedBy: approver.id,
      approvedBySubject: "platform-admin",
      revision: 1,
    });
    // Singleton: approving does not accumulate rows, and the audit trail carries
    // the commit as well as the tag, because the tag alone is a moving ref.
    expect(await storedTargets()).toHaveLength(1);
    expect(await auditEvents()).toMatchObject([{
      actorType: "USER",
      actorId: approver.id,
      action: "platform.release-target.approved",
      resourceType: "PlatformReleaseTarget",
      resourceId: "global",
      outcome: "SUCCESS",
      metadata: { desiredVersion: "v5.3.0", desiredCommit: NEXT_COMMIT, installedVersion: INSTALLED },
    }]);
  });

  it("refuses a tag that is not a published release, and records nothing", async () => {
    const { releases } = manager();

    await expect(releases.approve(approver, { desiredVersion: "main", expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ReleaseTargetValidationError);
    await expect(releases.approve(approver, { desiredVersion: "v9.9.9", expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ReleaseTargetValidationError);
    // Listed by GitHub, but a branch rather than a release.
    await expect(releases.approve(approver, { desiredVersion: "documentation", expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ReleaseTargetValidationError);

    expect(await auditEvents()).toEqual([]);
    expect((await storedTargets()).map((row) => row.desiredVersion)).not.toContain("v9.9.9");
  });

  it("refuses a version below the one installed, because the migrations are forward-only", async () => {
    const { releases } = manager();

    await expect(releases.approve(approver, { desiredVersion: "v5.2.1", expectedRevision: 0 }))
      .rejects.toThrow(/older than the installed/);

    expect(await auditEvents()).toEqual([]);
  });

  it("refuses an approval raised against a revision that has since moved", async () => {
    const { releases } = manager();
    await releases.approve(approver, { desiredVersion: "v5.3.0", expectedRevision: 0 });

    await expect(releases.approve(approver, { desiredVersion: "v5.2.2", expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ReleaseTargetConflictError);

    const [stored] = await storedTargets();
    expect(stored).toMatchObject({ desiredVersion: "v5.3.0", revision: 1 });
  });

  it("clears an approved target and records that it was withdrawn", async () => {
    const { releases } = manager();
    await releases.approve(approver, { desiredVersion: "v5.3.0", expectedRevision: 0 });

    await releases.clear(approver);

    const [stored] = await storedTargets();
    expect(stored).toMatchObject({
      desiredVersion: null,
      desiredCommit: null,
      approvedBy: null,
      approvedBySubject: null,
      approvedAt: null,
      revision: 2,
    });
    expect((await auditEvents()).map((event) => event.action)).toEqual([
      "platform.release-target.approved",
      "platform.release-target.cleared",
    ]);
  });

  it("leaves the audit trail alone when there was nothing approved to clear", async () => {
    const { releases } = manager();

    await releases.clear(approver);
    await releases.clear(approver);

    expect(await auditEvents()).toEqual([]);
  });

  it("hands the panel the check and the stored target in one snapshot", async () => {
    const { releases } = manager();
    await releases.approve(approver, { desiredVersion: "v5.3.0", expectedRevision: 0 });

    const snapshot = await releases.snapshot();

    expect(snapshot).toMatchObject({
      currentVersion: INSTALLED,
      latestVersion: "v5.3.0",
      updateAvailable: true,
      target: { desiredVersion: "v5.3.0", desiredCommit: NEXT_COMMIT, approvedBySubject: "platform-admin" },
    });
  });

  it("separates a failed release lookup from a refused approval", async () => {
    const { releases } = manager({ status: 502 });

    // The operator did nothing wrong here, and the panel must not tell them the
    // version they picked was rejected.
    await expect(releases.approve(approver, { desiredVersion: "v5.3.0", expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ReleaseTargetUnavailableError);
    await expect(releases.snapshot()).rejects.toBeInstanceOf(ReleaseTargetUnavailableError);
  });
});
