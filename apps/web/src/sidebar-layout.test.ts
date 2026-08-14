import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

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

  it("anchors application settings above the collapse action", () => {
    const bottomStart = app.indexOf('<div className="sidebar-bottom">');
    const settings = app.indexOf('className={cn(\n              "sidebar-settings-button', bottomStart);
    const collapse = app.indexOf('className="sidebar-collapse-button', bottomStart);

    expect(app).toContain("settingsNavigationItem");
    expect(bottomStart).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(bottomStart);
    expect(collapse).toBeGreaterThan(settings);
    expect(stylesheet).toContain('.sidebar-settings-button[aria-current="page"]');
  });

  it("keeps the app-tile treatment when navigation becomes a phone dock", () => {
    expect(stylesheet).toContain(".sidebar .nav-app-icon {");
    expect(stylesheet).toContain(".sidebar nav button[aria-current=\"page\"] .nav-app-icon {");
    expect(stylesheet).toContain(".sidebar .nav-app-icon svg { width: 19px; height: 19px; }");
  });
});
