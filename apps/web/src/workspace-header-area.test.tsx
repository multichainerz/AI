/**
 * @vitest-environment jsdom
 *
 * The area lockup in the sticky band: the rail's own glyph, beside the area's
 * name, on every screen.
 *
 * The cases are driven from `primaryNavigationGroups` rather than from a list
 * of six strings written here, so an area added to the product is an area this
 * file already covers. That matters more than it looks: the icon is drawn from
 * the navigation model, and a list typed out beside the assertions would go
 * stale in exactly the same way the second lookup table these tests exist to
 * forbid would.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceHeader } from "./app.js";
import { primaryNavigationGroups } from "./workspace-navigation.js";

const areas = primaryNavigationGroups.flatMap((group) => group.items);

/*
 * Read through `process.cwd()` and not `import.meta.url`, which is not a file
 * URL under the jsdom environment -- `home-view.test.tsx` reads the stylesheet
 * the same way for the same reason. Newlines are normalized on the way in
 * because `core.autocrlf` is true on Windows checkouts, so whether this file
 * arrives LF or CRLF is a property of the clone rather than of the code.
 */
const source = readFileSync(resolve(process.cwd(), "src/app.tsx"), "utf8").replaceAll("\r\n", "\n");

const operator = { initials: "SA", name: "System administrator", detail: "platform admin" };

/**
 * The header for one area, and the lockup inside it.
 *
 * The lockup is found through the title's own parent rather than through a
 * class name, because "the glyph is inside the same box as the name" is half of
 * what is being asserted -- an icon that drifted out to become a sibling of the
 * whole row would still be *in* the header and would still satisfy a query for
 * "an svg in the band", while sitting 16px off and reading as one more control.
 * It also keeps the theme switch's two icons and the account chevron out of
 * every query below.
 */
function lockupFor(area: string) {
  render(<WorkspaceHeader area={area} operator={operator} onSignOut={() => undefined} immersive={false} />);
  const title = screen.getByText(area);
  const lockup = title.parentElement;
  if (!lockup) throw new Error(`the ${area} title rendered without a parent`);
  return { title, lockup, glyph: lockup.querySelector("svg") };
}

afterEach(cleanup);

describe("the workspace header's area lockup", () => {
  it("covers every area the rail draws, including Settings", () => {
    /*
     * The precondition of every loop below. Settings used to sit in a
     * `"bottom"` group that `primaryNavigationItems("top")` silently omitted,
     * so a header test driven only from the top of the rail would pass over
     * five areas while the sixth shipped without a glyph.
     */
    expect(areas.map((item) => item.area)).toContain("Settings");
    expect(areas.length).toBeGreaterThan(5);
  });

  it("draws a glyph beside the name of every product area", () => {
    for (const { area } of areas) {
      const { glyph } = lockupFor(area);
      expect(glyph, `${area} has no glyph in the header`).toBeTruthy();
      cleanup();
    }
  });

  it("draws a different glyph for each area rather than one shared mark", () => {
    /*
     * A lookup that lost its argument, or fell back to a default, would satisfy
     * "every area has a glyph" while drawing the Dashboard's monitor above the
     * audit trail. Identity is what the operator actually reads.
     */
    const drawn = new Set<string>();
    for (const { area } of areas) {
      const { glyph } = lockupFor(area);
      drawn.add(glyph?.getAttribute("class") ?? "");
      cleanup();
    }

    expect(drawn.size).toBe(areas.length);
  });

  it("keeps the glyph out of the accessibility tree so the area is announced once", () => {
    for (const { area } of areas) {
      const { glyph, title } = lockupFor(area);

      /*
       * Asserted on the wrapper, and deliberately not with `closest()`: Lucide
       * puts `aria-hidden` on the <svg> it builds, so a search that starts at
       * the glyph itself passes whatever this file does -- a guard that cannot
       * fail. The wrapper is the attribute this header controls, and the one
       * that would still hide a hand-drawn SVG dropped into `Glyph`'s map.
       */
      expect(glyph?.parentElement?.getAttribute("aria-hidden"), `${area}'s glyph is exposed to assistive tech`).toBe("true");
      // The name itself stays readable -- hiding the picture must not hide the word.
      expect(title.getAttribute("aria-hidden")).toBeNull();
      expect(title.closest('[aria-hidden="true"]')).toBeNull();
      cleanup();
    }
  });

  it("takes the glyph's colour from the band's tokens instead of stating one", () => {
    /*
     * `.workspace-header` re-scopes the text ramp for the band, so a class that
     * carries its own value is the one mark in there that would not follow it.
     * The rule is "a token", not "this token", which is why the assertion is an
     * absence of literals plus the presence of a ramp class rather than a pin on
     * a particular step.
     */
    const { glyph } = lockupFor("Agents");
    const wrapper = glyph?.parentElement;

    expect(wrapper?.className).toMatch(/\btext-(text|muted|faint|accent)\b/);
    expect(wrapper?.className).not.toMatch(/#[0-9a-f]{3,8}\b|\btext-(white|black)\b|\brgb\(/i);
  });

  it("sizes the glyph to the title rather than to the rail it came from", () => {
    /*
     * `Glyph` hands out the rail's 20px drawing, which towers over a 15px
     * heading; the header re-sizes it in CSS on the wrapper. Asserted on the
     * class rather than on a computed height because jsdom applies no
     * stylesheet -- what is being pinned is that the override is still there and
     * still an override, not a second `size` prop passed into a shared glyph.
     */
    const { glyph } = lockupFor("Agents");

    expect(glyph?.parentElement?.className).toContain("[&_svg]:h-[17px]");
    expect(glyph?.parentElement?.className).toContain("[&_svg]:w-[17px]");
    expect(glyph?.getAttribute("width")).toBe("20");
  });

  it("renders nothing at all for an area the navigation model has no icon for", () => {
    /*
     * Not a placeholder and not an empty box. A wrapper kept at a fixed 17px so
     * the layout "holds its place" would stand the title 25px off the position
     * every other screen puts it in, and read as an image that failed to load;
     * an empty wrapper would still keep the 8px lockup gap and move it by that.
     * Both are asserted at once by there being no element there at all, which is
     * why the child count is checked and not merely the absence of an <svg>.
     */
    const { lockup, glyph, title } = lockupFor("Nowhere");

    expect(glyph).toBeNull();
    expect(lockup.children.length).toBe(1);
    expect(lockup.firstElementChild).toBe(title);
  });

  it("goes through the one glyph map the rail already draws from", () => {
    /*
     * The structural half of the claim, and the one no rendered assertion can
     * make: a second key-to-component map in this file would draw perfectly
     * today and drift on the first design change, showing the header one mark
     * while the rail row an inch to its left shows another. So each Lucide
     * component may be written into the JSX exactly once -- inside `Glyph` --
     * and the header may only dispatch through it.
     */
    expect(source).toContain("<Glyph name={areaIcon} />");

    for (const component of ["LayoutDashboard", "MessageSquareText", "Bot", "Settings", "Waypoints", "Activity"]) {
      expect(source.split(`<${component} `).length - 1, `${component} is drawn more than once`).toBe(1);
    }
  });

  it("keeps appearance inside the account menu rather than on the band", async () => {
    const user = userEvent.setup();
    render(<WorkspaceHeader area="Agents" operator={operator} onSignOut={() => undefined} immersive={false} />);

    expect(screen.queryByRole("switch", { name: "Light appearance" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "System administrator" }));
    expect(screen.getByRole("switch", { name: "Light appearance" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });
});
