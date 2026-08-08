import { streamChatCompletion, type DrizzleRuntimeConnectionResolver } from "@orcasynapse/runtime-clients";

/**
 * Decides which stored facts a natural-language forget request is about.
 *
 * "Forget everything about Project Titan" is the request people actually make,
 * and neither a LIKE nor a similarity floor answers it: the facts to remove may
 * say "the Titan migration", "the Q3 rebuild", or name a colleague who only
 * worked on it. Only a model reading the facts against the target decides that.
 *
 * No embedder here, by the same rule that keeps one out of the document
 * manager: the API extracts and queues, the worker owns embedding. That is
 * affordable because agent memory is small — each fact is at most 200
 * characters and policy bounds an owner to a few hundred — so the candidate set
 * is handed to the model whole rather than pre-filtered by a vector search that
 * would need weights loaded into this process.
 */

/**
 * Shorter than the distiller's, because a person is waiting on this one.
 *
 * Forget-matching answers an HTTP request, so the ceiling is what an operator
 * will sit through rather than what the model might want. A large reasoning
 * model over a tunnel took 193 seconds for a single short prompt on the pilot,
 * so 120s was refusing work that would have succeeded; 300s covers that without
 * turning a dashboard click into an indefinite wait.
 */
const REQUEST_TIMEOUT_MS = 300_000;
const MAXIMUM_RESPONSE_TOKENS = 2_400;

/**
 * How much stored memory one decision may read.
 *
 * Beyond this the request is answered from a prefix and reported as truncated,
 * never silently trimmed: an operator told "3 matched" has to be able to trust
 * that the other rows were looked at.
 */
const MAXIMUM_CANDIDATE_CHARACTERS = 12_000;

const MATCHING_INSTRUCTION = [
  "You decide which stored facts about a person are about a given TOPIC.",
  "",
  "Return ONLY a JSON array of the numbers of the facts that are about the",
  "topic. No prose, no code fence, no explanation. Return [] when none are.",
  "",
  "A fact is about the topic when it names it, describes work on it, or is only",
  "meaningful because of it. A fact that merely shares a word with the topic is",
  "NOT about it.",
  "",
  "Be conservative. These facts are about to be forgotten, and a fact removed by",
  "mistake cannot be recovered by the person who asked.",
  "",
  "Examples:",
  "TOPIC: Project Titan",
  "FACTS:",
  "1. The user leads the Titan migration.",
  "2. The user works in Jakarta.",
  "3. The user's deadline for Titan is in March.",
  "4. The user prefers titan-grade aluminium for their bike frame.",
  "[1, 3]",
  "",
  "TOPIC: my old employer",
  "FACTS:",
  "1. The user prefers answers in Indonesian.",
  "[]",
].join("\n");

export interface ForgetCandidate {
  id: string;
  content: string;
}

export interface ForgetMatch {
  /** Ids the model judged to be about the topic. */
  matchedIds: string[];
  /** False when the model could not be reached or answered unusably. */
  succeeded: boolean;
  /** True when more candidates existed than one decision could read. */
  truncated: boolean;
}

/**
 * Where the array opened at `start` closes, or -1 if it never does.
 *
 * String contents are stepped over so a bracket inside a stored fact cannot
 * close the array early, and an unterminated answer reports -1 rather than a
 * span that happens to end on someone else's bracket.
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The model's answer array, or null when it did not produce one.
 *
 * Spanning the first "[" to the last "]" stops being a JSON array the moment
 * the model writes a bracket anywhere around its answer. Restating the numbered
 * facts it was shown is enough, and so is a serving stack that emits its
 * thinking into `content`: the span then swallows the prose between the two
 * brackets and the parse fails, which reaches the operator as "nothing matched"
 * — the one answer this path must never invent.
 *
 * Balanced spans are scanned instead and the last one wins. A model that
 * reasons in `content` puts its conclusion at the end, and [] is a real answer
 * here, so taking the first or the widest span would read the preamble's
 * brackets as a decision to forget.
 *
 * The same reading is duplicated in the worker's distiller, which has the same
 * problem against a different prompt; the two packages share no code.
 */
function readJsonArray(text: string): unknown[] | null {
  let answer: unknown[] | null = null;
  let index = text.indexOf("[");
  while (index !== -1) {
    const end = balancedEnd(text, index);
    let parsed: unknown;
    try {
      parsed = end === -1 ? undefined : JSON.parse(text.slice(index, end + 1));
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      answer = parsed;
      index = text.indexOf("[", end + 1);
    } else {
      index = text.indexOf("[", index + 1);
    }
  }
  return answer;
}

/**
 * Reads the model's 1-based numbers back to ids, ignoring anything else.
 *
 * Null, not an empty list, when the answer held no array at all: the caller has
 * to be able to tell a model that decided nothing matches from one that never
 * decided, because only the first of those is safe to report to an operator.
 */
export function parseMatches(
  content: string,
  candidates: readonly ForgetCandidate[],
): string[] | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const parsed = readJsonArray((fenced?.[1] ?? content).trim());
  if (parsed === null) return null;
  const matched = new Set<string>();
  for (const entry of parsed) {
    // Objects and strings are accepted too: a small model asked for numbers
    // sometimes answers with {"number": 3} or "3".
    const raw = typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).number ?? (entry as Record<string, unknown>).id
      : entry;
    const index = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isInteger(index)) continue;
    const candidate = candidates[index - 1];
    // An index naming a fact that was never shown does nothing, rather than
    // forgetting whatever happens to sit at that position.
    if (candidate) matched.add(candidate.id);
  }
  return [...matched];
}

export class ForgetMatcher {
  constructor(
    private readonly resolver: DrizzleRuntimeConnectionResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async match(target: string, candidates: readonly ForgetCandidate[]): Promise<ForgetMatch> {
    if (candidates.length === 0) return { matchedIds: [], succeeded: true, truncated: false };

    let connection;
    try {
      connection = await this.resolver.resolveOne("INFERENCE");
    } catch {
      return { matchedIds: [], succeeded: false, truncated: false };
    }
    const configuration = connection.configuration as Record<string, unknown>;
    const model = typeof configuration.modelAlias === "string" ? configuration.modelAlias : "";
    if (!model) return { matchedIds: [], succeeded: false, truncated: false };

    const shown: ForgetCandidate[] = [];
    let characters = 0;
    for (const candidate of candidates) {
      const line = `${shown.length + 1}. ${candidate.content}`;
      if (characters + line.length > MAXIMUM_CANDIDATE_CHARACTERS) break;
      characters += line.length;
      shown.push(candidate);
    }
    const truncated = shown.length < candidates.length;

    const prompt = `TOPIC: ${target}\n\nFACTS:\n${
      shown.map((candidate, index) => `${index + 1}. ${candidate.content}`).join("\n")
    }`;

    const answer = await streamChatCompletion({
      connection,
      model,
      system: MATCHING_INSTRUCTION,
      user: prompt,
      maximumTokens: MAXIMUM_RESPONSE_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...(this.fetcher === fetch ? {} : { fetcher: this.fetcher }),
    });
    // An empty answer is a failure, not "nothing matched": a reasoning model
    // that spent its budget thinking returns exactly that, and treating it as a
    // decision would report a clean dry run over facts nobody read.
    if (!answer.succeeded || answer.content.trim().length === 0) {
      return { matchedIds: [], succeeded: false, truncated };
    }
    // And an answer with no array in it is the same failure wearing prose: the
    // model was asked for numbers and produced something nobody can act on, so
    // it becomes a 503 the operator can retry rather than a clean dry run.
    const matchedIds = parseMatches(answer.content, shown);
    if (matchedIds === null) return { matchedIds: [], succeeded: false, truncated };
    return { matchedIds, succeeded: true, truncated };
  }
}
