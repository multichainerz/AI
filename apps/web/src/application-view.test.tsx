/**
 * @vitest-environment jsdom
 *
 * Settings → System. The update check used to sit inside Setup, between
 * "enroll the agent runtime" and "record activation", where it read as a step
 * toward finishing an installation rather than as maintenance that outlives
 * one. These cases pin that it moved intact and that it is governed like every
 * other admin screen.
 */
import type { AdministratorSession } from "@orcasynapse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationView } from "./application-view.js";

afterEach(cleanup);

const session = { role: "PLATFORM_ADMIN", scopes: [], passwordChangeRequired: false } as unknown as AdministratorSession;

function view(overrides: Partial<Parameters<typeof ApplicationView>[0]> = {}) {
  return {
    session,
    currentVersion: "3.19.0",
    onConfigure: vi.fn(),
    ...overrides,
  };
}

describe("the System tab", () => {
  it("hosts the update check that used to interrupt setup", () => {
    render(<ApplicationView {...view()} />);

    expect(screen.getByRole("heading", { name: "System" })).toBeTruthy();
    expect(screen.getByText("OrcaSynapse 3.19.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  });

  it("locks against a session that may not call admin routes", async () => {
    // Same rule as every other governed screen: a session still owing a forced
    // password change is refused by the API, so it must be refused here too.
    const onConfigure = vi.fn();
    const user = userEvent.setup();
    render(<ApplicationView {...view({
      session: { ...session, passwordChangeRequired: true } as AdministratorSession,
      onConfigure,
    })} />);

    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onConfigure).toHaveBeenCalled();
  });

  it("renders no inline style, which the CSP would refuse in the built container", () => {
    render(<ApplicationView {...view()} />);
    expect(screen.getByRole("heading", { name: "System" })).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
