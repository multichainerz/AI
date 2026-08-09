import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitStableMarkdown } from "./markdown-split.js";

/**
 * One parsed markdown block, memoised on its text.
 *
 * Deliberately renders no wrapper of its own: two of these sit inside one
 * `.message-markdown`, and every element style is keyed on that class, so an
 * intervening div would break the descendant selectors that style assistant
 * output.
 */
const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => defaultUrlTransform(url)}
      components={{
        a: ({ children, ...properties }) => (
          <a {...properties} target="_blank" rel="noreferrer noopener">{children}</a>
        ),
        img: ({ alt }) => <span className="blocked-inline-image">[External image blocked{alt ? `: ${alt}` : ""}]</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

/**
 * An assistant message, rendered so that a delta costs the paragraph it lands in
 * rather than the whole answer.
 *
 * A streaming turn re-parses its entire markdown tree on every delta, so the
 * cost of one token grows with the length of the answer -- by the end of a long
 * reply that is the difference between text that flows and text that stutters.
 * Splitting the settled prefix into its own memoised block means React reuses it
 * untouched and only the live tail is re-parsed.
 *
 * A finished turn takes the single-block path, unconditionally. It is not an
 * optimisation: it keeps completed content byte-identical to what one
 * ReactMarkdown produced before this existed, which is what the transcript tests
 * pin and what a reader ends up looking at.
 */
export const MarkdownMessage = memo(function MarkdownMessage(
  { content, streaming = false }: { content: string; streaming?: boolean },
) {
  if (!streaming) {
    return (
      <div className="message-markdown">
        <MarkdownBlock content={content} />
      </div>
    );
  }
  const { stable, tail } = splitStableMarkdown(content);
  return (
    <div className="message-markdown">
      {stable ? <MarkdownBlock content={stable} /> : null}
      {tail ? <MarkdownBlock content={tail} /> : null}
    </div>
  );
});
