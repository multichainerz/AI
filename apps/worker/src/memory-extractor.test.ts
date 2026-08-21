import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  modelDeployment,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { DrizzleRuntimeConnectionResolver } from "@orcasynapse/runtime-clients";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InferenceMemoryExtractor } from "./memory-extractor.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const EXCHANGE = { question: "When do we close the books?", answer: "On the fifth working day." };

function resolver() {
  return new DrizzleRuntimeConnectionResolver(
    context.database,
    new EnvelopeEncryption({ masterKey: Buffer.alloc(32, 9) }),
  );
}

/** Records every call, so "was the endpoint reached at all" is assertable. */
function recordingFetcher(reply: () => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function seedInferenceRoute(options: { approved: boolean }): Promise<void> {
  const [connection] = await context.database.insert(serviceConnection).values({
    slug: `inference-${randomUUID().slice(0, 8)}`,
    displayName: "Inference",
    kind: "INFERENCE",
    environment: "PRODUCTION",
    baseUrl: "https://inference.internal",
    enabled: true,
    status: "HEALTHY",
  }).returning({ id: serviceConnection.id });
  await context.database.insert(modelDeployment).values({
    connectionId: connection!.id,
    slug: `agent-${randomUUID().slice(0, 8)}`,
    displayName: "Agent model",
    workload: "AGENT",
    modelAlias: "orca-agent-70b",
    version: "2026.1",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    maxConcurrentRequests: 4,
    /*
     * The unapproved case is a DRAFT, not an ACTIVE row with no activation
     * date -- the schema refuses that combination outright
     * (`ModelDeployment_activation_check`), and `isDefault` requires ACTIVE
     * besides. So a catalogue nobody has evaluated looks exactly like this:
     * a draft route, defaulting to nothing.
     */
    status: options.approved ? "ACTIVE" : "DRAFT",
    isDefault: options.approved,
    firstActivatedAt: options.approved ? new Date() : null,
  });
}

/*
 * The extractor's own HTTP path, which the processor's tests stub out.
 *
 * Worth its own file because the stub proves the processor uses whatever it is
 * given, and nothing about what this actually sends or accepts. That gap is the
 * same one that let `RunCapabilityIssuer` exist for four releases while nothing
 * constructed it: a class can be entirely correct and entirely unreached, and
 * only a test that exercises it can tell.
 */
describe("InferenceMemoryExtractor", () => {
  /*
   * The safety property, and the reason this is checked by call count rather
   * than by return value.
   *
   * Returning no notes would also be "correct" if the request had been sent and
   * the answer discarded -- and that version would have posted a division's
   * conversation to an endpoint nobody approved. What matters is that nothing
   * leaves the process, so the assertion is on the fetcher, not the result.
   */
  it("sends nothing at all when no model route has been approved", async () => {
    await seedInferenceRoute({ approved: false });
    const { calls, fetcher } = recordingFetcher(() => completion("[]"));

    const notes = await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE);

    expect(calls).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  it("keeps the notes the model returned", async () => {
    await seedInferenceRoute({ approved: true });
    const { calls, fetcher } = recordingFetcher(() =>
      completion('Here is what I found:\n["Books close on the fifth working day."]\nThat is all.'));

    const notes = await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE);

    expect(notes).toEqual(["Books close on the fifth working day."]);
    // The approved alias, not the run's -- the run's is a Hermes alias and means
    // nothing to the inference endpoint.
    expect((calls[0]?.body as { model: string }).model).toBe("orca-agent-70b");
  });

  it("does not post to a healthy inference connection the default agent route does not name", async () => {
    await seedInferenceRoute({ approved: true });
    const [named] = await context.database
      .select({ id: serviceConnection.id })
      .from(serviceConnection)
      .limit(1);
    await context.database
      .update(serviceConnection)
      .set({ enabled: false })
      .where(eq(serviceConnection.id, named!.id));
    await context.database.insert(serviceConnection).values({
      slug: `other-${randomUUID().slice(0, 8)}`,
      displayName: "Other inference",
      kind: "INFERENCE",
      environment: "PRODUCTION",
      baseUrl: "https://other.internal",
      enabled: true,
      status: "HEALTHY",
    });
    const { calls, fetcher } = recordingFetcher(() => completion("[]"));

    const notes = await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE);

    expect(calls).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  it("keeps nothing when the model says there is nothing", async () => {
    await seedInferenceRoute({ approved: true });
    const { fetcher } = recordingFetcher(() => completion("[]"));

    expect(await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE)).toEqual([]);
  });

  /*
   * Everything below is a way the endpoint disappoints us, and every one of them
   * has to be a quiet empty result. This runs after a run is finalised: there is
   * no longer anything for a throw to fail, only an answer already delivered.
   */
  it("returns nothing rather than throwing when the endpoint refuses", async () => {
    await seedInferenceRoute({ approved: true });
    const { fetcher } = recordingFetcher(() => new Response("upstream is down", { status: 503 }));

    expect(await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE)).toEqual([]);
  });

  it("returns nothing rather than throwing when the reply is not a JSON array", async () => {
    await seedInferenceRoute({ approved: true });
    const { fetcher } = recordingFetcher(() => completion("I could not find anything worth keeping."));

    expect(await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE)).toEqual([]);
  });

  it("returns nothing rather than throwing when there is no inference connection", async () => {
    const { fetcher } = recordingFetcher(() => completion("[]"));
    // A model route with no connection behind it: resolveOne throws, and that
    // must reach the caller as "no notes" rather than as an exception.
    await context.database.insert(modelDeployment).values({
      connectionId: randomUUID(), slug: `agent-${randomUUID().slice(0, 8)}`,
      displayName: "Agent model", workload: "AGENT", modelAlias: "orca-agent-70b",
      version: "2026.1", contextWindowTokens: 128_000, maxOutputTokens: 4_096,
      maxConcurrentRequests: 4, status: "ACTIVE", isDefault: true, firstActivatedAt: new Date(),
    }).catch(() => undefined);

    expect(await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE)).toEqual([]);
  });

  it("drops entries that are not strings and caps how many it keeps", async () => {
    await seedInferenceRoute({ approved: true });
    const many = JSON.stringify([...Array(9).keys()].map((index) => `Durable fact number ${index}.`));
    const { fetcher } = recordingFetcher(() => completion(`[null, 42, ${many.slice(1)}`));

    const notes = await new InferenceMemoryExtractor(context.database, resolver(), fetcher)
      .extract(EXCHANGE);

    expect(notes).toHaveLength(5);
    expect(notes.every((note) => typeof note === "string")).toBe(true);
  });
});
