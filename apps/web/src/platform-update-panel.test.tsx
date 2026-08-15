/** @vitest-environment jsdom */
import type { PlatformUpdate } from "@orcasynapse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveReleaseTarget, clearReleaseTarget, getPlatformUpdate } from "./api.js";
import { PlatformUpdatePanel } from "./platform-update-panel.js";

const COMMIT = "3f6a1c9d20b74e5a8c1d0f2b7e4a9c6d5b8e0134";

const update: PlatformUpdate = {
  currentVersion: "v4.8.2",
  latestVersion: "v4.8.3",
  updateAvailable: true,
  releaseUrl: "https://github.com/multichainerz/AI/tree/v4.8.3",
  updateCommand: "curl installer | sudo ORCASYNAPSE_REF=v4.8.3 bash",
  automaticUpdateSupported: false,
  automaticUpdateReason: "The dashboard has no host control.",
  checkedAt: "2026-08-15T12:00:00.000Z",
  target: null,
};

const approved: PlatformUpdate["target"] = {
  desiredVersion: "v4.8.3",
  desiredCommit: COMMIT,
  approvedBy: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  approvedBySubject: "platform-admin",
  approvedAt: "2026-08-15T12:00:00.000Z",
  revision: 1,
};

vi.mock("./api.js", () => ({
  getPlatformUpdate: vi.fn(async () => update),
  // Null agent: this file is about the check and the approval, and a deployment
  // with no agent is the state these cases were written against. The agent's own
  // reporting has its own file.
  getPlatformUpdateActivity: vi.fn(async () => ({ agent: null, latest: null, recent: [] })),
  approveReleaseTarget: vi.fn(async () => approved),
  clearReleaseTarget: vi.fn(async () => undefined),
}));

const checked = vi.mocked(getPlatformUpdate);
const approve = vi.mocked(approveReleaseTarget);
const withdraw = vi.mocked(clearReleaseTarget);

/*
 * Re-established per test rather than only in the mock factory: clearAllMocks
 * resets the recorded calls but keeps a `mockResolvedValue` an earlier test
 * installed, so one test's stored target leaked into the next and hid the
 * Approve button there.
 */
beforeEach(() => {
  checked.mockResolvedValue(update);
  approve.mockResolvedValue(approved);
  withdraw.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PlatformUpdatePanel", () => {
  it("checks for a release only when the operator asks", async () => {
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);

    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(checked).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("v4.8.3 is ready to install")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy update command" })).toBeTruthy();
  });

  it("approves the checked release against the revision the operator was shown", async () => {
    checked.mockResolvedValueOnce(update).mockResolvedValueOnce({ ...update, target: approved });
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    await user.click(await screen.findByRole("button", { name: "Approve v4.8.3" }));

    expect(approve).toHaveBeenCalledWith({ desiredVersion: "v4.8.3", expectedRevision: 0 });
    expect(await screen.findByText(/v4\.8\.3 is approved/)).toBeTruthy();
    expect(screen.getByText(/platform-admin/)).toBeTruthy();
    expect(screen.getByText(/Aug 15, 2026/)).toBeTruthy();
    // The pinned commit, not just the tag: it is what a host agent will apply.
    expect(screen.getByText(COMMIT)).toBeTruthy();
  });

  it("keeps saying the host reads the approval rather than being pushed to", async () => {
    /*
     * The boundary is load-bearing and unchanged: the container has no
     * host-root or Docker control, and the host agent works precisely because
     * it pulls the approval rather than receiving anything.
     *
     * What this case no longer requires is "Recorded, not applied — the upgrade
     * still runs on VM1 with the command above". That sentence sat immediately
     * before one saying the hosts read the record and apply it themselves, so
     * the panel contradicted itself in consecutive lines for several releases
     * after the agent shipped. A test asserting the wrong half is what kept it
     * there, which is why this comment is longer than the assertion.
     */
    checked.mockResolvedValue({ ...update, target: approved });
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText(/read this record themselves/)).toBeTruthy();
    expect(screen.getByText(/nothing is ever pushed to them from the browser/)).toBeTruthy();
    expect(screen.queryByText(/Recorded, not applied/)).toBeNull();
    expect(screen.getByText("The dashboard has no host control.")).toBeTruthy();
  });

  /*
   * `automaticUpdateSupported` decides how loud the shell command is. When this
   * deployment can apply an approval itself, a `primary` "Copy update command"
   * is the most prominent control on the screen -- next to the approve button
   * that has already made it unnecessary -- which is what sent an operator
   * looking for a shell they no longer needed.
   */
  it("demotes the shell command once this deployment can apply an approval itself", async () => {
    checked.mockResolvedValue({ ...update, automaticUpdateSupported: true });
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText(/the agent on VM1 applies it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy update command/ }).className).not.toContain("bg-accent-fill");
  });

  it("keeps the shell command prominent when nothing on the host would apply it", async () => {
    checked.mockResolvedValue({ ...update, automaticUpdateSupported: false });
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText(/Run the pinned command on VM1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy update command/ }).className).toContain("bg-accent-fill");
  });

  it("shows a target approved in an earlier session on the first check after a reload", async () => {
    // Nothing is remembered in the component; a fresh panel gets the target
    // from the same fetch that answers the release question.
    checked.mockResolvedValue({ ...update, target: approved });
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText(/v4\.8\.3 is approved/)).toBeTruthy();
    // Already the target, so there is nothing left to approve.
    expect(screen.queryByRole("button", { name: "Approve v4.8.3" })).toBeNull();
  });

  it("withdraws an approved target without re-checking the release", async () => {
    checked
      .mockResolvedValueOnce({ ...update, target: approved })
      .mockResolvedValueOnce(update);
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    await user.click(await screen.findByRole("button", { name: "Withdraw approval" }));

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Approve v4.8.3" })).toBeTruthy();
  });

  it("shows the target but no approval controls to a session without the scope", async () => {
    /*
     * A release newer than the approved target, so this state offers both an
     * Approve and a Withdraw button to a session that holds the scope. The
     * second half of the test renders exactly that, because an absence
     * assertion over a state that could never have produced the buttons is an
     * assertion that cannot fail.
     */
    checked.mockResolvedValue({ ...update, latestVersion: "v4.8.4", target: approved });
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove={false} />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText(/v4\.8\.3 is approved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve v4.8.4" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw approval" })).toBeNull();

    cleanup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByRole("button", { name: "Approve v4.8.4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Withdraw approval" })).toBeTruthy();
  });

  it("reports a refused approval without losing the release the operator checked", async () => {
    approve.mockRejectedValueOnce(new Error("v4.8.1 is older than the installed v4.8.2."));
    const user = userEvent.setup();
    render(<PlatformUpdatePanel currentVersion="v4.8.2" canApprove />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    await user.click(await screen.findByRole("button", { name: "Approve v4.8.3" }));

    expect(await screen.findByText("v4.8.1 is older than the installed v4.8.2.")).toBeTruthy();
    expect(screen.getByText("v4.8.3 is ready to install")).toBeTruthy();
  });
});
