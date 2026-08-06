import { describe, expect, it, vi } from "vitest";
import { ForgetMatcher, parseMatches } from "./forget-matcher.js";

/**
 * The parser is the dangerous half: these numbers select rows that are about to
 * be forgotten, so a lenient reading of a small model's answer removes memory
 * nobody asked to lose.
 */

const candidates = [
  { id: "11111111-1111-4111-8111-111111111111", content: "The user leads the Titan migration." },
  { id: "22222222-2222-4222-8222-222222222222", content: "The user works in Jakarta." },
  { id: "33333333-3333-4333-8333-333333333333", content: "The user's Titan deadline is in March." },
];

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

/** The matcher streams now, so the stub speaks SSE. */
function answering(content: string, finishReason = "stop") {
  const frame = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
  const body = frame({ choices: [{ index: 0, delta: { content } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
    + "data: [DONE]\n\n";
  return vi.fn(async () => new Response(body, { status: 200 }));
}

describe("parseMatches", () => {
  it("resolves 1-based numbers back to ids", () => {
    expect(parseMatches("[1, 3]", candidates)).toEqual([candidates[0]!.id, candidates[2]!.id]);
  });

  it("reads an array a small model wrapped in a fence and commentary", () => {
    expect(parseMatches("Sure, here they are:\n```json\n[2]\n```\n", candidates))
      .toEqual([candidates[1]!.id]);
  });

  it("accepts the object and string forms a small model produces", () => {
    expect(parseMatches('[{"number": 1}, "3"]', candidates))
      .toEqual([candidates[0]!.id, candidates[2]!.id]);
  });

  it("ignores a number naming a fact it was never shown", () => {
    // A hallucinated index must forget nothing, rather than whatever happens to
    // sit at that position.
    expect(parseMatches("[9, 0, -1]", candidates)).toEqual([]);
  });

  it("treats an empty array as the answer it is", () => {
    expect(parseMatches("[]", candidates)).toEqual([]);
  });

  it("yields nothing when the model answered in prose", () => {
    expect(parseMatches("None of these facts are about Project Titan.", candidates)).toEqual([]);
    expect(parseMatches("", candidates)).toEqual([]);
  });

  it("does not repeat an id the model listed twice", () => {
    expect(parseMatches("[1, 1, 1]", candidates)).toEqual([candidates[0]!.id]);
  });
});

describe("ForgetMatcher", () => {
  it("asks the configured model and returns what it matched", async () => {
    const fetcher = answering("[1, 3]");
    const result = await new ForgetMatcher(resolver(), fetcher as never)
      .match("Project Titan", candidates);

    expect(result).toEqual({
      matchedIds: [candidates[0]!.id, candidates[2]!.id],
      succeeded: true,
      truncated: false,
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "hermes-agent", temperature: 0 });
    expect(body.messages[1].content).toContain("TOPIC: Project Titan");
    expect(body.messages[1].content).toContain("1. The user leads the Titan migration.");
    // Ids never enter the prompt: a number cannot be misattributed, a uuid can.
    expect(body.messages[1].content).not.toContain(candidates[0]!.id);
  });

  it("reports failure rather than an empty match when the model is unreachable", async () => {
    // The distinction matters more here than anywhere: an operator told nothing
    // matched will conclude the topic is not stored, and act on that.
    const fetcher = vi.fn(async () => new Response("upstream down", { status: 502 }));
    await expect(new ForgetMatcher(resolver(), fetcher as never).match("Titan", candidates))
      .resolves.toMatchObject({ matchedIds: [], succeeded: false });
  });

  it("reports failure when a reasoning model spent its budget before answering", async () => {
    const fetcher = answering("", "length");
    await expect(new ForgetMatcher(resolver(), fetcher as never).match("Titan", candidates))
      .resolves.toMatchObject({ matchedIds: [], succeeded: false });
  });

  it("reports failure when no inference route is configured", async () => {
    await expect(new ForgetMatcher(resolver({}), answering("[1]") as never).match("Titan", candidates))
      .resolves.toMatchObject({ matchedIds: [], succeeded: false });
  });

  it("says so when more memory existed than one decision could read", async () => {
    // Silent truncation would let "2 matched" stand for a scan that never
    // reached most of the store.
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `${index}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
      content: `The user recorded observation number ${index} about the platform migration.`,
    }));
    const result = await new ForgetMatcher(resolver(), answering("[1]") as never)
      .match("the migration", many);

    expect(result.truncated).toBe(true);
    expect(result.succeeded).toBe(true);
  });

  it("matches nothing, successfully, when the owner has no memory", async () => {
    const fetcher = answering("[1]");
    await expect(new ForgetMatcher(resolver(), fetcher as never).match("Titan", []))
      .resolves.toEqual({ matchedIds: [], succeeded: true, truncated: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
