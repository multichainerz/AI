import { describe, expect, it } from "vitest";
import { chunkText, DEFAULT_CHUNK_BOUNDS } from "./chunking.js";

const bounds = { targetCharacters: 60, overlapCharacters: 10, maxChunks: 100 };

describe("chunkText", () => {
  it("returns nothing for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps short text as a single chunk", () => {
    expect(chunkText("A short internal policy statement.", bounds)).toEqual([
      { ordinal: 0, content: "A short internal policy statement." },
    ]);
  });

  it("splits on sentence boundaries and numbers chunks in reading order", () => {
    const text = Array.from({ length: 6 }, (_, index) => `Sentence number ${index} carries meaning.`).join(" ");
    const chunks = chunkText(text, bounds);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(({ ordinal }) => ordinal)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every(({ content }) => content.trim().length > 0)).toBe(true);
  });

  it("carries overlap from the previous chunk so a fact spanning a boundary stays retrievable", () => {
    const text = Array.from({ length: 8 }, (_, index) => `Clause ${index} states an approved threshold.`).join(" ");
    const chunks = chunkText(text, bounds);

    expect(chunks.length).toBeGreaterThan(1);
    const previousTail = chunks[0]!.content.slice(-bounds.overlapCharacters).trim();
    expect(chunks[1]!.content.startsWith(previousTail)).toBe(true);
  });

  it("hard-splits a single span that exceeds the target instead of emitting one oversized chunk", () => {
    const chunks = chunkText("x".repeat(500), bounds);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(
        bounds.targetCharacters + bounds.overlapCharacters + 1,
      );
    }
  });

  it("never exceeds the configured chunk ceiling", () => {
    const capped = { ...bounds, maxChunks: 3 };
    const text = Array.from({ length: 200 }, (_, index) => `Paragraph ${index}.`).join("\n\n");

    expect(chunkText(text, capped).length).toBeLessThanOrEqual(3);
  });

  it("uses production bounds that keep excerpts specific enough to inject", () => {
    expect(DEFAULT_CHUNK_BOUNDS.targetCharacters).toBeLessThanOrEqual(2_000);
    expect(DEFAULT_CHUNK_BOUNDS.overlapCharacters).toBeGreaterThan(0);
  });
});
