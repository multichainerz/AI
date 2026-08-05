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
  "Return ONLY a JSON array of strings. No prose, no code fence, no explanation.",
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
  "Write each fact as a standalone sentence about the user, in the third person.",
  `Return at most ${MAXIMUM_FACTS} facts, each under ${MAXIMUM_FACT_CHARACTERS} characters.`,
].join("\n");

export interface MemoryDistillation {
  facts: string[];
  /** False when the model could not be reached or answered unusably. */
  succeeded: boolean;
}

/**
 * Parses the model's answer, tolerating the wrappers small models add.
 *
 * A model that cannot be trusted to return bare JSON also cannot be trusted to
 * have followed the prohibitions, so anything unparseable yields no facts
 * rather than a salvage attempt.
 */
export function parseDistillation(content: string): string[] {
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
  const facts: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const fact = entry.replace(/\s+/g, " ").trim();
    if (fact.length === 0) continue;
    facts.push(fact.slice(0, MAXIMUM_FACT_CHARACTERS));
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
