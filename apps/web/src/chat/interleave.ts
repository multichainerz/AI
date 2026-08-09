/**
 * Places what the agent did *where it did it* in the answer.
 *
 * The activity list sits in one block, so a turn that searched, wrote two
 * paragraphs, searched again and wrote two more reads as "four things happened"
 * followed by "here is the answer" -- and a reader cannot tell which retrieval
 * produced which claim. That is the whole question an evidence-bearing
 * transcript has to answer.
 *
 * `contentOffset` was added to the event log for this and has never been used:
 * the runtime reports how many characters of the answer existed when each event
 * fired, so the log already knows where each call belongs.
 *
 * Pure, and tested without a DOM, because the interesting part is a cut that
 * must never land inside a fence.
 */
import type { TimelineEntry, TimelineEvent } from "./timeline.js";

export type TranscriptPart<E extends TimelineEvent> =
  | { kind: "text"; text: string }
  | { kind: "activity"; entry: TimelineEntry<E> };

/**
 * Whether an odd number of fences is open at this point.
 *
 * Backticks and tildes are counted separately: ``` inside a ~~~ block is
 * content, not a delimiter, and treating them as one alphabet makes every
 * example of markdown-in-markdown look unterminated.
 */
function insideFence(text: string): boolean {
  const backtick = text.match(/^\s{0,3}```/gm)?.length ?? 0;
  const tilde = text.match(/^\s{0,3}~~~/gm)?.length ?? 0;
  return backtick % 2 === 1 || tilde % 2 === 1;
}

/**
 * The nearest block boundary at or before `offset`.
 *
 * A card dropped at a raw character offset lands mid-sentence, mid-list, or --
 * worst -- inside a code fence, where it takes the rest of the answer into the
 * code block with it. Cutting back to a blank line puts the card between blocks,
 * which is the only place a block-level element can go.
 *
 * Returns 0 when there is no safe boundary, which places the card ahead of the
 * answer rather than inventing one.
 */
export function safeBoundary(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length));
  let cut = text.lastIndexOf("\n\n", limit);
  while (cut > 0) {
    // `+2` so the boundary is after the blank line, not before it.
    if (!insideFence(text.slice(0, cut + 2))) return cut + 2;
    cut = text.lastIndexOf("\n\n", cut - 1);
  }
  return 0;
}

/** The offset an entry belongs at: where its first event fired. */
function offsetOf<E extends TimelineEvent>(entry: TimelineEntry<E>): number | null {
  for (const event of entry.events) {
    const offset = (event as { contentOffset?: number | null }).contentOffset;
    if (typeof offset === "number") return offset;
  }
  return null;
}

/**
 * The answer, cut into blocks with each entry at the point it happened.
 *
 * An entry the runtime gave no offset keeps its place at the front rather than
 * being dropped or guessed at: it happened, and the log does not say where.
 * Entries sharing a boundary keep the order they arrived in, so two calls in
 * one paragraph still read in sequence.
 */
export function interleaveByOffset<E extends TimelineEvent>(
  content: string,
  entries: readonly TimelineEntry<E>[],
): TranscriptPart<E>[] {
  if (entries.length === 0) {
    return content ? [{ kind: "text", text: content }] : [];
  }

  const placed = entries.map((entry, index) => {
    const offset = offsetOf(entry);
    return { entry, index, at: offset === null ? 0 : safeBoundary(content, offset) };
  });
  // Stable by arrival within a boundary: `sort` is stable in every engine this
  // ships to, and the index tiebreak states the intent rather than relying on it.
  placed.sort((a, b) => a.at - b.at || a.index - b.index);

  const parts: TranscriptPart<E>[] = [];
  let cursor = 0;
  for (const { entry, at } of placed) {
    if (at > cursor) {
      parts.push({ kind: "text", text: content.slice(cursor, at) });
      cursor = at;
    }
    parts.push({ kind: "activity", entry });
  }
  if (cursor < content.length) parts.push({ kind: "text", text: content.slice(cursor) });
  return parts;
}
