import type { GuardrailRule } from "@orcasynapse/contracts";

/**
 * `RegExp.escape`, declared rather than unlocked repo-wide.
 *
 * It is ES2025 and `tsconfig.base.json` pins `lib` to ES2023 — deliberately, so
 * that what the codebase may reach for is a decision rather than a side effect.
 * Raising the whole repository's lib to get one function would quietly admit
 * every other ES2024/2025 API at the same time, which is a bigger change than
 * this module is asking for.
 *
 * The runtime has it: `engines.node` is `>=24.0.0`, both images are
 * `node:24-bookworm-slim`, and V8 shipped it before Node 24.0. If that floor
 * ever moves down, this breaks loudly at the first rule compiled rather than
 * subtly — which is the failure mode to want.
 */
declare global {
  interface RegExpConstructor {
    escape(value: string): string;
  }
}

/**
 * Turns an operator's rule into something that can be matched, and refuses the
 * patterns that would make matching a denial of service.
 *
 * Three of the four rule types never reach a regular-expression parser at all:
 * the operator's text is escaped, so `a+b` matches the literal three characters
 * rather than becoming a quantifier. That is what makes WORD, PHRASE and PREFIX
 * safe by construction rather than by review, and it is why they are the types
 * the screen presents first.
 */

/** Why a pattern was refused, so the screen can say something better than "invalid". */
export type GuardrailPatternRefusal =
  | "BACKREFERENCE"
  | "LOOKAROUND"
  | "NESTED_QUANTIFIER"
  | "TOO_LONG"
  | "SYNTAX"
  | "TOO_SLOW";

export class GuardrailPatternError extends Error {
  constructor(readonly refusal: GuardrailPatternRefusal, message: string) {
    super(message);
    this.name = "GuardrailPatternError";
  }
}

export interface CompiledRule {
  id: string;
  label: string;
  action: GuardrailRule["action"];
  expression: RegExp;
}

/** The ceiling the contract already applies; restated so this module can stand alone. */
const MAX_PATTERN_CHARACTERS = 200;

/**
 * How long one pattern may take against a probe before it is refused.
 *
 * Generous on purpose. A linear pattern finishes a 256-character probe in
 * microseconds, so anything approaching a millisecond is already behaving
 * unlike the patterns this is meant to admit -- but a loaded CI runner adds
 * noise, and a gate that fails a good pattern because the machine was busy is a
 * gate people route around.
 */
const PROBE_BUDGET_MS = 20;
const PROBE_LENGTH = 256;

/**
 * A quantifier applied to a group that already contains one: `(a+)+`, `(a*)*`,
 * `(a+)*`, `(\d+)+`.
 *
 * This is the shape that produces exponential backtracking, and catching it
 * statically is the real gate -- the timing probe below cannot be, because a
 * pattern catastrophic enough to matter would hang the probe itself.
 *
 * Deliberately approximate, and deliberately erring towards refusal. It will
 * refuse `(ab+)+`, which is not actually catastrophic. That is the right way to
 * be wrong: the cost is an operator rewriting a pattern, and the cost of the
 * other mistake is an inference path that stops answering.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*}]\)[\s]*[+*{]/;
const BACKREFERENCE = /\\[1-9]/;
const LOOKAROUND = /\(\?[=!<]/;

/**
 * Refuses a pattern this deployment is not willing to evaluate.
 *
 * ## What this protects against
 *
 * An administrator with `guardrails:manage` writes a pattern; every user's
 * input is then matched against it. A catastrophic pattern therefore turns any
 * user's message into an event-loop stall -- not a privilege escalation, but a
 * denial of service that the person who caused it did not intend and cannot see.
 *
 * ## What it does not
 *
 * **Step three runs on the request thread, so it cannot contain what it is
 * looking for.** A pattern bad enough to hang production would hang this probe
 * and take the save request with it. That is why the static rejections run
 * first and are the load-bearing half: they catch the *shapes* that backtrack
 * exponentially, before anything is executed. The probe is a second net for
 * what a short input can still reveal -- a pattern that is merely slow rather
 * than catastrophic.
 *
 * A pattern that passes both and is still slow on production input remains
 * possible. That residual risk is accepted deliberately.
 *
 * ## The option not taken
 *
 * The airtight answer is to evaluate in a pooled worker thread with a hard
 * millisecond budget, terminating and respawning a worker that overruns. It was
 * considered and declined: it adds a pool, a watchdog, a respawn path and a new
 * failure mode under saturation, to remove a risk from an already-authenticated
 * administrator role. If that trade is ever revisited, the reason it went this
 * way the first time is written here rather than lost -- and `inspectInput`'s
 * rule-budget check is the mitigation that was possible without it.
 */
export function assertPatternIsSafe(pattern: string): void {
  if (pattern.length > MAX_PATTERN_CHARACTERS) {
    throw new GuardrailPatternError(
      "TOO_LONG",
      `A pattern may be at most ${MAX_PATTERN_CHARACTERS} characters.`,
    );
  }
  if (BACKREFERENCE.test(pattern)) {
    throw new GuardrailPatternError(
      "BACKREFERENCE",
      "Backreferences are refused: matching them is not bounded by the length of the input.",
    );
  }
  if (LOOKAROUND.test(pattern)) {
    throw new GuardrailPatternError(
      "LOOKAROUND",
      "Lookahead and lookbehind are refused: they can multiply the work each position costs.",
    );
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new GuardrailPatternError(
      "NESTED_QUANTIFIER",
      "A repeated group that already repeats — such as (a+)+ — is refused: it backtracks exponentially.",
    );
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "u");
  } catch (error) {
    throw new GuardrailPatternError(
      "SYNTAX",
      error instanceof Error ? error.message : "The pattern is not a valid regular expression.",
    );
  }

  /*
   * Probes chosen to be what a backtracking pattern is slowest on: a long run
   * of one character that the pattern's own first literal suggests, a long run
   * of a character it does not expect, and an alternating sequence. None of
   * them prove a pattern safe; they only catch one that is visibly not.
   */
  const seed = /[A-Za-z0-9]/.exec(pattern)?.[0] ?? "a";
  const probes = [
    seed.repeat(PROBE_LENGTH),
    "a".repeat(PROBE_LENGTH),
    "ab".repeat(PROBE_LENGTH / 2),
    `${seed.repeat(PROBE_LENGTH - 1)}!`,
  ];
  for (const probe of probes) {
    const startedAt = performance.now();
    expression.test(probe);
    const elapsed = performance.now() - startedAt;
    if (elapsed > PROBE_BUDGET_MS) {
      throw new GuardrailPatternError(
        "TOO_SLOW",
        `The pattern took ${Math.round(elapsed)}ms against a ${PROBE_LENGTH}-character probe. `
        + "A pattern that slow on a short input will be far slower on a real message.",
      );
    }
  }
}

/**
 * The operator's literal text, as a pattern that matches exactly it.
 *
 * `RegExp.escape` rather than a hand-rolled character class, because escaping
 * operator-supplied text is security-relevant and the specification function is
 * correct by construction where a hand-rolled one is correct until somebody
 * finds the character it forgot.
 *
 * One surprise, recorded so it is not "fixed": it returns `\x61\+b` for `a+b`,
 * not `a\+b`. The specification hex-escapes a leading alphanumeric so the
 * result can never merge with adjacent syntax — which is exactly the property
 * wanted here, since these are concatenated with `\b`. It matches identically;
 * it only reads oddly in a debugger.
 */
function literal(value: string): string {
  return RegExp.escape(value);
}

/**
 * Compiles one rule.
 *
 * `assertPatternIsSafe` is *not* called here. It runs at save time in the
 * manager, so an unsafe pattern can never be stored — and calling it again on
 * every inspection would spend the probe budget on the hot path to re-derive an
 * answer that was already decided. The two responsibilities are kept apart on
 * purpose: this compiles what was already admitted.
 */
export function compileRule(rule: GuardrailRule): CompiledRule {
  const flags = rule.caseSensitive ? "gu" : "giu";
  const source = rule.type === "WORD"
    ? `\\b${literal(rule.pattern)}\\b`
    : rule.type === "PREFIX"
      ? `\\b${literal(rule.pattern)}`
      /*
       * A phrase an operator typed with one space has to keep matching text a
       * model wrapped across a line, so each run of whitespace becomes `\s+`.
       *
       * Split first, escape the pieces, then join — not escape-then-relax.
       * `RegExp.escape` renders a space as `\x20` and a tab as `\t`, so after
       * escaping there is no whitespace character left to find: a pass looking
       * for `\s` matches nothing and the phrase silently stays exact-space-only.
       * That is precisely the bug this comment replaced.
       */
      : rule.type === "PHRASE"
        ? rule.pattern.split(/\s+/).map(literal).join("\\s+")
        : rule.pattern;

  return {
    id: rule.id,
    label: rule.label,
    action: rule.action,
    expression: new RegExp(source, flags),
  };
}
