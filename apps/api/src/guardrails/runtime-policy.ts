import type { GuardrailRule } from "@orcasynapse/contracts";
import { compileRule } from "./rule-compiler.js";

export interface RuntimeTextPolicy {
  maxInputCharacters: number;
  maxOutputCharacters: number;
  blockControlCharacters: boolean;
  blockCredentialPatterns: boolean;
}

export type RuntimePolicyViolation =
  | "INPUT_CHARACTER_LIMIT"
  | "CONTROL_CHARACTERS"
  | "CREDENTIAL_PATTERN"
  /** An operator's own rule refused it; `matches` names which. */
  | "RULE_BLOCKED"
  /** The rule list did not finish inside its budget, so the request fails closed. */
  | "RULE_BUDGET_EXCEEDED";

const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
];

/** What a REDACT rule leaves behind, so the text still reads as having had something removed. */
export const REDACTION_MARKER = "[redacted]";

/**
 * How long the whole custom rule list may spend on one message.
 *
 * This does not interrupt a single slow match — nothing on one thread can — so
 * it is not the ReDoS containment and must not be mistaken for it (see
 * `assertPatternIsSafe`, which is). What it bounds is a *list*: fifty rules
 * that are each a little slow, on every message, is a latency problem an
 * operator can create without any one pattern looking wrong. Exceeding it fails
 * closed and names the rule that was running, which is the part that makes it
 * fixable.
 */
const RULE_BUDGET_MS = 50;

export interface GuardrailRuleMatch {
  ruleId: string;
  label: string;
  action: GuardrailRule["action"];
  count: number;
}

export interface GuardrailInspection {
  decision: "ALLOW" | "BLOCK";
  /** What to tell the caller. Null when nothing refused the input. */
  reason: RuntimePolicyViolation | null;
  /** The text to use from here on — redacted where a REDACT rule matched. */
  text: string;
  /**
   * Every rule that matched, including the ones that changed nothing.
   *
   * All of them rather than the first, because the audit trail's job is to say
   * what the policy saw. A FLAG rule that matches on traffic an operator is
   * about to switch to BLOCK is the whole reason FLAG exists, and it is
   * invisible if evaluation stops at the first hit.
   */
  matches: GuardrailRuleMatch[];
}

function allow(text: string, matches: GuardrailRuleMatch[] = []): GuardrailInspection {
  return { decision: "ALLOW", reason: null, text, matches };
}

function block(reason: RuntimePolicyViolation, text: string, matches: GuardrailRuleMatch[] = []): GuardrailInspection {
  return { decision: "BLOCK", reason, text, matches };
}

/**
 * The built-in checks, unchanged since before rules existed.
 *
 * Kept as its own exported function rather than folded into `inspectInput`
 * because two callers still want exactly this question — and because its four
 * tests are the pinned description of behaviour that the rule work is not
 * supposed to alter.
 */
export function inspectInputText(
  value: string,
  policy: Pick<RuntimeTextPolicy, "maxInputCharacters" | "blockControlCharacters" | "blockCredentialPatterns">,
): RuntimePolicyViolation | null {
  if (value.length > policy.maxInputCharacters) return "INPUT_CHARACTER_LIMIT";
  if (policy.blockControlCharacters && UNSAFE_CONTROL_CHARACTER.test(value)) return "CONTROL_CHARACTERS";
  if (policy.blockCredentialPatterns && CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    return "CREDENTIAL_PATTERN";
  }
  return null;
}

/**
 * The whole input decision: the shipped detectors, then the operator's rules.
 *
 * Order is deliberate and load-bearing. The length ceiling runs first, exactly
 * as it always has, so a message far past the limit is refused for the reason
 * an operator configured rather than after being matched against a hundred
 * patterns. The built-in detectors run next. Custom rules run last, over text
 * already known to be bounded — which is also what keeps the cost of the rule
 * list proportional to a limit somebody chose.
 *
 * A BLOCK anywhere wins over every REDACT, because a redaction is a claim that
 * what remains is safe to send, and a blocked message is a claim that it is
 * not. Those cannot both be honoured, and the refusing one has to be the one
 * that survives.
 */
export function inspectInput(
  value: string,
  policy: Pick<RuntimeTextPolicy, "maxInputCharacters" | "blockControlCharacters" | "blockCredentialPatterns">,
  rules: readonly GuardrailRule[] = [],
): GuardrailInspection {
  const builtIn = inspectInputText(value, policy);
  if (builtIn) return block(builtIn, value);

  const matches: GuardrailRuleMatch[] = [];
  let blocked = false;
  let text = value;
  const startedAt = performance.now();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (performance.now() - startedAt > RULE_BUDGET_MS) {
      return block("RULE_BUDGET_EXCEEDED", value, [
        ...matches,
        { ruleId: rule.id, label: rule.label, action: rule.action, count: 0 },
      ]);
    }

    const compiled = compileRule(rule);
    /*
     * Counted against the original text, not against `text`, so an earlier
     * redaction cannot hide a later rule's match. Two rules matching the same
     * credential should both be reported; the alternative makes the audit
     * trail depend on the order somebody happened to add them in.
     */
    const found = value.match(compiled.expression);
    if (!found || found.length === 0) continue;

    matches.push({ ruleId: rule.id, label: rule.label, action: rule.action, count: found.length });
    if (rule.action === "BLOCK") {
      blocked = true;
      continue;
    }
    if (rule.action === "REDACT") {
      text = text.replace(compiled.expression, REDACTION_MARKER);
    }
  }

  // A blocked message keeps its original text: the caller is going to refuse it
  // rather than send it, and handing back a half-redacted version would invite
  // somebody to send that instead.
  return blocked ? block("RULE_BLOCKED", value, matches) : allow(text, matches);
}
