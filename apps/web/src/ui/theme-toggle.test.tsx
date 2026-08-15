// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "../theme.js";
import { ThemeToggle } from "./theme-toggle.js";

afterEach(() => {
  cleanup();
  applyTheme("dark");
});

describe("ThemeToggle", () => {
  it("uses one sun and moon switch for both application themes", async () => {
    const user = userEvent.setup();
    const { container } = render(<ThemeToggle />);
    const toggle = screen.getByRole("switch", { name: "Light appearance" });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("data-mode")).toBe("dark");
    expect(container.querySelector(".theme-toggle__moon svg")).toBeTruthy();
    expect(container.querySelector(".theme-toggle__sun svg")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bDark\b/);
    expect(container.textContent).not.toMatch(/\bLight\b/);

    await user.click(toggle);

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("data-mode")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("supports the fixed-violet brand surface without duplicating the control", () => {
    render(<ThemeToggle tone="brand" />);
    expect(screen.getByRole("switch").classList.contains("theme-toggle--brand")).toBe(true);
  });
});
