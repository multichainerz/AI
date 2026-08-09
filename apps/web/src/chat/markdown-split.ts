/**
 * Splits streaming markdown into a part that will not change again and a live
 * tail.
 *
 * A streaming answer re-parses and re-renders its entire markdown tree on every
 * delta, so the cost of one token grows with the length of the answer. Rendering
 * the settled prefix as its own memoised block means a delta only re-renders the
 * paragraph it lands in.
 *
 * The whole value of that depends on the split never changing what the document
 * means. Markdown is context-sensitive: a break inside a fenced block, a list, a
 * table or a blockquote turns the tail into unrelated prose for a moment and
 * then snaps back when the next delta closes the structure. So the rule is
 * conservative in one direction only -- when in doubt this returns no split at
 * all, which costs exactly today's behaviour and never a wrong render.
 */

/**
 * Openers that mean the tail is a continuation of the block above it, not a new
 * one: bullets, ordered items with either delimiter, table rows, blockquotes and
 * definition lines.
 */
const CONTINUATION = /^(?:[-*+]\s|\d+[.)]\s|\||>|:)/;

/** A fence opener, allowing markdown's three spaces of leading indent. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Whether `text` ends inside a fenced code block.
 *
 * Backtick and tilde fences are tracked as one state but compared by character,
 * because only a fence of the same kind closes one: a `~~~` line inside a
 * ```-fenced block is content, not a terminator.
 */
function endsInsideFence(text: string): boolean {
  let marker = "";
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line);
    if (!fence) continue;
    const found = fence[1]!.charAt(0);
    if (marker === "") marker = found;
    else if (marker === found) marker = "";
  }
  return marker !== "";
}

/** The last line with content in it, which is the block the cut sits behind. */
function lastBlockLine(text: string): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.trim() !== "") return line;
  }
  return "";
}

export interface SplitMarkdown {
  /** Settled prefix, ending on its blank line so it parses as whole blocks. */
  stable: string;
  /** Everything after it, re-rendered on every delta. */
  tail: string;
}

/**
 * The last blank line that is safe to cut on, or no split.
 *
 * Candidates are tried newest first, so the tail stays as small as the content
 * allows and the memoised prefix as large.
 */
export function splitStableMarkdown(text: string): SplitMarkdown {
  for (let index = text.lastIndexOf("\n\n"); index > 0; index = text.lastIndexOf("\n\n", index - 1)) {
    const stable = text.slice(0, index + 2);
    if (endsInsideFence(stable)) continue;
    const tail = text.slice(index + 2);
    const firstLine = tail.slice(0, tail.indexOf("\n") === -1 ? undefined : tail.indexOf("\n"));
    // Indented text is a continuation too -- a code block, or a nested list item
    // whose parent is above the cut.
    if (/^\s/.test(firstLine)) continue;
    /*
     * Unsafe only when the cut lands *inside* a structure, which means both
     * sides of it open the same kind of block. A list following a paragraph is
     * a safe cut: rendered apart they are a paragraph and a list, which is what
     * they are rendered together. A list following a list is not: markdown
     * rejoins the two into one loose list, so splitting there changes the item
     * spacing the moment the next delta arrives, and changes it back after.
     */
    if (CONTINUATION.test(firstLine) && CONTINUATION.test(lastBlockLine(stable))) continue;
    return { stable, tail };
  }
  return { stable: "", tail: text };
}
