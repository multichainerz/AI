import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPOSER_ZONE, THREAD_MEASURE, THREAD_SCROLLER } from "./measure.js";

/**
 * The handover from `.chat-messages` to `THREAD_SCROLLER`.
 *
 * Deleting a stylesheet rule and re-supplying it as utility classes is the kind
 * of change that looks complete in a diff and is not: every render test still
 * passes with `min-height: 0` missing, because jsdom lays nothing out. The only
 * thing that can catch a dropped declaration here is a check that reads both
 * sides and says which ones had to survive.
 */
const stylesheet = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("thread measure", () => {
  it("has one reading column, applied as a class rather than an inline width", () => {
    // The CSP in the built container refuses an inline `style=`, so a measure
    // expressed as a style attribute would work in dev and vanish in production.
    expect(THREAD_MEASURE).toBe("mx-auto w-full max-w-[46rem]");
  });

  it("leaves no second definition of .chat-messages behind", () => {
    /*
     * Both the rule and its narrow-viewport override. Leaving either one means
     * the transcript keeps a padding nobody can find from the JSX -- which is
     * how the four disagreeing widths happened in the first place.
     */
    expect(stylesheet).not.toMatch(/\.chat-messages/);
  });

  it("re-supplies everything the deleted rule provided", () => {
    /*
     * `min-height: 0` is the one that fails silently and worst: without it the
     * grid row refuses to shrink below its content, the transcript grows past
     * the viewport, and the composer leaves the bottom of the screen. The
     * reserved gutter is what stops the column stepping sideways the moment an
     * answer grows tall enough to scroll.
     */
    expect(THREAD_SCROLLER).toContain("min-h-0");
    expect(THREAD_SCROLLER).toContain("overflow-y-auto");
    expect(THREAD_SCROLLER).toContain("[scrollbar-gutter:stable]");
    // Horizontal padding at both steps: the tight one the narrow-viewport
    // override used to hand back, and the roomier one above it.
    expect(THREAD_SCROLLER).toMatch(/(^| )px-\d/);
    expect(THREAD_SCROLLER).toMatch(/(^| )sm:px-\d/);
  });

  it("puts the composer on the same edges as the thread above it", () => {
    // A composer indented differently from the messages reads as a step in the
    // column every time the transcript starts scrolling.
    for (const shared of ["px-4", "sm:px-6", "[scrollbar-gutter:stable]"]) {
      expect(THREAD_SCROLLER).toContain(shared);
      expect(COMPOSER_ZONE).toContain(shared);
    }
  });

  it("keeps the composer band on the chat canvas", () => {
    expect(COMPOSER_ZONE).toContain("bg-bg");
    expect(COMPOSER_ZONE).not.toContain("bg-surface");
    expect(COMPOSER_ZONE).not.toContain("border-t");
  });

  it("gives the chat page a dynamic viewport height, with a static fallback first", () => {
    /*
     * Order matters: `dvh` has to come second so it wins where it is understood
     * and is ignored where it is not. Reversed, a browser without `dvh` gets no
     * height at all.
     */
    const rule = /\.chat-page \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";
    expect(rule).toContain("height: 100vh");
    expect(rule).toContain("height: 100dvh");
    expect(rule.indexOf("100vh")).toBeLessThan(rule.indexOf("100dvh"));
  });

  it("gives the band a row of its own rather than hiding it", () => {
    /*
     * The band used to be hidden here, because on a single fixed-height block
     * it would have pushed the composer off the bottom of the screen. It
     * carries the account menu now -- the only way to sign out -- so hiding it
     * would strand that control on the product's most-used screen.
     *
     * Two rows solve what hiding solved: `auto` for the band, the rest for the
     * thread. `minmax(0, 1fr)` and not `1fr`, because a grid row's default
     * minimum is its content and a long transcript would grow past the
     * viewport, which is the same overflow the composer was being pushed out of.
     */
    const rule = /\.chat-page \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";
    expect(rule).toContain("display: grid");
    expect(rule).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(stylesheet).not.toContain(".chat-page > .workspace-header { display: none; }");
    expect(stylesheet).toContain(".chat-page > .mobile-brand { display: none; }");
  });

  it("cancels the band's bleed margins on a page that has no padding", () => {
    // `.workspace-header` pulls itself outward by `--workspace-inline` so its
    // border reaches the edge of a padded page. Chat has no padding, so
    // uncancelled those margins hang the header off both sides.
    expect(stylesheet).toContain(".chat-page > .workspace-header { margin: 0;");
  });

  it("uses Session's compact inset as the workspace default, not a 1380px column", () => {
    /*
     * Chat was the only full-bleed screen because `main > *` centred every
     * child at 1380px with a 24–64px clamp. The rest of the workspace now
     * shares Chat's inset, so a Dashboard or Agents tab cannot grow a second
     * reading column beside the one the header already sits in.
     */
    expect(stylesheet).toContain("--workspace-inline: clamp(16px, 3vw, 24px)");
    expect(stylesheet).not.toContain("1380px");
    expect(stylesheet).not.toContain("clamp(24px, 4vw, 64px)");
  });
});
