import { describe, expect, it, vi } from "vitest";
import { MemoryDistiller, parseDistillation } from "./memory-distiller.js";

/**
 * These cases come from the pilot's actual store, where capturing raw turns
 * produced 21 rows of questions, greetings and the model describing itself.
 * The parser is the part that fails quietly — a small model wraps JSON in
 * prose, and a lenient parser would turn that prose into a "memory".
 */

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

function answering(content: string) {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
}

describe("parseDistillation", () => {
  it("reads a bare array", () => {
    expect(parseDistillation('["The user leads the platform team."]'))
      .toEqual(["The user leads the platform team."]);
  });

  it("reads an array a small model wrapped in a fence and commentary", () => {
    expect(parseDistillation('Sure! Here are the facts:\n```json\n["The user works in Jakarta."]\n```\nHope that helps.'))
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

  it("drops non-strings and blank entries rather than storing them", () => {
    expect(parseDistillation('["Valid fact about the user.", 42, null, "   ", {"a":1}]'))
      .toEqual(["Valid fact about the user."]);
  });

  it("bounds the count and the length of what it accepts", () => {
    const many = JSON.stringify(Array.from({ length: 12 }, (_, index) => `Fact number ${index} about the user.`));
    expect(parseDistillation(many)).toHaveLength(5);
    const [long] = parseDistillation(JSON.stringify([`The user ${"x".repeat(400)}`]));
    expect(long?.length).toBe(200);
  });

  it("collapses whitespace so one fact cannot arrive as a paragraph", () => {
    expect(parseDistillation('["The user   prefers\\n\\n  Indonesian."]'))
      .toEqual(["The user prefers Indonesian."]);
  });
});

describe("MemoryDistiller", () => {
  it("asks the configured model and returns what it extracted", async () => {
    const fetcher = answering('["The user leads the platform team."]');
    const result = await new MemoryDistiller(resolver(), fetcher as never)
      .distil("I lead the platform team here.", "Noted.");
    expect(result).toEqual({ facts: ["The user leads the platform team."], succeeded: true });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "hermes-agent", temperature: 0 });
    // The exchange is one user message; the instruction is separate, so a turn
    // cannot overwrite the rules by containing text that looks like them.
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("USER: I lead the platform team here.");
  });

  it("reports failure rather than emptiness when the model is unreachable", async () => {
    // The caller stores nothing either way, but only a failure is worth logging
    // — and it must never be mistaken for "this turn taught nothing".
    const fetcher = vi.fn(async () => new Response("upstream down", { status: 502 }));
    await expect(new MemoryDistiller(resolver(), fetcher as never).distil("Anything", null))
      .resolves.toEqual({ facts: [], succeeded: false });
  });

  it("reports failure when no inference route is configured", async () => {
    await expect(new MemoryDistiller(resolver({}), answering("[]") as never).distil("Anything", null))
      .resolves.toEqual({ facts: [], succeeded: false });
  });

  it("succeeds with nothing for an empty turn, without calling the model", async () => {
    const fetcher = answering('["should not be reached"]');
    await expect(new MemoryDistiller(resolver(), fetcher as never).distil("   ", null))
      .resolves.toEqual({ facts: [], succeeded: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
