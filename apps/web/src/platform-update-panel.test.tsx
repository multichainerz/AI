/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformUpdatePanel } from "./platform-update-panel.js";

vi.mock("./api.js", () => ({
  getPlatformUpdate: vi.fn(async () => ({
    currentVersion: "v4.8.2",
    latestVersion: "ai-v3.18.3",
    updateAvailable: true,
    releaseUrl: "https://github.com/multichainerz/AI/tree/ai-v3.18.3",
    updateCommand: "curl installer | sudo ORCASYNAPSE_REF=ai-v3.18.3 bash",
    automaticUpdateSupported: false,
    automaticUpdateReason: "The dashboard has no host control.",
    checkedAt: "2026-08-14T00:00:00.000Z",
  })),
}));

afterEach(() => vi.clearAllMocks());

describe("PlatformUpdatePanel", () => {
  it("checks for a release only when the operator asks", async () => {
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" />);

    expect(screen.getByText("Not checked")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("ai-v3.18.3 is ready to install")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy update command" })).toBeTruthy();
  });
});
