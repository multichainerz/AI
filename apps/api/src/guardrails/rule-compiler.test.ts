import { GuardrailPatternError, assertPatternIsSafe } from "@orcasynapse/security";
import { describe, expect, it } from "vitest";
import { GuardrailPatternError as ReexportedError, assertPatternIsSafe as reexported } from "./rule-compiler.js";

describe("guardrail rule-compiler re-export", () => {
  it("re-exports assertPatternIsSafe and GuardrailPatternError from @orcasynapse/security", () => {
    expect(reexported).toBe(assertPatternIsSafe);
    expect(ReexportedError).toBe(GuardrailPatternError);
  });
});
