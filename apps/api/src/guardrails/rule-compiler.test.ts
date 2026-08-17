import type { GuardrailRule } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { GuardrailPatternError, assertPatternIsSafe, compileRule } from "./rule-compiler.js";

function rule(overrides: Partial<GuardrailRule> = {}): GuardrailRule {
  return {
    id: "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
    label: "Rule",
    type: "WORD",
    pattern: "seahorse",
    action: "BLOCK",
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

function refusalFor(pattern: string): string {
  try {
    assertPatternIsSafe(pattern);
  } catch (error) {
    if (error instanceof GuardrailPatternError) return error.refusal;
    throw error;
  }
  return "ACCEPTED";
}

describe("guardrail rule compiler", () => {
  it("matches a word without matching it inside a longer one", () => {
    const { expression } = compileRule(rule({ type: "WORD", pattern: "cat" }));
    expect(expression.test("the cat sat")).toBe(true);
    expression.lastIndex = 0;
    expect(expression.test("concatenate")).toBe(false);
  });

  it("treats a literal as literal, so regex syntax in a word is text", () => {
    /*
     * The whole reason the structured types exist. An operator writing `a+b`
     * means those three characters, and if that reached a regex parser it would
     * mean "one or more a, then b" -- a rule that silently matches the wrong
     * thing and can never be debugged from the screen.
     */
    const { expression } = compileRule(rule({ type: "PHRASE", pattern: "a+b" }));
    expect(expression.test("a+b")).toBe(true);
    expression.lastIndex = 0;
    expect(expression.test("aaab")).toBe(false);
  });

  it("lets a phrase survive the line break a model wrapped it across", () => {
    const { expression } = compileRule(rule({ type: "PHRASE", pattern: "internal only" }));
    expect(expression.test("marked internal only here")).toBe(true);
    expression.lastIndex = 0;
    expect(expression.test("marked internal\n   only here")).toBe(true);
  });

  it("anchors a prefix to a word start", () => {
    const { expression } = compileRule(rule({ type: "PREFIX", pattern: "sk-" }));
    expect(expression.test("key sk-abcdef")).toBe(true);
    expression.lastIndex = 0;
    expect(expression.test("risk-averse")).toBe(false);
  });

  it("honours case sensitivity in both directions", () => {
    expect(compileRule(rule({ pattern: "Seahorse", caseSensitive: true })).expression.test("seahorse")).toBe(false);
    expect(compileRule(rule({ pattern: "Seahorse", caseSensitive: false })).expression.test("seahorse")).toBe(true);
  });

  it("admits a legitimate regex", () => {
    expect(refusalFor("[A-Z]{2}\\d{6}")).toBe("ACCEPTED");
    expect(refusalFor("(alpha|beta|gamma)-\\d+")).toBe("ACCEPTED");
    const { expression } = compileRule(rule({ type: "REGEX", pattern: "[A-Z]{2}\\d{6}" }));
    expect(expression.test("ref AB123456")).toBe(true);
  });

  it("refuses each unsafe shape with a reason an operator can act on", () => {
    /*
     * Distinct refusals rather than one "invalid pattern", because the screen
     * shows this and the difference between "you used a lookahead" and "this
     * backtracks exponentially" is the difference between a rewrite and a
     * shrug.
     */
    expect(refusalFor("(a+)+b")).toBe("NESTED_QUANTIFIER");
    expect(refusalFor("(a*)*b")).toBe("NESTED_QUANTIFIER");
    expect(refusalFor("(\\d+)+")).toBe("NESTED_QUANTIFIER");
    expect(refusalFor("(a)\\1")).toBe("BACKREFERENCE");
    expect(refusalFor("foo(?=bar)")).toBe("LOOKAROUND");
    expect(refusalFor("(?<!x)y")).toBe("LOOKAROUND");
    expect(refusalFor("[unclosed")).toBe("SYNTAX");
    expect(refusalFor("a".repeat(201))).toBe("TOO_LONG");
  });

  it("refuses the catastrophic pattern before it is ever executed", () => {
    /*
     * The load-bearing assertion in this file. `(a+)+$` against a long run of
     * `a` is the textbook exponential case; if the static check did not catch
     * it, the timing probe would try to run it and this test would not fail --
     * it would hang. That it returns promptly is the evidence that nothing
     * executed the pattern.
     */
    const startedAt = performance.now();
    expect(refusalFor("(a+)+$")).toBe("NESTED_QUANTIFIER");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
