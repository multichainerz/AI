import { describe, expect, it } from "vitest";
import { inspectInputText } from "./runtime-policy.js";

const policy = {
  maxInputCharacters: 1_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
};

describe("OrcaSynapse runtime text policy", () => {
  it("allows ordinary multiline content", () => {
    expect(inspectInputText("summarize this\nwith a second line\tplease", policy)).toBeNull();
  });

  it("blocks unsafe control characters", () => {
    expect(inspectInputText("hello\u0000world", policy)).toBe("CONTROL_CHARACTERS");
  });

  it("blocks recognizable private credentials without logging their values", () => {
    expect(inspectInputText("-----BEGIN PRIVATE KEY-----\nsecret", policy)).toBe("CREDENTIAL_PATTERN");
    expect(inspectInputText("AKIAIOSFODNN7EXAMPLE", policy)).toBe("CREDENTIAL_PATTERN");
  });

  it("applies the input ceiling first", () => {
    expect(inspectInputText("x".repeat(1_001), policy)).toBe("INPUT_CHARACTER_LIMIT");
  });
});
