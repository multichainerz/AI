import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.js";

/**
 * The two ways a design token silently produces nothing.
 *
 * Neither shows up as an error: the class sits in the DOM, the declaration is
 * absent from the stylesheet, and the element inherits something plausible.
 * Both were found by reading computed styles in a browser, not by reading code.
 */

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const colors = config.theme?.extend?.colors as Record<string, string>;
const radii = config.theme?.extend?.borderRadius as Record<string, string>;

describe("colour tokens", () => {
  it("declares every colour in the alpha-capable form", () => {
    // `var(--bad)` holding a hex gives Tailwind nothing to split, so `bg-bad/10`
    // emits no rule whatsoever. The template form is what makes a modifier work.
    for (const [name, value] of Object.entries(colors)) {
      expect(value, `colour "${name}" cannot take an opacity modifier`).toContain("<alpha-value>");
    }
  });

  it("backs every colour with the channel variable it references", () => {
    for (const [name, value] of Object.entries(colors)) {
      const variable = /var\((--[a-z-]+)\s*\)/.exec(value)?.[1];
      expect(variable, `colour "${name}" references no custom property`).toBeTruthy();
      expect(styles, `${variable} is not defined in styles.css`).toContain(`${variable}:`);
    }
  });
});

describe("the border reset", () => {
  it("keeps preflight on, because it is what makes `border` paint at all", () => {
    /*
     * `border-style` defaults to `none` and CSS then computes `border-width` to
     * 0, so Tailwind's `border` (width only) draws nothing without the global
     * `border-style: solid` that preflight supplies. Turning preflight off
     * again — which was correct while views were still on the old stylesheet —
     * would silently un-border every Panel, card, input and dialog in the set.
     */
    // Absent means enabled; the config only ever names it to switch it off.
    const corePlugins = (config as { corePlugins?: Record<string, boolean> }).corePlugins;
    expect(corePlugins?.preflight, "preflight must not be disabled").not.toBe(false);
  });

  it("keeps a border style on the button reset too", () => {
    /*
     * `border: 0` also sets `border-style: none`, and CSS then computes
     * border-width to 0 no matter what a class declares. Preflight is off, so
     * this reset is the only thing standing between an unclassed button and the
     * OS default — but written as the bare shorthand it removed the border from
     * every Button variant in the set.
     */
    const reset = /@layer base\s*\{[\s\S]*?\bbutton\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(reset, "the base button reset is missing").not.toBe("");
    expect(reset).toMatch(/border:\s*0\s+solid/);
  });
});

describe("the sticky band's inset", () => {
  /**
   * The band's inset and the page's content inset are separate tokens, and they
   * have to stay separate.
   *
   * They were one. `.workspace-page` lowers `--workspace-inline` to 12px so a
   * dock's gutter matches the gap between docks — a decision about page content
   * — and the header read the same token, so the area title sat 12px from the
   * rail on the nine areas that have a section strip and up to 24px on Dashboard
   * and Session. Moving between areas nudged the heading sideways, which is
   * exactly the kind of thing nothing here could have caught: the class was in
   * the DOM and the declaration was present, it just resolved to two values.
   */
  it("gives the header one inset that the page's content inset cannot move", () => {
    expect(styles).toContain("--workspace-band-inline:");

    // The page token is still overridden per page — that part is deliberate.
    expect(styles).toMatch(/\.workspace-page\s*\{[^}]*--workspace-inline:\s*12px/);

    // ...and the band must not read it. Every padding on `.workspace-header`
    // uses the band token; only its bleed margin may cancel the page's.
    const header = /\.workspace-header\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(header, "the .workspace-header rule is missing").not.toBe("");
    expect(header).toMatch(/padding:\s*0\s+var\(--workspace-band-inline\)/);
    expect(header).toMatch(/margin:\s*0\s+calc\(-1 \* var\(--workspace-inline\)\)/);

    // Session opts out of the bleed margin but keeps the same inset.
    expect(styles).toMatch(/\.chat-page > \.workspace-header \{[^}]*padding: 0 var\(--workspace-band-inline\)/);
  });
});

describe("component radius", () => {
  it("resolves every non-circular radius alias to one sharp token", () => {
    expect(styles).toContain("--radius-component: 0;");

    for (const [name, value] of Object.entries(radii)) {
      expect(value, `radius \"${name}\" drifted from the application silhouette`)
        .toBe("var(--radius-component)");
    }
  });
});
