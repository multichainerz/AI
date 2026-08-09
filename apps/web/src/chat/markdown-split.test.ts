import { describe, expect, it } from "vitest";
import { splitStableMarkdown } from "./markdown-split.js";

describe("splitStableMarkdown", () => {
  it("cuts on the last blank line so the tail is the paragraph being written", () => {
    const { stable, tail } = splitStableMarkdown("First para.\n\nSecond para.\n\nStill typ");
    expect(stable).toBe("First para.\n\nSecond para.\n\n");
    expect(tail).toBe("Still typ");
    // The two halves must reconstitute the input exactly: anything else is text
    // dropped or duplicated on screen.
    expect(stable + tail).toBe("First para.\n\nSecond para.\n\nStill typ");
  });

  it("never cuts inside a fenced code block", () => {
    /*
     * The blank line here is *inside* the fence. Cutting on it renders the rest
     * of the program as prose until the closing fence arrives, then snaps back
     * to code -- a flicker on every multi-paragraph code block a model writes.
     */
    const text = "Here:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
    expect(splitStableMarkdown(text)).toEqual({ stable: "Here:\n\n", tail: "```ts\nconst a = 1;\n\nconst b = 2;\n" });
  });

  it("treats a tilde fence as a fence", () => {
    // ``` and ~~~ are both fences, and only a fence of the same kind closes one.
    const text = "Intro.\n\n~~~python\nx = 1\n\ny = 2\n";
    expect(splitStableMarkdown(text).tail.startsWith("~~~python")).toBe(true);
  });

  it("does not let one fence kind close the other", () => {
    /*
     * A `~~~` line inside a ```-fenced block is content -- markdown about
     * markdown, which a model writes often. Counting all fence lines together
     * sees two markers, calls the block closed, and cuts inside it.
     *
     * The tilde has to be at the start of its line for this to test anything: an
     * earlier version buried it mid-sentence, where the fence pattern never
     * matched, and the assertion held no matter what the counter did.
     */
    const text = "Intro.\n\n```\n~~~\n\nstill code\n";
    expect(splitStableMarkdown(text).stable).toBe("Intro.\n\n");
  });

  it("refuses a cut that lands inside a list, table, quote or definition", () => {
    for (const opener of ["- item", "* item", "+ item", "3. item", "4) item", "| b |", "> quote", ": def"]) {
      // Both sides of the cut open the same kind of block, so markdown rejoins
      // them into one -- splitting there changes the rendering while the answer
      // streams and changes it back when it finishes.
      const text = `Lead in.\n\n${opener}\n\n${opener}`;
      expect(splitStableMarkdown(text), opener).toEqual({ stable: "Lead in.\n\n", tail: `${opener}\n\n${opener}` });
    }
  });

  it("still cuts before a structure that the prefix does not continue", () => {
    /*
     * The distinction the rule above turns on, and the one a first attempt at
     * this got wrong: a list *following* a paragraph is a safe cut. Apart they
     * render as a paragraph and a list; together they render as a paragraph and
     * a list. Refusing it would leave the whole answer in the live tail the
     * moment it contained a single bullet -- which is most answers.
     */
    const { stable, tail } = splitStableMarkdown("Lead in.\n\n- one\n- two");
    expect(stable).toBe("Lead in.\n\n");
    expect(tail).toBe("- one\n- two");
  });

  it("refuses an indented tail", () => {
    // Indentation means a nested item or an indented code block whose parent is
    // above the cut.
    expect(splitStableMarkdown("Lead.\n\n  nested continuation").stable).toBe("");
  });

  it("returns no split when nothing qualifies", () => {
    // The documented fallback: exactly today's behaviour, one block, never a
    // wrong render.
    expect(splitStableMarkdown("One unbroken paragraph still growing"))
      .toEqual({ stable: "", tail: "One unbroken paragraph still growing" });
    expect(splitStableMarkdown("")).toEqual({ stable: "", tail: "" });
  });

  it("keeps the tail as small as the content allows", () => {
    // Candidates are tried newest first, so the memoised prefix is as large as
    // it can safely be -- the entire point of splitting.
    const { stable, tail } = splitStableMarkdown("a\n\nb\n\nc\n\nd");
    expect(stable).toBe("a\n\nb\n\nc\n\n");
    expect(tail).toBe("d");
  });
});
