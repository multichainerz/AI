import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./markdown-message.js";

/*
 * The streaming path, which the transcript tests do not reach: every message
 * they render is COMPLETED, so they only ever exercise the single-block render.
 * Splitting a document in two is only safe if both halves parse to the same
 * elements the whole would have.
 */
const STREAMING = "## Findings\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\nStill wri";

describe("MarkdownMessage while streaming", () => {
  it("renders the same elements the single-block path would", () => {
    const streamed = renderToStaticMarkup(<MarkdownMessage content={STREAMING} streaming />);
    for (const fragment of ["<h2>Findings</h2>", "<table>", "<pre>", "<code", "Still wri"]) {
      expect(streamed, fragment).toContain(fragment);
    }
    // One wrapper, not one per block: every markdown element style is a
    // descendant selector on this class, and a second wrapper would nest them.
    expect(streamed.match(/class="message-markdown"/g)).toHaveLength(1);
  });

  it("emits no inline style attribute, on either path", () => {
    // The CSP forbids inline styles, and scripts/test-csp-closure.sh only checks
    // built output -- a streaming-only leak would never appear there.
    for (const streaming of [true, false]) {
      expect(renderToStaticMarkup(<MarkdownMessage content={STREAMING} streaming={streaming} />))
        .not.toContain(" style=");
    }
  });

  it("keeps a completed turn byte-identical to the single-block render", () => {
    /*
     * The guarantee the transcript tests rest on. Whatever the split does to a
     * turn in flight, the thing a reader is left looking at has to be exactly
     * what one ReactMarkdown produced before any of this existed.
     */
    expect(renderToStaticMarkup(<MarkdownMessage content={STREAMING} streaming={false} />))
      .toBe(renderToStaticMarkup(<MarkdownMessage content={STREAMING} />));
  });

  it("does not tear a table in half mid-stream", () => {
    // A table whose rows are still arriving must render as one table or as
    // nothing recognisable -- never as a table plus a stray paragraph of pipes.
    const partial = "Intro.\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    const streamed = renderToStaticMarkup(<MarkdownMessage content={partial} streaming />);
    expect(streamed.match(/<table>/g)).toHaveLength(1);
    expect(streamed).not.toContain("| a | b |");
  });
});
