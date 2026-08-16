import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * Newlines are normalized on the way in, not asserted on.
 *
 * `core.autocrlf` is true on Windows checkouts, so whether a given source file
 * arrives LF or CRLF is a property of the clone rather than of the code. The
 * ordering assertion below searches for a literal that spans a line break, and
 * it failed on a Windows working tree against source that was byte-identical
 * to the passing one on CI.
 */
const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const app = read("./app.tsx");
const stylesheet = read("./styles.css");

describe("collapsed navigation rail", () => {
  it("keeps one unboxed white Orca at the same size in both rail widths", () => {
    expect(app).toContain("sidebar-brand-mark");
    expect(app).toContain("nav-app-icon");
    expect(stylesheet).toContain("grid-template-columns: 80px minmax(0, 1fr)");
    expect(stylesheet).toContain(".app-shell--focus .sidebar { padding: 28px 6px 16px; }");
    expect(stylesheet).toContain(".app-shell--focus .nav-group { gap: 9px; }");
    expect(stylesheet).toContain(".sidebar-brand-mark {");
    expect(stylesheet).toContain(".sidebar-brand-mark img {");
    expect(stylesheet).toContain("width: 38px");
    expect(stylesheet).toContain("filter: brightness(0) invert(1)");
    expect(stylesheet).toContain(".nav-app-icon svg { width: 22px; height: 22px; }");
    expect(stylesheet).not.toContain(".sidebar-brand-tile");
    expect(stylesheet).not.toContain(".app-shell--focus .sidebar-brand-mark img");
    expect(stylesheet).not.toContain(".app-shell--focus .nav-app-icon svg");
    expect(app).toContain("<BrandMark size={38} />");
    expect(stylesheet).toContain(".app-shell--focus .sidebar nav button[aria-current=\"page\"] {");
  });

  it("makes collapse an edge-to-edge footer action rather than an inset row", () => {
    expect(app).toContain("sidebar-collapse-button");
    expect(app).not.toContain('className="mb-3 flex h-9');
    expect(stylesheet).toContain("margin: 12px -12px -16px");
    expect(stylesheet).toContain(".sidebar-collapse-button {");
    expect(stylesheet).toContain("min-height: 58px");
    expect(stylesheet).toContain(".app-shell--focus .sidebar-bottom {");
    expect(stylesheet).toContain("margin-inline: -6px");
  });

  it("draws settings as the last row of the primary menu, above the collapse action", () => {
    const menu = app.indexOf('<nav aria-label="Primary navigation">');
    const menuEnd = app.indexOf("</nav>", menu);
    const topGroup = app.indexOf('<div className="nav-group">', menu);
    const footer = app.indexOf('<div className="sidebar-bottom">');
    const collapse = app.indexOf('className="sidebar-collapse-button', footer);

    expect(menu).toBeGreaterThan(-1);
    expect(topGroup).toBeGreaterThan(menu);
    expect(menuEnd).toBeGreaterThan(topGroup);
    expect(app).not.toContain("nav-group--bottom");

    expect(app).toContain('{primaryNavigationItems("top").map(renderNavigationRow)}');
    expect(app).toContain('aria-current={active ? "page" : undefined}');

    expect(footer).toBeGreaterThan(menuEnd);
    expect(collapse).toBeGreaterThan(footer);

    expect(app).not.toContain("sidebar-settings-button");
    expect(app).not.toContain("nav-settings-mobile");
    expect(app).not.toContain("settingsNavigationItem");
    expect(stylesheet).not.toContain("sidebar-settings-button");
    expect(stylesheet).not.toContain("nav-settings-mobile");
  });

  it("keeps the app-tile treatment when navigation becomes a phone dock", () => {
    expect(stylesheet).toContain(".sidebar .nav-app-icon {");
    expect(stylesheet).toContain(".sidebar nav button[aria-current=\"page\"] .nav-app-icon {");
    expect(stylesheet).toContain(".sidebar .nav-app-icon svg { width: 19px; height: 19px; }");
  });

  it("sizes dock tiles to their contents so the whole menu fits the bar", () => {
    /*
     * The rows carry `w-full` for the rail, where full width is the whole
     * point. On the dock that resolved against the bar instead: every tile
     * measured the width of the bar, `shrink-0` refused to let it give any of
     * that back, and the strip scrolled one area at a time behind an effect
     * that kept re-centring the active one. `min-width: 62px` beside it says
     * what the tile was meant to be, so the fix is to stop the utility from
     * winning rather than to add a second width.
     */
    expect(stylesheet).toContain(`  .sidebar nav button {
    width: auto;
    min-width: 62px;`);
  });
});
