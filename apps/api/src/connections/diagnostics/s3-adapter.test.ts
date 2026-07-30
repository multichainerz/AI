import { describe, expect, it } from "vitest";
import { S3Adapter } from "./s3-adapter.js";

const base = {
  id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
  activeRevision: 1,
  kind: "S3" as const,
  baseUrl: "https://s3.mpm.internal",
  configuration: { region: "us-east-1", forcePathStyle: true },
  secrets: {},
};

describe("S3Adapter", () => {
  it("fails configuration checks without making an unauthenticated bucket request", async () => {
    await expect(new S3Adapter().test(base, new AbortController().signal)).resolves.toEqual({
      status: "DEGRADED",
      message: "S3 bucket or credentials are incomplete.",
      details: { configuration: "incomplete" },
    });
  });

  it("requires an explicit endpoint", async () => {
    await expect(new S3Adapter().test({ ...base, baseUrl: null }, new AbortController().signal))
      .rejects.toThrow("S3 endpoint URL is not configured");
  });
});
