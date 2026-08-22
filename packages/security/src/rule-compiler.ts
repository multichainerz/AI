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

/**
 * Probe sizes, smallest first, doubling to the length a real message reaches.
 *
 * A pattern that backtracks exponentially roughly doubles its work per added
 * character, so the sequence matters more than the ceiling: measuring at 16 and
 * 32 costs microseconds for every pattern this is meant to admit, and gives a
 * catastrophic one somewhere to be caught before it is asked for 256 characters
 * and never comes back.
 */
const PROBE_LENGTHS = [16, 32, 64, 128, 256];

const BACKREFERENCE = /\\[1-9]/;
const LOOKAROUND = /\(\?[=!<]/;

/**
 * What a repeated group contains, ignoring escapes and character classes.
 *
 * A scan rather than a regex, because the regex this replaced was
 * `/\([^)]*[+*}]\)[\s]*[+*{]/` and `[^)]*` cannot see past an inner
 * parenthesis. It therefore missed `((a+))+` -- the module's own documented
 * example with one bracket added -- along with every alternation form. A `]`
 * inside a class and a `\(` in the pattern text are both handled here for the
 * same reason: a gate that can be stepped around by adding a character is not a
 * gate.
 */
function scanGroupBody(body: string): { quantifier: boolean; alternation: boolean } {
  let quantifier = false;
  let alternation = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\\") { index += 1; continue; }
    if (character === "[") {
      index += 1;
      while (index < body.length && body[index] !== "]") {
        if (body[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (character === "+" || character === "*" || character === "{") quantifier = true;
    else if (character === "|") alternation = true;
  }
  return { quantifier, alternation };
}

/**
 * A group that repeats, whose body can match the same text more than one way.
 *
 * Both shapes below make a match position ambiguous, which is what turns a
 * failed match into exponential retrying:
 *
 * - **A quantifier inside a repeated group** -- `(a+)+`, `(a*)*`, `((a+))+`.
 * - **An alternation inside a repeated group** -- `(a|a)*`, `(a+|b)+`, and
 *   `^(\w+\s?)*$`. This family was missed entirely, and it is the one that
 *   matters most in practice: the last of those is an ordinary human-written
 *   validation regex that anybody might paste in, not a pathological construct.
 *
 * Deliberately approximate, and deliberately erring towards refusal. It refuses
 * `(ab+)+` and `(cat|dog)+`, neither of which is actually catastrophic. That is
 * the right way to be wrong: the cost is an operator rewriting a pattern, and
 * the cost of the other mistake is an inference path that stops answering.
 */
function repeatedGroupRisk(pattern: string): "NESTED_QUANTIFIER" | "REPEATED_ALTERNATION" | null {
  const openings: number[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") { index += 1; continue; }
    if (character === "[") {
      index += 1;
      while (index < pattern.length && pattern[index] !== "]") {
        if (pattern[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (character === "(") { openings.push(index + 1); continue; }
    if (character !== ")") continue;
    const contentStart = openings.pop();
    // Unbalanced. `new RegExp` reports it better than this could.
    if (contentStart === undefined) continue;
    if (!/^\s*[+*{]/.test(pattern.slice(index + 1))) continue;
    const { quantifier, alternation } = scanGroupBody(pattern.slice(contentStart, index));
    if (quantifier) return "NESTED_QUANTIFIER";
    if (alternation) return "REPEATED_ALTERNATION";
  }
  return null;
}

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
 * **The probe runs on the request thread, so it cannot fully contain what it is
 * looking for.** A pattern bad enough to hang production could hang this probe
 * and take the save request with it. Two things reduce that to a risk worth
 * accepting rather than a certainty:
 *
 * - The static rejections run first and carry most of the weight: they catch
 *   the *shapes* that backtrack exponentially before anything is executed.
 * - The probe grows from 16 characters to 256 rather than starting at 256, so a
 *   pattern that doubles its work per character exceeds the budget at a length
 *   it can still finish. This was the gap that made the first bullet
 *   load-bearing in a way it could not support: the static gate was one regex
 *   that missed every alternation form, and the probe's longest input ran
 *   before any elapsed time was measured.
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
  const risk = repeatedGroupRisk(pattern);
  if (risk === "NESTED_QUANTIFIER") {
    throw new GuardrailPatternError(
      "NESTED_QUANTIFIER",
      "A repeated group that already repeats — such as (a+)+ — is refused: it backtracks exponentially.",
    );
  }
  if (risk === "REPEATED_ALTERNATION") {
    throw new GuardrailPatternError(
      "NESTED_QUANTIFIER",
      "A repeated group containing alternation — such as (a|a)* — is refused: "
      + "two branches that can match the same text make every position ambiguous, which backtracks exponentially.",
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
   *
   * **Short to long, checking the budget between each.** The previous version
   * ran every probe at the full 256 characters, which meant the one probe most
   * likely to reveal a catastrophic pattern -- a long run ending in a character
   * that forces the match to fail -- was also the one guaranteed to hang before
   * any elapsed time could be measured. Growth is what exposes these patterns:
   * a doubling per character is invisible at 16 and unmissable at 64, so the
   * gate now trips there rather than never returning at 256.
   */
  const seed = /[A-Za-z0-9]/.exec(pattern)?.[0] ?? "a";
  for (const length of PROBE_LENGTHS) {
    const probes = [
      seed.repeat(length),
      "a".repeat(length),
      "ab".repeat(length / 2),
      `${seed.repeat(length - 1)}!`,
    ];
    for (const probe of probes) {
      const startedAt = performance.now();
      expression.test(probe);
      const elapsed = performance.now() - startedAt;
      if (elapsed > PROBE_BUDGET_MS) {
        throw new GuardrailPatternError(
          "TOO_SLOW",
          `The pattern took ${Math.round(elapsed)}ms against a ${length}-character probe. `
          + "A pattern that slow on a short input will be far slower on a real message.",
        );
      }
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
