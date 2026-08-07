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
