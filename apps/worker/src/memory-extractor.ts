import { and, eq, isNotNull, sql } from "drizzle-orm";
import { modelDeployment, type OrcaSynapseDatabase } from "@orcasynapse/database";
import type { DrizzleRuntimeConnectionResolver } from "@orcasynapse/runtime-clients";

export interface MemoryExchange {
  question: string;
  answer: string;
}

export interface MemoryExtractor {
  /** Durable notes worth keeping from one exchange, or none. */
  extract(exchange: MemoryExchange): Promise<string[]>;
}

/** Matches `ScopedMemoryEntry.content`, which the curated write path also caps. */
const NOTE_CHARACTER_LIMIT = 4_000;
const NOTES_PER_EXCHANGE = 5;
const EXCHANGE_CHARACTER_LIMIT = 12_000;
const EXTRACTION_TIMEOUT_MS = 30_000;
const EXTRACTION_MAX_TOKENS = 600;

/*
 * What the extraction model is asked for.
 *
 * "Nothing" has to be an easy answer, and is stated first. Most exchanges are
 * not worth remembering -- a question answered from general knowledge leaves no
 * durable fact behind -- and a model nudged toward producing something will
 * produce something, filling a division's memory with restated transcript that
 * every later run then pays context for.
 */
const EXTRACTION_INSTRUCTION = [
  "You extract durable facts from one exchange between a colleague and an assistant.",
  "",
  "Reply with a JSON array of strings and nothing else. An empty array is the right answer most of the time, and is always better than a weak note.",
  "",
  "Keep a note only if it is:",
  "- durable: still true and still useful in six months, not a detail of this conversation",
  "- about the organisation: how this team works, what it decided and why, names, conventions, standing constraints",
  "- self-contained: readable by somebody who was not in this conversation and has no access to it",
  "",
  "Never keep:",
  "- the question, the answer, or a summary of the exchange",
  "- anything the assistant inferred, guessed at, or hedged",
  "- secrets, credentials, access details, or personal data about an identifiable person",
  "- anything a colleague would be uncomfortable finding written down",
  "",
  "Write each note as a plain statement of fact. No preamble, no attribution, no dates unless the date is the fact.",
].join("\n");

function notesFrom(content: string): string[] {
  // Models bracket JSON with prose often enough that finding the array is
  // routine rather than defensive. Anything still unparseable yields no notes,
  // which is the same outcome as a well-formed empty array.
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((note): note is string => typeof note === "string")
    .map((note) => note.trim().slice(0, NOTE_CHARACTER_LIMIT))
    .filter((note) => note.length >= 3)
    .slice(0, NOTES_PER_EXCHANGE);
}

/**
 * Reads one exchange and returns what is worth keeping, using the deployment's
 * own default Agent model through its own inference connection.
 *
 * It never throws. Extraction runs after a run has already been finalised and
 * its answer delivered, so a failure here must cost a note rather than the
 * answer -- and every plausible failure (no model configured, no inference
 * connection, an endpoint that is down, a reply that is not JSON) is one that
 * should leave the run exactly as it was.
 */
export class InferenceMemoryExtractor implements MemoryExtractor {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly resolver: DrizzleRuntimeConnectionResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async extract(exchange: MemoryExchange): Promise<string[]> {
    try {
      const route = await this.defaultAgentRoute();
      if (!route) return [];
      const connection = await this.resolver.resolve(route.connectionId);
      const modelAlias = route.modelAlias;
      const path = typeof connection.configuration.chatPath === "string"
        ? connection.configuration.chatPath
        : "/v1/chat/completions";
      const endpoint = new URL(path, connection.baseUrl.endsWith("/") ? connection.baseUrl : `${connection.baseUrl}/`);
      if (endpoint.origin !== new URL(connection.baseUrl).origin) return [];

      const response = await this.fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelAlias,
          max_tokens: EXTRACTION_MAX_TOKENS,
          temperature: 0,
          messages: [
            { role: "system", content: EXTRACTION_INSTRUCTION },
            {
              role: "user",
              content: [
                `Colleague asked:\n${exchange.question}`.slice(0, EXCHANGE_CHARACTER_LIMIT),
                `Assistant answered:\n${exchange.answer}`.slice(0, EXCHANGE_CHARACTER_LIMIT),
              ].join("\n\n"),
            },
          ],
        }),
      });
      if (!response.ok) return [];
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      return typeof content === "string" ? notesFrom(content) : [];
    } catch {
      return [];
    }
  }

  /**
   * The same route the inference gateway forwards to, resolved the same way:
   * the active default AGENT deployment, and only once the catalogue is being
   * enforced. Before that there is no approved model to call, and guessing one
   * would send a division's exchanges somewhere nobody evaluated.
   */
  private async defaultAgentRoute(): Promise<{ modelAlias: string; connectionId: string } | null> {
    const [enforced] = await this.database
      .select({ total: sql<number>`count(*)::int` })
      .from(modelDeployment)
      .where(and(eq(modelDeployment.workload, "AGENT"), isNotNull(modelDeployment.firstActivatedAt)));
    if ((enforced?.total ?? 0) === 0) return null;
    const routes = await this.database
      .select({ modelAlias: modelDeployment.modelAlias, connectionId: modelDeployment.connectionId })
      .from(modelDeployment)
      .where(and(
        eq(modelDeployment.workload, "AGENT"),
        eq(modelDeployment.status, "ACTIVE"),
        eq(modelDeployment.isDefault, true),
      ))
      .limit(2);
    const route = routes.length === 1 ? routes[0] : undefined;
    return route ? { modelAlias: route.modelAlias, connectionId: route.connectionId } : null;
  }
}
