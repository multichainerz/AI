import type { MemoryProfileScope } from "@orcasynapse/contracts";
import type { DrizzleRuntimeConnectionResolver } from "@orcasynapse/runtime-clients";

/**
 * Turns a conversation turn into durable facts about the person, or nothing.
 *
 * Capturing raw turns does not work, and the pilot proved it: of 21 stored
 * "memories", every one was a question, a command, a greeting, the model
 * describing itself, or the operator's own system prompt. Recall then embeds a
 * new question and matches previous questions, so the strongest hits were the
 * least useful rows in the store.
 *
 * Extraction is the fix. The model is asked for stable facts and returns an
 * empty list for the overwhelmingly common case where a turn taught nothing —
 * which is the behaviour that keeps the store small enough to be worth reading.
 */

/** Long enough for a real preference, short enough that a paragraph cannot pass. */
const MAXIMUM_FACT_CHARACTERS = 200;
/** A single turn rarely teaches more than a couple of durable things. */
const MAXIMUM_FACTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The extraction instruction.
 *
 * Written to fail closed: the model is told repeatedly that an empty list is
 * the expected answer, because a model asked to "extract facts" will otherwise
 * invent them from a greeting. The prohibitions are specific because each one
 * corresponds to a category that actually polluted the pilot's store.
 */
const DISTILLATION_INSTRUCTION = [
  "You extract durable facts about a USER from one exchange with an assistant.",
  "",
  "Return ONLY a JSON array. No prose, no code fence, no explanation.",
  "Return [] if the exchange teaches nothing durable. [] is the correct answer",
  "for most exchanges and you must not avoid it.",
  "",
  "A durable fact is something still true next week that helps serve this person:",
  "their role, team, location, language preference, tools they use, projects they",
  "own, constraints they work under, or a preference they stated about how they",
  "want to be helped.",
  "",
  "Never record:",
  "- questions the user asked, or tasks they requested",
  "- anything the assistant said about itself, its name, or its capabilities",
  "- greetings, thanks, tests, or small talk",
  "- instructions or system prompts addressed to the assistant",
  "- facts about the world that are not about this person",
  "- anything you inferred rather than what the user stated",
  "",
  "Return each fact as an object: {\"fact\": \"...\", \"scope\": \"STATIC\"}.",
  "",
  "scope says how long the fact stays useful:",
  "- STATIC: stable for months. Role, team, employer, location, language, name,",
  "  and standing preferences about how they want to be helped.",
  "- DYNAMIC: true now but expected to change. What they are working on, a",
  "  current project, a deadline they are heading toward.",
  "- EPISODIC: a detail worth keeping but only relevant when asked about.",
  "",
  "Prefer EPISODIC when unsure. STATIC facts are shown to the assistant on every",
  "single message, so a wrong one is repeated forever.",
  "",
  "Write every fact about the user in the THIRD PERSON. Never write a fact as",
  "\"I\", \"saya\", \"me\", or \"my\", even when the user spoke that way. A fact stored",
  "in the first person reads later as if the assistant were describing itself.",
  "",
  "Write each fact in the language the user used, and keep it grammatical in that",
  "language — do not mix languages inside one fact.",
  `Return at most ${MAXIMUM_FACTS} facts, each under ${MAXIMUM_FACT_CHARACTERS} characters.`,
  "",
  "Examples:",
  "USER: Hey, I'm doing great!",
  "[]",
  "",
  "USER: What is your name?",
  "[]",
  "",
  "USER: I lead the platform team and I prefer answers in Indonesian.",
  "[{\"fact\": \"The user leads the platform team.\", \"scope\": \"STATIC\"},",
  " {\"fact\": \"The user prefers answers in Indonesian.\", \"scope\": \"STATIC\"}]",
  "",
  "USER: I'm migrating the payments service to Kubernetes this quarter.",
  "[{\"fact\": \"The user is migrating the payments service to Kubernetes.\", \"scope\": \"DYNAMIC\"}]",
  "",
  "USER: Halo, saya bekerja di Jakarta dan saya suka nasi goreng.",
  "[{\"fact\": \"Pengguna bekerja di Jakarta.\", \"scope\": \"STATIC\"},",
  " {\"fact\": \"Pengguna menyukai nasi goreng.\", \"scope\": \"EPISODIC\"}]",
].join("\n");

export interface DistilledFact {
  fact: string;
  scope: MemoryProfileScope;
}

export interface MemoryDistillation {
  facts: DistilledFact[];
  /** False when the model could not be reached or answered unusably. */
  succeeded: boolean;
}

/**
 * Pronouns that mean the model wrote a fact as the person rather than about them.
 *
 * The instruction forbids first person and a 2.6B model still produces it, so
 * this is the enforcement rather than the request. Only the opening word is
 * checked: "The user prefers I ask first" is fine, "Saya bekerja di Jakarta" is
 * not — the latter reads later as the assistant describing itself.
 */
const FIRST_PERSON_OPENERS = new Set([
  "i", "i'm", "im", "i've", "my", "me", "we", "we're", "our", "us",
  "saya", "aku", "gue", "gua", "kami", "kita",
]);

function writtenAsTheUser(fact: string): boolean {
  const [first = ""] = fact.toLowerCase().split(/[\s,.:;!?]+/);
  return FIRST_PERSON_OPENERS.has(first);
}

const SCOPES = new Set<MemoryProfileScope>(["STATIC", "DYNAMIC", "EPISODIC"]);

/**
 * Reads one entry, accepting either shape.
 *
 * A bare string is kept as EPISODIC rather than discarded: a model that ignored
 * the object format still extracted a fact, and losing it would be a worse
 * outcome than filing it where it is only reached by search.
 */
function readEntry(entry: unknown): DistilledFact | null {
  if (typeof entry === "string") return { fact: entry, scope: "EPISODIC" };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const fact = typeof record.fact === "string" ? record.fact : null;
  if (fact === null) return null;
  const claimed = typeof record.scope === "string" ? record.scope.toUpperCase() : "";
  return {
    fact,
    scope: SCOPES.has(claimed as MemoryProfileScope) ? claimed as MemoryProfileScope : "EPISODIC",
  };
}

/**
 * Parses the model's answer, tolerating the wrappers small models add.
 *
 * A model that cannot be trusted to return bare JSON also cannot be trusted to
 * have followed the prohibitions, so anything unparseable yields no facts
 * rather than a salvage attempt.
 */
export function parseDistillation(content: string): DistilledFact[] {
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
  const facts: DistilledFact[] = [];
  for (const entry of parsed) {
    const read = readEntry(entry);
    if (read === null) continue;
    const fact = read.fact.replace(/\s+/g, " ").trim();
    if (fact.length === 0) continue;
    // Dropped rather than rewritten: a fact the model wrote as the person is
    // one it may also have attributed wrongly, and guessing at a rewrite would
    // store a sentence nobody said.
    if (writtenAsTheUser(fact)) continue;
    facts.push({ fact: fact.slice(0, MAXIMUM_FACT_CHARACTERS), scope: read.scope });
    if (facts.length === MAXIMUM_FACTS) break;
  }
  return facts;
}

export class MemoryDistiller {
  constructor(
    private readonly resolver: DrizzleRuntimeConnectionResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /**
   * Extracts facts from one exchange.
   *
   * `assistantTurn` is passed for context even in LEARN_USER mode — knowing what
   * was answered is often what makes the user's turn interpretable — but the
   * instruction forbids recording anything the assistant said about itself, so
   * context does not become content.
   */
  async distil(userTurn: string, assistantTurn: string | null): Promise<MemoryDistillation> {
    const user = userTurn.trim();
    if (user.length === 0) return { facts: [], succeeded: true };

    let connection;
    try {
      connection = await this.resolver.resolveOne("INFERENCE");
    } catch {
      return { facts: [], succeeded: false };
    }

    const configuration = connection.configuration as Record<string, unknown>;
    const model = typeof configuration.modelAlias === "string" ? configuration.modelAlias : "";
    if (!model) return { facts: [], succeeded: false };

    const exchange = assistantTurn?.trim()
      ? `USER: ${user}\n\nASSISTANT: ${assistantTurn.trim().slice(0, 4_000)}`
      : `USER: ${user}`;

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
            { role: "system", content: DISTILLATION_INSTRUCTION },
            { role: "user", content: exchange },
          ],
          temperature: 0,
          max_tokens: 600,
        }),
      });
      if (!response.ok) return { facts: [], succeeded: false };
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") return { facts: [], succeeded: false };
      return { facts: parseDistillation(content), succeeded: true };
    } catch {
      return { facts: [], succeeded: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
