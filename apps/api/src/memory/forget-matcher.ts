import type { DrizzleRuntimeConnectionResolver } from "@orcasynapse/runtime-clients";

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

const REQUEST_TIMEOUT_MS = 120_000;
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

/** Reads the model's 1-based numbers back to ids, ignoring anything else. */
export function parseMatches(content: string, candidates: readonly ForgetCandidate[]): string[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? content).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${connection.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: MATCHING_INSTRUCTION },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: MAXIMUM_RESPONSE_TOKENS,
        }),
      });
      if (!response.ok) return { matchedIds: [], succeeded: false, truncated };
      const body = await response.json() as {
        choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
      };
      const answer = body.choices?.[0]?.message?.content;
      // An empty answer is a failure, not "nothing matched": a reasoning model
      // that spent its budget thinking returns exactly that, and treating it as
      // a decision would report a clean dry run over facts nobody read.
      if (typeof answer !== "string" || answer.trim().length === 0) {
        return { matchedIds: [], succeeded: false, truncated };
      }
      return { matchedIds: parseMatches(answer, shown), succeeded: true, truncated };
    } catch {
      return { matchedIds: [], succeeded: false, truncated };
    } finally {
      clearTimeout(timer);
    }
  }
}
