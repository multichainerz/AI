import { describe, expect, it } from "vitest";
import {
  approveReleaseTargetSchema,
  platformReleaseTargetSchema,
  platformUpdateSchema,
} from "./platform.js";

const target = {
  desiredVersion: "v5.3.0",
  desiredCommit: "a".repeat(40),
  approvedBy: "8b1f4a0e-2d5c-4a71-9f3e-6c0b7d2a5e91",
  approvedBySubject: "platform-admin",
  approvedAt: "2026-08-15T00:00:00.000Z",
  revision: 1,
};

const update = {
  currentVersion: "v5.2.2",
  latestVersion: "v5.3.0",
  updateAvailable: true,
  releaseUrl: "https://github.com/multichainerz/AI/tree/v5.3.0",
  updateCommand: "curl installer | sudo ORCASYNAPSE_REF=v5.3.0 bash",
  automaticUpdateSupported: false as const,
  automaticUpdateReason: "The dashboard has no host control.",
  checkedAt: "2026-08-15T00:00:00.000Z",
  target: null,
};

describe("the approved release target", () => {
  it("only accepts a target pinned to a full 40-character commit", () => {
    /*
     * The commit is the half of the record that cannot move. A tag can be
     * re-pointed after approval, so an abbreviated, uppercase or absent commit
     * would leave the host agent free to apply something other than what was
     * approved — which is the one failure this record exists to prevent.
     */
    expect(platformReleaseTargetSchema.parse(target).desiredCommit).toBe("a".repeat(40));
    expect(platformReleaseTargetSchema.safeParse({ ...target, desiredCommit: "a".repeat(39) }).success).toBe(false);
    expect(platformReleaseTargetSchema.safeParse({ ...target, desiredCommit: "A".repeat(40) }).success).toBe(false);
    expect(platformReleaseTargetSchema.safeParse({ ...target, desiredCommit: "" }).success).toBe(false);
  });

  it("carries the target on the update check so one fetch drives the screen", () => {
    expect(platformUpdateSchema.parse(update).target).toBeNull();
    expect(platformUpdateSchema.parse({ ...update, target }).target).toMatchObject({
      desiredVersion: "v5.3.0",
      approvedBySubject: "platform-admin",
    });
    // Required rather than optional: a producer has to say whether a target is
    // set, because "field missing" and "nothing approved" are not the same
    // answer for a panel deciding what to tell the operator.
    const { target: _omitted, ...withoutTarget } = update;
    expect(platformUpdateSchema.safeParse(withoutTarget).success).toBe(false);
  });

  it("takes an approval as a tag plus the revision the operator was looking at", () => {
    expect(approveReleaseTargetSchema.parse({ desiredVersion: " v5.3.0 ", expectedRevision: 0 }))
      .toEqual({ desiredVersion: "v5.3.0", expectedRevision: 0 });
    expect(approveReleaseTargetSchema.safeParse({ desiredVersion: "v5.3.0" }).success).toBe(false);
    expect(approveReleaseTargetSchema.safeParse({ desiredVersion: "", expectedRevision: 0 }).success).toBe(false);
    expect(approveReleaseTargetSchema.safeParse({ desiredVersion: "v5.3.0", expectedRevision: -1 }).success).toBe(false);
    // Strict, so a caller cannot smuggle a commit past the server-side lookup.
    expect(approveReleaseTargetSchema.safeParse({
      desiredVersion: "v5.3.0",
      expectedRevision: 0,
      desiredCommit: "b".repeat(40),
    }).success).toBe(false);
  });
});
