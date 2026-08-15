/**
 * @vitest-environment jsdom
 *
 * The entrance is deliberately small, but it carries the brand while session
 * restoration decides which real surface follows. Pin the visible identity,
 * status contract, and decorative boundaries so a loading refactor cannot
 * silently return to an anonymous spinner or expose the SVG to assistive tech.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationBootScreen } from "./app.js";

afterEach(cleanup);

describe("application boot screen", () => {
  it("identifies OrcaSynapse while the intelligence fabric initializes", () => {
    const { container } = render(<ApplicationBootScreen />);
    const screenRoot = container.querySelector(".app-boot-screen");

    expect(screenRoot?.getAttribute("aria-busy")).toBe("true");
    expect(screenRoot?.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("OrcaSynapse")).toBeTruthy();
    expect(screen.getByText("Private agentic intelligence")).toBeTruthy();
    expect(screen.getByText("Initializing the intelligence fabric")).toBeTruthy();
  });

  it("keeps both the synapse field and orbital decoration out of the accessibility tree", () => {
    const { container } = render(<ApplicationBootScreen />);

    expect(container.querySelector("canvas.dot-grid-field--boot")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".app-boot-orbit")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".app-boot-progress")?.getAttribute("aria-hidden")).toBe("true");
  });
});
