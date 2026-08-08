import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The fonts are the one asset the stylesheet references by URL rather than by
 * import, so nothing in the build fails if the file is missing — the page just
 * silently renders in whatever the operating system supplies. That is exactly
 * how Inter went un-shipped from ai-v1.54.0 to ai-v1.68.0 while `--sans` named
 * it the whole time.
 */

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const faces = [...styles.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]!);

describe("bundled fonts", () => {
  it("ships a file for every @font-face it declares", () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const url = /url\("([^"]+)"\)/.exec(face)?.[1];
      expect(url, "an @font-face with no url").toBeTruthy();
      // `public/` is served at the root, so a leading-slash URL maps there.
      const file = new URL(`../../public${url}`, import.meta.url);
      expect(() => statSync(file), `${url} is declared but not present`).not.toThrow();
      expect(statSync(file).size, `${url} is empty`).toBeGreaterThan(1_000);
    }
  });

  it("names each bundled family first in the stack that uses it", () => {
    // A family declared and then listed behind a system font would load the
    // file over the network and never draw a glyph from it.
    const families = faces.map((face) => /font-family:\s*"([^"]+)"/.exec(face)?.[1]).filter(Boolean);
    expect(families).toContain("Plus Jakarta Sans");
    expect(families).toContain("Space Grotesk");
    expect(families).toContain("JetBrains Mono");
    expect(/--sans:\s*"Plus Jakarta Sans"/.test(styles), "--sans must lead with Plus Jakarta Sans").toBe(true);
    expect(/--display:\s*"Space Grotesk"/.test(styles), "--display must lead with Space Grotesk").toBe(true);
    expect(/--mono:\s*"JetBrains Mono"/.test(styles), "--mono must lead with JetBrains Mono").toBe(true);
  });

  it("keeps text visible while the file is still in flight", () => {
    // `font-display: swap` on a control plane: readable-now beats
    // invisible-then-perfect, especially when the operator is diagnosing.
    for (const face of faces) expect(face).toMatch(/font-display:\s*swap/);
  });
});
