import { describe, expect, it } from "vitest";
import { parseStoredRevision } from "./prisma-connection-manager.js";

const revision = {
  slug: "inference-primary",
  displayName: "Inference Primary",
  kind: "VLLM",
  environment: "PRODUCTION",
  baseUrl: "https://vllm.mpm.internal",
  enabled: true,
  configuration: { healthPath: "/health", modelsPath: "/v1/models" },
  secretFieldNames: ["apiKey"],
};

describe("parseStoredRevision", () => {
  it("reads an immutable revision for a supported connection kind", () => {
    expect(parseStoredRevision(revision)).toMatchObject({
      kind: "VLLM",
      configuration: { healthPath: "/health", modelsPath: "/v1/models" },
    });
  });

  it("rejects revisions for retired connection kinds", () => {
    expect(() => parseStoredRevision({ ...revision, kind: "OBJECT_STORE" })).toThrow("stored revision is malformed");
  });
});
