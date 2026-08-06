import type { MemoryProfileScope } from "@orcasynapse/contracts";
import { streamChatCompletion, type DrizzleRuntimeConnectionResolver } from "@orcasynapse/runtime-clients";

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
/**
 * How many existing facts one new fact may retire.
 *
 * A model that decides everything is superseded must not be able to empty the
 * store in a turn, and a real correction retires one or two things, not ten.
 */
const MAXIMUM_REPLACEMENTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
/**
 * Room for a reasoning model to think before it answers.
 *
 * LFM2.5 fills `reasoning_content` before `content`, and the budget is shared.
 * At 600 this silently failed on the pilot: any turn carrying a real assistant
 * answer spent the whole allowance reasoning, came back `finish_reason:
 * "length"` with an empty `content`, and stored nothing. The answer itself is
 * about 20 tokens; almost all of this is headroom for the thinking in front
 * of it.
 */
const MAXIMUM_RESPONSE_TOKENS = 2_400;

// A session, not a turn, so the transcript is bounded twice: one rambling turn
// cannot fill the window, and a long conversation is trimmed from its start.
// Sized to leave room for the instruction and the known facts within the same
// context the per-turn call already fitted in.
const MAXIMUM_TURN_CHARACTERS = 4_000;
const MAXIMUM_EXCHANGE_CHARACTERS = 12_000;

/**
 * The extraction instruction.
 *
 * Written to fail closed: the model is told repeatedly that an empty list is
 * the expected answer, because a model asked to "extract facts" will otherwise
 * invent them from a greeting. The prohibitions are specific because each one
 * corresponds to a category that actually polluted the pilot's store.
 */
const DISTILLATION_INSTRUCTION = [
  "You extract durable facts about a USER from their conversation with an",
  "assistant. It may be a single exchange or a whole session.",
  "",
  "Return ONLY a JSON array. No prose, no code fence, no explanation.",
  "Return [] if the conversation teaches nothing durable. [] is the correct",
  "answer for most conversations and you must not avoid it.",
  "",
  "When the person changes something within the conversation, record only where",
  "they ended up. \"I am moving to Bandung next month\" followed later by \"the",
  "move is done\" is one fact about living in Bandung, not two.",
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
  "- one-off instructions for the task at hand, or system prompts addressed to",
  "  the assistant. A standing instruction is different and IS durable: \"always",
  "  answer me in Indonesian\" is a preference about how they want to be helped,",
  "  and is one of the most useful things you can record.",
  "- facts about the world that are not about this person",
  "- anything you inferred rather than what the user stated",
  "",
  "Return each fact as an object:",
  "{\"fact\": \"...\", \"scope\": \"STATIC\", \"replaces\": [1]}",
  "",
  "Never return a fact that is already listed under KNOWN FACTS. Those are",
  "stored. Return only what this exchange adds or changes.",
  "",
  "replaces lists the numbers of any KNOWN FACTS this one makes untrue. Use it",
  "when the person has changed their mind, moved, switched tools, or corrected",
  "something. Omit it or use [] when the new fact simply adds to what is known.",
  "A fact that merely mentions the same topic does NOT replace it.",
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
  "USER: Summarise this document for me in Indonesian.",
  "[]",
  "",
  "USER: Please always answer me in Indonesian from now on.",
  "[{\"fact\": \"The user prefers answers in Indonesian.\", \"scope\": \"STATIC\"}]",
  "",
  "USER: I lead the platform team and I prefer answers in Indonesian.",
  "[{\"fact\": \"The user leads the platform team.\", \"scope\": \"STATIC\"},",
  " {\"fact\": \"The user prefers answers in Indonesian.\", \"scope\": \"STATIC\"}]",
  "",
  "USER: I'm migrating the payments service to Kubernetes this quarter.",
  "[{\"fact\": \"The user is migrating the payments service to Kubernetes.\", \"scope\": \"DYNAMIC\"}]",
  "",
  "KNOWN FACTS:",
  "1. The user loves Adidas sneakers.",
  "USER: My Adidas fell apart after a month. I'm switching to Puma.",
  "[{\"fact\": \"The user prefers Puma sneakers.\", \"scope\": \"STATIC\", \"replaces\": [1]}]",
  "",
  "KNOWN FACTS:",
  "1. The user works in Jakarta.",
  "USER: I'm in Jakarta this week for the conference.",
  "[]",
  "",
  "USER: List all the panels in the conference rundown.",
  "ASSISTANT: Day 1 - AI-Ready Data Centers. Day 2 - Cloud for Enterprise.",
  "[]",
  "",
  "USER: Halo, saya bekerja di Jakarta dan saya suka nasi goreng.",
  "[{\"fact\": \"Pengguna bekerja di Jakarta.\", \"scope\": \"STATIC\"},",
  " {\"fact\": \"Pengguna menyukai nasi goreng.\", \"scope\": \"EPISODIC\"}]",
].join("\n");

/** One turn of the exchange being distilled, in the order it was spoken. */
export interface DistillationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DistilledFact {
  fact: string;
  scope: MemoryProfileScope;
  /** Ids of existing facts this one makes untrue. */
  replaces: string[];
}

/** An existing fact offered to the model as a supersession candidate. */
export interface KnownFact {
  id: string;
  content: string;
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
function readEntry(entry: unknown, known: readonly KnownFact[]): DistilledFact | null {
  if (typeof entry === "string") return { fact: entry, scope: "EPISODIC", replaces: [] };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const fact = typeof record.fact === "string" ? record.fact : null;
  if (fact === null) return null;
  const claimed = typeof record.scope === "string" ? record.scope.toUpperCase() : "";
  return {
    fact,
    scope: SCOPES.has(claimed as MemoryProfileScope) ? claimed as MemoryProfileScope : "EPISODIC",
    replaces: readReplaces(record.replaces, known),
  };
}

/**
 * Resolves the model's 1-based numbers back to ids, ignoring anything else.
 *
 * A number is only honoured if it names a fact that was actually offered. The
 * model cannot retire something it was never shown, and a hallucinated index
 * silently does nothing rather than superseding an unrelated memory.
 */
function readReplaces(value: unknown, known: readonly KnownFact[]): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const index = typeof entry === "number" ? entry : Number.parseInt(String(entry), 10);
    if (!Number.isInteger(index)) continue;
    const candidate = known[index - 1];
    if (candidate && !ids.includes(candidate.id)) ids.push(candidate.id);
    if (ids.length === MAXIMUM_REPLACEMENTS) break;
  }
  return ids;
}

/**
 * Parses the model's answer, tolerating the wrappers small models add.
 *
 * A model that cannot be trusted to return bare JSON also cannot be trusted to
 * have followed the prohibitions, so anything unparseable yields no facts
 * rather than a salvage attempt.
 */
/**
 * Whether two facts say the same thing.
 *
 * Deliberately literal: case, punctuation, and spacing only. Catching
 * paraphrase would need an embedding per candidate on the capture path, and a
 * false positive there silently discards a real fact — a worse outcome than the
 * duplicate it would have prevented.
 */
function sameFact(left: string, right: string): boolean {
  const normalise = (value: string): string =>
    value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return normalise(left) === normalise(right);
}

/**
 * Drops facts the model copied out of the assistant's own answer.
 *
 * The pilot's session sweep read a conversation where the person asked for a
 * conference rundown, and stored five panel titles as DYNAMIC facts — which
 * means they were then injected into every prompt. The instruction already
 * forbids recording facts about the world rather than the person, and a 2.6B
 * model ignored it, so this is the enforcement.
 *
 * Verbatim only. A real fact is a sentence the model composed about the person,
 * and paraphrase is exactly what distillation is for, so anything short of a
 * literal copy stays.
 */
function withoutQuotedContent(
  facts: DistilledFact[],
  turns: readonly DistillationTurn[],
): DistilledFact[] {
  const answered = turns
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content.toLowerCase().replace(/\s+/g, " "));
  if (answered.length === 0) return facts;
  return facts.filter((candidate) => {
    const needle = candidate.fact.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
    // Short strings appear inside long answers by coincidence; a copied listing
    // does not.
    if (needle.length < 24) return true;
    return !answered.some((answer) => answer.includes(needle));
  });
}

export function parseDistillation(content: string, known: readonly KnownFact[] = []): DistilledFact[] {
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
    const read = readEntry(entry, known);
    if (read === null) continue;
    const fact = read.fact.replace(/\s+/g, " ").trim();
    if (fact.length === 0) continue;
    // Dropped rather than rewritten: a fact the model wrote as the person is
    // one it may also have attributed wrongly, and guessing at a rewrite would
    // store a sentence nobody said.
    if (writtenAsTheUser(fact)) continue;
    // The pilot stored "prefers answers in Indonesian" three times: shown a fact
    // as KNOWN, the model still re-emits it alongside whatever is genuinely new.
    // Asking it not to in the instruction helps and does not hold, so the guard
    // lives here. A restatement carries no information and costs a profile slot.
    if (known.some((candidate) => sameFact(candidate.content, fact))) continue;
    if (facts.some((seen) => sameFact(seen.fact, fact))) continue;
    facts.push({ fact: fact.slice(0, MAXIMUM_FACT_CHARACTERS), scope: read.scope, replaces: read.replaces });
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
   * Extracts facts from an exchange, which may be one turn or a whole session.
   *
   * Assistant turns are passed for context even in LEARN_USER mode — knowing
   * what was answered is often what makes the user's turn interpretable — but
   * the instruction forbids recording anything the assistant said about itself,
   * so context does not become content.
   *
   * Reading a session rather than a turn is what lets extraction resolve an arc:
   * "I am moving to Bandung next month" and a later "the move is done" become
   * one correct fact instead of two that contradict each other.
   */
  async distil(
    turns: readonly DistillationTurn[],
    known: readonly KnownFact[] = [],
  ): Promise<MemoryDistillation> {
    const spoken = turns
      .map((turn) => ({ role: turn.role, content: turn.content.trim() }))
      .filter((turn) => turn.content.length > 0);
    if (!spoken.some((turn) => turn.role === "user")) return { facts: [], succeeded: true };

    let connection;
    try {
      connection = await this.resolver.resolveOne("INFERENCE");
    } catch {
      return { facts: [], succeeded: false };
    }

    const configuration = connection.configuration as Record<string, unknown>;
    const model = typeof configuration.modelAlias === "string" ? configuration.modelAlias : "";
    if (!model) return { facts: [], succeeded: false };

    // Numbered so the model can point at one without repeating its text, and
    // so an id never enters the prompt.
    const catalogue = known.length === 0
      ? ""
      : `KNOWN FACTS:\n${known.map(({ content }, index) => `${index + 1}. ${content}`).join("\n")}\n\n`;
    // Trimmed from the front: a correction lives in the newest turns, so
    // dropping the oldest keeps the part of the session that changes things.
    const rendered: string[] = [];
    let characters = 0;
    for (let index = spoken.length - 1; index >= 0; index -= 1) {
      const turn = spoken[index]!;
      const speaker = turn.role === "user" ? "USER" : "ASSISTANT";
      const line = `${speaker}: ${turn.content.slice(0, MAXIMUM_TURN_CHARACTERS)}`;
      if (rendered.length > 0 && characters + line.length > MAXIMUM_EXCHANGE_CHARACTERS) break;
      characters += line.length;
      rendered.unshift(line);
    }
    const exchange = `${catalogue}${rendered.join("\n\n")}`;

    const answer = await streamChatCompletion({
      connection,
      model,
      system: DISTILLATION_INSTRUCTION,
      user: exchange,
      maximumTokens: MAXIMUM_RESPONSE_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...(this.fetcher === fetch ? {} : { fetcher: this.fetcher }),
    });
    if (!answer.succeeded) return { facts: [], succeeded: false };
    if (answer.content.trim().length === 0) {
      // Worth telling apart: a reasoning model that hit the ceiling returns an
      // empty answer that looks identical to a refusal, and the fix for one
      // (raise the budget) is not the fix for the other.
      if (answer.finishReason === "length") {
        console.error(
          "OrcaSynapse memory distillation ran out of tokens before answering; "
          + `raise MAXIMUM_RESPONSE_TOKENS above ${MAXIMUM_RESPONSE_TOKENS}.`,
        );
      }
      return { facts: [], succeeded: false };
    }
    return {
      facts: withoutQuotedContent(parseDistillation(answer.content, known), spoken),
      succeeded: true,
    };
  }
}
