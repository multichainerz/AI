import { describe, expect, it, vi } from "vitest";
import { MemoryDistiller, parseDistillation } from "./memory-distiller.js";

/**
 * These cases come from the pilot's actual store, where capturing raw turns
 * produced 21 rows of questions, greetings and the model describing itself.
 * The parser is the part that fails quietly — a small model wraps JSON in
 * prose, and a lenient parser would turn that prose into a "memory".
 */

/** Most cases care about which facts survived, not how they were classified. */
const factsOf = (content: string) => parseDistillation(content).map(({ fact }) => fact);

function resolver(configuration: Record<string, unknown> = { modelAlias: "hermes-agent" }) {
  return {
    resolveOne: vi.fn(async () => ({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "INFERENCE",
      baseUrl: "https://inference.internal",
      configuration,
      secrets: { apiKey: "k".repeat(40) },
    })),
  } as never;
}

/** The old two-argument shape, as a transcript. */
function exchange(user: string, assistant?: string | null) {
  return [
    { role: "user" as const, content: user },
    ...(assistant ? [{ role: "assistant" as const, content: assistant }] : []),
  ];
}

/**
 * The callers stream now, so the stub speaks SSE.
 *
 * One content frame plus a terminator, which is the shape vLLM produces for a
 * short answer. Frame reassembly itself is covered in the runtime-clients
 * package; these cases care about what the distiller does with the result.
 */
function answering(content: string, finishReason = "stop") {
  const frame = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
  const body = frame({ choices: [{ index: 0, delta: { content } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
    + "data: [DONE]\n\n";
  return vi.fn(async () => new Response(body, { status: 200 }));
}

describe("parseDistillation", () => {
  it("reads the classified object form", () => {
    expect(parseDistillation('[{"fact": "The user leads the platform team.", "scope": "STATIC"}]'))
      .toEqual([{ fact: "The user leads the platform team.", scope: "STATIC", replaces: [] }]);
  });

  it("keeps a bare string as EPISODIC rather than discarding it", () => {
    // A model that ignored the object format still extracted a fact. Filing it
    // where only search reaches it beats losing it.
    expect(parseDistillation('["The user works in Jakarta."]'))
      .toEqual([{ fact: "The user works in Jakarta.", scope: "EPISODIC", replaces: [] }]);
  });

  it("falls back to EPISODIC for a scope it does not recognise", () => {
    // A wrong STATIC is shown on every message forever, so an unknown value
    // must land in the least privileged scope, not the most.
    expect(parseDistillation('[{"fact": "The user works in Jakarta.", "scope": "PERMANENT"}]'))
      .toEqual([{ fact: "The user works in Jakarta.", scope: "EPISODIC", replaces: [] }]);
    expect(parseDistillation('[{"fact": "The user works in Jakarta."}]'))
      .toEqual([{ fact: "The user works in Jakarta.", scope: "EPISODIC", replaces: [] }]);
  });

  it("accepts a lowercase scope, since models are inconsistent about case", () => {
    expect(parseDistillation('[{"fact": "The user prefers Indonesian.", "scope": "static"}]'))
      .toEqual([{ fact: "The user prefers Indonesian.", scope: "STATIC", replaces: [] }]);
  });

  it("reads an array a small model wrapped in a fence and commentary", () => {
    expect(factsOf('Sure! Here are the facts:\n```json\n["The user works in Jakarta."]\n```\nHope that helps.'))
      .toEqual(["The user works in Jakarta."]);
  });

  it("treats an empty array as the answer it is", () => {
    expect(parseDistillation("[]")).toEqual([]);
  });

  it("yields nothing when the model answered in prose", () => {
    // A model that ignored "JSON only" also ignored the prohibitions, so its
    // prose must not become a memory by way of a salvage attempt.
    expect(parseDistillation("The user asked what my name is, which is not a durable fact.")).toEqual([]);
    expect(parseDistillation("")).toEqual([]);
  });

  it("drops entries that carry no usable fact", () => {
    expect(factsOf('["Valid fact about the user.", 42, null, "   ", {"a":1}, {"fact": 7}]'))
      .toEqual(["Valid fact about the user."]);
  });

  it("bounds the count and the length of what it accepts", () => {
    const many = JSON.stringify(Array.from({ length: 12 }, (_, index) => `Fact number ${index} about the user.`));
    expect(parseDistillation(many)).toHaveLength(5);
    const [long] = parseDistillation(JSON.stringify([`The user ${"x".repeat(400)}`]));
    expect(long?.fact.length).toBe(200);
  });

  it("drops facts the model wrote as the person rather than about them", () => {
    // The pilot stored "Saya bekerja di Jakarta" — first person, which reads
    // later as the assistant describing itself. The instruction forbids it and
    // a 2.6B model produces it anyway, so the parser enforces rather than asks.
    expect(factsOf('["Saya bekerja di Jakarta.", "The user works in Jakarta."]'))
      .toEqual(["The user works in Jakarta."]);
    expect(parseDistillation('["I lead the platform team.", "My timezone is WIB."]')).toEqual([]);
    expect(parseDistillation('["Aku suka nasi goreng.", "Kami pakai Kubernetes."]')).toEqual([]);
    // Rejection applies to the classified form too, not just bare strings.
    expect(parseDistillation('[{"fact": "Saya bekerja di Jakarta.", "scope": "STATIC"}]')).toEqual([]);
  });

  it("keeps a first-person pronoun that is not the opening word", () => {
    // "The user prefers I ask first" is a legitimate third-person fact; only a
    // fact that *begins* as the person is rejected.
    expect(factsOf('["The user prefers that I ask before running commands."]'))
      .toEqual(["The user prefers that I ask before running commands."]);
    expect(factsOf('["Pengguna bekerja di Jakarta."]')).toEqual(["Pengguna bekerja di Jakarta."]);
  });

  it("collapses whitespace so one fact cannot arrive as a paragraph", () => {
    expect(factsOf('["The user   prefers\\n\\n  Indonesian."]')).toEqual(["The user prefers Indonesian."]);
  });
});

describe("supersession", () => {
  const known = [
    { id: "11111111-1111-4111-8111-111111111111", content: "The user loves Adidas sneakers." },
    { id: "22222222-2222-4222-8222-222222222222", content: "The user works in Jakarta." },
  ];

  it("resolves the model's 1-based numbers back to ids", () => {
    // The prompt shows numbers, never ids: an id in the prompt is a token the
    // model can mangle, and a number it cannot misattribute.
    expect(parseDistillation('[{"fact": "The user prefers Puma.", "scope": "STATIC", "replaces": [1]}]', known))
      .toEqual([{ fact: "The user prefers Puma.", scope: "STATIC", replaces: [known[0]!.id] }]);
  });

  it("drops a fact the model was already shown as known", () => {
    // The pilot stored "prefers answers in Indonesian" three times. Shown a
    // fact under KNOWN FACTS, the model still re-emits it beside whatever is
    // genuinely new; a restatement adds nothing and costs a profile slot.
    expect(parseDistillation(
      '[{"fact": "The user works in Jakarta.", "scope": "STATIC"},'
      + ' {"fact": "The user works in Bandung.", "scope": "STATIC", "replaces": [2]}]',
      known,
    )).toEqual([
      { fact: "The user works in Bandung.", scope: "STATIC", replaces: [known[1]!.id] },
    ]);
  });

  it("matches a restatement through case and punctuation", () => {
    expect(parseDistillation('[{"fact": "the user works in jakarta", "scope": "STATIC"}]', known))
      .toEqual([]);
  });

  it("keeps only the first of two identical facts in one answer", () => {
    expect(parseDistillation(
      '[{"fact": "The user uses Kubernetes.", "scope": "STATIC"},'
      + ' {"fact": "The user uses Kubernetes.", "scope": "EPISODIC"}]',
      known,
    )).toEqual([{ fact: "The user uses Kubernetes.", scope: "STATIC", replaces: [] }]);
  });

  it("ignores a number naming a fact it was never shown", () => {
    // A hallucinated index must do nothing rather than retire an unrelated
    // memory that happened to sit at that position in some other list.
    expect(parseDistillation('[{"fact": "X about the user.", "replaces": [9, 0, -1]}]', known)[0]?.replaces)
      .toEqual([]);
  });

  it("caps how many facts one turn may retire", () => {
    const many = [...known, ...Array.from({ length: 6 }, (_, i) => ({
      id: `3333333${i}-3333-4333-8333-333333333333`, content: `Fact ${i} about the user.`,
    }))];
    const replaced = parseDistillation(
      '[{"fact": "The user changed everything.", "replaces": [1,2,3,4,5,6,7,8]}]', many,
    )[0]?.replaces;
    // A model that decides everything is superseded must not empty the store.
    expect(replaced).toHaveLength(3);
  });

  it("de-duplicates a number repeated by the model", () => {
    expect(parseDistillation('[{"fact": "X about the user.", "replaces": [1, 1, 1]}]', known)[0]?.replaces)
      .toEqual([known[0]!.id]);
  });

  it("retires nothing when the field is absent or not a list", () => {
    expect(parseDistillation('[{"fact": "X about the user."}]', known)[0]?.replaces).toEqual([]);
    expect(parseDistillation('[{"fact": "X about the user.", "replaces": "all"}]', known)[0]?.replaces).toEqual([]);
  });

  it("offers the known facts to the model as a numbered list", async () => {
    const fetcher = answering("[]");
    await new MemoryDistiller(resolver(), fetcher as never)
      .distil(exchange("I'm switching to Puma."), known);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const prompt = JSON.parse(String(init.body)).messages[1].content;
    expect(prompt).toContain("1. The user loves Adidas sneakers.");
    expect(prompt).toContain("2. The user works in Jakarta.");
    // Ids never enter the prompt.
    expect(prompt).not.toContain(known[0]!.id);
  });
});

describe("MemoryDistiller", () => {
  it("asks the configured model and returns what it extracted", async () => {
    const fetcher = answering('[{"fact": "The user leads the platform team.", "scope": "STATIC"}]');
    const result = await new MemoryDistiller(resolver(), fetcher as never)
      .distil(exchange("I lead the platform team here.", "Noted."));
    expect(result).toEqual({
      facts: [{ fact: "The user leads the platform team.", scope: "STATIC", replaces: [] }],
      succeeded: true,
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "hermes-agent", temperature: 0 });
    // The exchange is one user message; the instruction is separate, so a turn
    // cannot overwrite the rules by containing text that looks like them.
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("USER: I lead the platform team here.");
  });

  it("renders a whole session as an alternating transcript", async () => {
    // Session-end distillation is the point of taking turns rather than a pair:
    // extraction can only resolve "moving next month" against "the move is
    // done" if it sees both.
    const fetcher = answering("[]");
    await new MemoryDistiller(resolver(), fetcher as never).distil([
      { role: "user", content: "I am moving to Bandung next month." },
      { role: "assistant", content: "Congratulations on the move." },
      { role: "user", content: "The move is done, I am settled in now." },
    ]);
    const prompt = JSON.parse(String(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    )).messages[1].content;
    expect(prompt).toContain("USER: I am moving to Bandung next month.");
    expect(prompt).toContain("ASSISTANT: Congratulations on the move.");
    expect(prompt).toContain("USER: The move is done, I am settled in now.");
    expect(prompt.indexOf("next month")).toBeLessThan(prompt.indexOf("settled in now"));
  });

  it("drops the oldest turns when a session outgrows the window", async () => {
    // Trimmed from the front because a correction lives at the end: keeping the
    // start would preserve exactly the facts the session went on to retire.
    const fetcher = answering("[]");
    // Each turn is capped at 4,000 characters, so it takes several to exceed
    // the 12,000-character exchange window.
    await new MemoryDistiller(resolver(), fetcher as never).distil([
      { role: "user", content: `First. ${"x".repeat(9_000)}` },
      { role: "user", content: `Second. ${"y".repeat(9_000)}` },
      { role: "user", content: `Third. ${"z".repeat(9_000)}` },
      { role: "user", content: `Fourth. ${"w".repeat(9_000)}` },
      { role: "user", content: "Last, and the one that matters." },
    ]);
    const prompt = JSON.parse(String(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    )).messages[1].content;
    expect(prompt).toContain("Last, and the one that matters.");
    expect(prompt).not.toContain("First.");
  });

  it("still sends a single turn that is longer than the whole window", async () => {
    // The trim must never produce an empty exchange: one enormous turn is worth
    // truncating, not discarding.
    const fetcher = answering("[]");
    await new MemoryDistiller(resolver(), fetcher as never)
      .distil([{ role: "user", content: "Important. " + "z".repeat(40_000) }]);
    const prompt = JSON.parse(String(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    )).messages[1].content;
    expect(prompt).toContain("USER: Important.");
  });

  it("succeeds with nothing when a session has no user turn at all", async () => {
    const fetcher = answering('["should not be reached"]');
    await expect(new MemoryDistiller(resolver(), fetcher as never)
      .distil([{ role: "assistant", content: "Anything I said on my own." }]))
      .resolves.toEqual({ facts: [], succeeded: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("tells the model a standing instruction is durable, not a task", async () => {
    // The quality metric caught this: "always answer me in Indonesian" was
    // dropped, because the prohibition on recording instructions swallowed the
    // one preference most worth keeping. The two rules had to be separated.
    const fetcher = answering("[]");
    await new MemoryDistiller(resolver(), fetcher as never).distil(exchange("Anything"));
    const instruction = JSON.parse(String(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    )).messages[0].content;

    expect(instruction).toContain("one-off instructions for the task at hand");
    expect(instruction).toContain("A standing instruction is different and IS durable");
    // And shown both ways round, since the distinction is what a small model
    // gets wrong: the same words are a task once and a preference forever.
    expect(instruction).toContain("USER: Summarise this document for me in Indonesian.");
    expect(instruction).toContain("USER: Please always answer me in Indonesian from now on.");
  });

  it("drops a fact the model copied out of the assistant's own answer", async () => {
    // The pilot's first session sweep read "list the conference rundown" and
    // stored five panel titles as DYNAMIC facts — always injected, about nobody.
    const listing = "Day 1 - AI-Ready Data Centers: Power, Cooling, and Infrastructure. "
      + "Day 2 - Cloud for BUMN: Open Infrastructure for National Scale.";
    const fetcher = answering(JSON.stringify([
      { fact: "AI-Ready Data Centers: Power, Cooling, and Infrastructure", scope: "DYNAMIC" },
      { fact: "The user is preparing to speak at the conference.", scope: "DYNAMIC" },
    ]));

    const result = await new MemoryDistiller(resolver(), fetcher as never).distil([
      { role: "user", content: "List all the panels in the rundown." },
      { role: "assistant", content: listing },
    ]);

    expect(result.facts.map(({ fact }) => fact))
      .toEqual(["The user is preparing to speak at the conference."]);
  });

  it("keeps a fact that only paraphrases the answer", async () => {
    // Paraphrase is what distillation is for, so the guard is verbatim-only.
    const fetcher = answering(JSON.stringify([
      { fact: "The user works on power and cooling for data centres.", scope: "STATIC" },
    ]));

    const result = await new MemoryDistiller(resolver(), fetcher as never).distil([
      { role: "user", content: "I handle the power and cooling side." },
      { role: "assistant", content: "Power and cooling is a demanding part of data centre work." },
    ]);

    expect(result.facts).toHaveLength(1);
  });

  it("reports failure rather than emptiness when the model is unreachable", async () => {
    // The caller stores nothing either way, but only a failure is worth logging
    // — and it must never be mistaken for "this turn taught nothing".
    const fetcher = vi.fn(async () => new Response("upstream down", { status: 502 }));
    await expect(new MemoryDistiller(resolver(), fetcher as never).distil(exchange("Anything")))
      .resolves.toEqual({ facts: [], succeeded: false });
  });

  it("reports failure when a reasoning model spent its budget before answering", async () => {
    // The pilot failure: LFM2.5 fills reasoning_content first, and at a tight
    // max_tokens any real turn came back finish_reason "length" with an empty
    // content. That is indistinguishable from a refusal in the response body,
    // so it must still be a failure — storing nothing rather than guessing.
    const fetcher = answering("", "length");
    await expect(new MemoryDistiller(resolver(), fetcher as never).distil(exchange("I moved to Bandung.")))
      .resolves.toEqual({ facts: [], succeeded: false });
  });

  it("treats a whitespace-only answer as a failure, not as nothing learned", async () => {
    await expect(new MemoryDistiller(resolver(), answering("   ") as never).distil(exchange("Anything")))
      .resolves.toEqual({ facts: [], succeeded: false });
  });

  it("asks for enough room that reasoning does not crowd out the answer", async () => {
    const fetcher = answering("[]");
    await new MemoryDistiller(resolver(), fetcher as never).distil(exchange("Anything"));
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).max_tokens).toBeGreaterThanOrEqual(2_000);
  });

  it("reports failure when no inference route is configured", async () => {
    await expect(new MemoryDistiller(resolver({}), answering("[]") as never).distil(exchange("Anything")))
      .resolves.toEqual({ facts: [], succeeded: false });
  });

  it("succeeds with nothing for an empty turn, without calling the model", async () => {
    const fetcher = answering('["should not be reached"]');
    await expect(new MemoryDistiller(resolver(), fetcher as never).distil(exchange("   ")))
      .resolves.toEqual({ facts: [], succeeded: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
