import { describe, expect, it } from "vitest";
import { parseStoredRevision } from "./prisma-connection-manager.js";

const legacyRevision = {
  slug: "documents",
  displayName: "Document storage",
  kind: "SEAWEEDFS",
  environment: "PRODUCTION",
  baseUrl: "https://objects.mpm.internal",
  enabled: true,
  configuration: {
    bucket: "aihub-documents",
    region: "us-east-1",
  },
  secretFieldNames: ["accessKeyId", "secretAccessKey"],
};

describe("parseStoredRevision", () => {
  it("reads an immutable SeaweedFS-era revision as a path-style S3 connection", () => {
    expect(parseStoredRevision(legacyRevision)).toMatchObject({
      kind: "S3",
      configuration: {
        bucket: "aihub-documents",
        region: "us-east-1",
        forcePathStyle: true,
      },
    });
    expect(legacyRevision).not.toHaveProperty("configuration.forcePathStyle");
  });

  it("preserves an explicit addressing choice from a legacy revision", () => {
    expect(parseStoredRevision({
      ...legacyRevision,
      configuration: { ...legacyRevision.configuration, forcePathStyle: false },
    }).configuration.forcePathStyle).toBe(false);
  });
});
