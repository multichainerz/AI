import type { GuardrailRule } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { REDACTION_MARKER, inspectInput, inspectInputText } from "./runtime-policy.js";

const policy = {
  maxInputCharacters: 1_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
};

let nextRuleId = 0;
function rule(overrides: Partial<GuardrailRule> = {}): GuardrailRule {
  nextRuleId += 1;
  return {
    id: `0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e${String(nextRuleId).padStart(2, "0")}`,
    label: `Rule ${nextRuleId}`,
    type: "WORD",
    pattern: "seahorse",
    action: "BLOCK",
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

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

describe("OrcaSynapse guardrail rules", () => {
  it("allows text no rule matches, and reports nothing", () => {
    const result = inspectInput("a perfectly ordinary question", policy, [rule()]);
    expect(result).toMatchObject({ decision: "ALLOW", reason: null, text: "a perfectly ordinary question" });
    expect(result.matches).toEqual([]);
  });

  it("blocks on a matching rule and names it without quoting the text", () => {
    const blocking = rule({ label: "Internal codename", pattern: "seahorse" });
    const result = inspectInput("the seahorse programme", policy, [blocking]);

    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toBe("RULE_BLOCKED");
    expect(result.matches).toEqual([
      { ruleId: blocking.id, label: "Internal codename", action: "BLOCK", count: 1 },
    ]);
    // The caller refuses this rather than sending it, so the text is handed
    // back untouched -- a half-redacted version would invite sending that.
    expect(result.text).toBe("the seahorse programme");
  });

  it("redacts without blocking, and rewrites every occurrence", () => {
    const result = inspectInput("seahorse and seahorse", policy, [rule({ action: "REDACT" })]);

    expect(result.decision).toBe("ALLOW");
    expect(result.text).toBe(`${REDACTION_MARKER} and ${REDACTION_MARKER}`);
    expect(result.matches[0]).toMatchObject({ action: "REDACT", count: 2 });
  });

  it("lets a block win over a redaction, whichever order they are in", () => {
    /*
     * A redaction claims what remains is safe to send; a block claims it is
     * not. Both cannot be honoured, and the refusing one has to survive --
     * including when the redaction rule is evaluated first and has already
     * rewritten the working copy.
     */
    const redact = rule({ pattern: "alpha", action: "REDACT" });
    const blocked = rule({ pattern: "beta", action: "BLOCK" });

    for (const rules of [[redact, blocked], [blocked, redact]]) {
      const result = inspectInput("alpha and beta", policy, rules);
      expect(result.decision).toBe("BLOCK");
      expect(result.text).toBe("alpha and beta");
      expect(result.matches).toHaveLength(2);
    }
  });

  it("records a flagged match while changing neither the decision nor the text", () => {
    // The whole reason FLAG exists: measuring what a rule would catch on live
    // traffic before it is trusted to refuse anything.
    const result = inspectInput("the seahorse programme", policy, [rule({ action: "FLAG" })]);

    expect(result.decision).toBe("ALLOW");
    expect(result.text).toBe("the seahorse programme");
    expect(result.matches[0]).toMatchObject({ action: "FLAG", count: 1 });
  });

  it("skips a disabled rule entirely", () => {
    expect(inspectInput("the seahorse programme", policy, [rule({ enabled: false })]))
      .toMatchObject({ decision: "ALLOW", matches: [] });
  });

  it("reports every rule that matched, not only the first", () => {
    const first = rule({ pattern: "seahorse", action: "FLAG" });
    const second = rule({ pattern: "programme", action: "FLAG" });

    expect(inspectInput("the seahorse programme", policy, [first, second]).matches).toHaveLength(2);
  });

  it("does not let an earlier redaction hide a later rule's match", () => {
    /*
     * Matching is counted against the original text rather than the working
     * copy. Otherwise which rules appear in the audit trail would depend on the
     * order somebody happened to add them in.
     */
    const result = inspectInput("seahorse", policy, [
      rule({ pattern: "seahorse", action: "REDACT" }),
      rule({ pattern: "seahorse", action: "FLAG" }),
    ]);

    expect(result.matches).toHaveLength(2);
    expect(result.decision).toBe("ALLOW");
  });

  it("keeps the built-in checks ahead of the rule list", () => {
    // A message past the ceiling is refused for the reason an operator
    // configured, rather than after being matched against every rule.
    expect(inspectInput("x".repeat(1_001), policy, [rule({ pattern: "x" })]).reason)
      .toBe("INPUT_CHARACTER_LIMIT");
  });

  it("honours case sensitivity and word boundaries through the evaluator", () => {
    expect(inspectInput("Seahorse", policy, [rule({ caseSensitive: true })]).decision).toBe("ALLOW");
    expect(inspectInput("Seahorse", policy, [rule({ caseSensitive: false })]).decision).toBe("BLOCK");
    expect(inspectInput("seahorses", policy, [rule({ type: "WORD" })]).decision).toBe("ALLOW");
  });

  it("fails closed when the rule list outruns its time budget", () => {
    /*
     * The only refusal in this module that is not the operator's decision, and
     * until now no test executed it -- so inverting the comparison would have
     * left the suite green while every message carrying an enabled rule was
     * refused. A budget of zero reaches it on the first rule, deterministically,
     * which is why the ceiling is a parameter rather than something to race.
     */
    const result = inspectInput("nothing objectionable here", policy, [rule({ action: "FLAG" })], 0);

    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toBe("RULE_BUDGET_EXCEEDED");
    // The rule it gave up on is named, so an operator can see where it stopped.
    expect(result.matches).toHaveLength(1);
  });

  it("evaluates every rule when the budget is not the constraint", () => {
    // The other direction, so a change that made the check always fire would be
    // caught too rather than reading as "fails closed, as designed".
    const result = inspectInput("nothing objectionable here", policy, [rule({ action: "FLAG" })]);

    expect(result.decision).toBe("ALLOW");
    expect(result.reason).toBeNull();
  });
});
