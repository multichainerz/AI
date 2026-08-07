import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.js";
import { cn } from "./cn.js";

/**
 * The merge has to know the theme.
 *
 * tailwind-merge's colour matcher accepts any `text-*` class, so a size token it
 * has not been told about is read as a colour and deleted by the colour next to
 * it. That deletion is invisible: the class simply is not in the DOM, no warning
 * is logged, and the element inherits a size that looks plausible. It shipped in
 * the first release of the design system and was found by measuring a button in
 * a browser, not by reading the code.
 */

const fontSizes = Object.keys(config.theme?.extend?.fontSize ?? {});

describe("cn", () => {
  it("knows every font size in the Tailwind config", () => {
    // The guard against drift: add a size to the config without adding it to
    // `cn.ts` and this fails rather than silently dropping it at runtime.
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const size of fontSizes) {
      expect(cn(`text-${size}`, "text-muted"), `text-${size} was swallowed by the colour group`)
        .toBe(`text-${size} text-muted`);
    }
  });

  it("keeps a size and a colour together in either order", () => {
    expect(cn("text-[#0a0a0b] bg-accent", "text-body")).toBe("text-[#0a0a0b] bg-accent text-body");
    expect(cn("font-mono text-micro uppercase text-faint")).toBe("font-mono text-micro uppercase text-faint");
  });

  it("still resolves a genuine conflict in favour of the later class", () => {
    expect(cn("text-body", "text-figure")).toBe("text-figure");
    expect(cn("text-body", "text-[13px]")).toBe("text-[13px]");
    expect(cn("text-muted", "text-faint")).toBe("text-faint");
    expect(cn("px-3", "px-6")).toBe("px-6");
    expect(cn("rounded", "rounded-pill")).toBe("rounded-pill");
  });

  it("leaves the focus ring intact", () => {
    // `outline` and `outline-2` are one group under Tailwind 4 and two under
    // Tailwind 3. The project is on 3, so a merge built for 4 drops the style
    // and the ring never paints — which is why the version is pinned.
    expect(cn("focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"))
      .toBe("focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent");
  });
});
