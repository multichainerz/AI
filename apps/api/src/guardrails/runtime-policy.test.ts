import { inspectInput } from "@orcasynapse/security";
import { describe, expect, it } from "vitest";
import { inspectInput as reexported } from "./runtime-policy.js";

describe("guardrail runtime-policy re-export", () => {
  it("re-exports inspectInput from @orcasynapse/security", () => {
    expect(reexported).toBe(inspectInput);
  });
});
