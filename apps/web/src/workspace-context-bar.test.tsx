/**
 * @vitest-environment jsdom
 *
 * The section strip that sits inside the sticky band. It used to be a row of
 * pills on the page; these cases pin that it is now icon+label tabs, and that
 * the active one is a current page rather than a filled chip.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceContextBar } from "./workspace-navigation.js";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

afterEach(cleanup);

describe("WorkspaceContextBar", () => {
  it("draws an icon beside every Agents tab", () => {
    render(<WorkspaceContextBar area="Agents" activeView="Agents" onSelect={() => undefined} />);

    const nav = screen.getByRole("navigation", { name: "Agents sections" });
    expect(nav.querySelectorAll("svg")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Profiles" }).querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skills" }).querySelector("svg")).toBeTruthy();
  });

  it("marks the active section as the current page", () => {
    render(<WorkspaceContextBar area="Agents" activeView="Skills" onSelect={() => undefined} />);

    expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Profiles" }).getAttribute("aria-current")).toBeNull();
  });

  it("renders nothing when the area has no sections", () => {
    const { container } = render(
      <WorkspaceContextBar area="Dashboard" activeView="Overview" onSelect={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("follows the page theme instead of staying charcoal under the violet band", () => {
    const { container } = render(
      <WorkspaceContextBar area="Agents" activeView="Agents" onSelect={() => undefined} />,
    );
    expect(container.firstElementChild?.className).toContain("workspace-header__sections");

    expect(stylesheet).toContain(".workspace-header__sections,\n.workspace-header__account");
    expect(stylesheet).toContain("background: rgb(var(--surface-rgb))");
    expect(stylesheet).toContain("[data-theme=\"light\"] .workspace-header__sections");
    expect(stylesheet).not.toContain("background: rgb(20 20 24)");
    expect(stylesheet).toContain(".workspace-header:has(.workspace-header__sections)");
    expect(stylesheet).toContain("margin-bottom: 24px");
    // Locked workspaces match the 12px dock stack rather than the 24px
    // default or a 32px title gutter.
    expect(stylesheet).toContain(".workspace-page");
    expect(stylesheet).toContain("--workspace-inline: 12px");
    expect(stylesheet).toContain("margin-bottom: 12px");
  });
});
