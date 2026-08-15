/** @vitest-environment jsdom */
import type { PlatformUpdateActivity } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformUpdateActivity } from "./api.js";
import { PlatformUpdateActivityPanel, sinceLabel, transitionLabel } from "./platform-update-activity.js";

const COMMIT = "3f6a1c9d20b74e5a8c1d0f2b7e4a9c6d5b8e0134";
const RUN_ID = "6b1f0a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";
const NOW = new Date("2026-08-15T20:00:00.000Z");

vi.mock("./api.js", () => ({ getPlatformUpdateActivity: vi.fn() }));
const read = vi.mocked(getPlatformUpdateActivity);

const run = (over: Partial<NonNullable<PlatformUpdateActivity["latest"]>> = {}) => ({
  id: RUN_ID,
  phase: "healthy" as const,
  detail: "this deployment is running v5.6.2",
  targetVersion: "v5.6.2",
  targetCommit: COMMIT,
  installedVersion: "v5.6.2",
  installedCommit: COMMIT,
  rollback: null,
  log: "--- install-20260815T195500Z.log\nSTEP apply migrations\nSTEP verify readiness\n",
  logTruncated: false,
  startedAt: "2026-08-15T19:50:00.000Z",
  apiUnavailableUntil: null,
  completedAt: "2026-08-15T19:58:00.000Z",
  recordedAt: "2026-08-15T19:58:00.000Z",
  ...over,
});

const activity = (over: Partial<PlatformUpdateActivity> = {}): PlatformUpdateActivity => ({
  agent: {
    phase: "healthy", detail: "this deployment is running v5.6.2",
    installedVersion: "v5.6.2", installedCommit: COMMIT,
    currentRunId: RUN_ID, checkedAt: "2026-08-15T19:58:00.000Z",
  },
  latest: run(),
  recent: [],
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  read.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("update activity", () => {
  it("says an approval will not be applied when no agent has reported", async () => {
    read.mockResolvedValue(activity({ agent: null, latest: null }));

    render(<PlatformUpdateActivityPanel refreshToken={0} />);

    // The operator's next move, not just the diagnosis. This is the state a VM1
    // installed before the agent existed is in, and it is the reason an approval
    // there appears to do nothing at all.
    expect(await screen.findByText(/No update agent has reported/)).toBeTruthy();
    expect(screen.getByText(/v5\.6\.0/)).toBeTruthy();
  });

  it("reports a completed upgrade and the release it reached", async () => {
    read.mockResolvedValue(activity());

    render(<PlatformUpdateActivityPanel refreshToken={0} />);

    expect(await screen.findByText("Update applied")).toBeTruthy();
    expect(screen.getByText("Now running v5.6.2")).toBeTruthy();
  });

  it("keeps the installer log behind a control and then shows it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    read.mockResolvedValue(activity());

    render(<PlatformUpdateActivityPanel refreshToken={0} />);
    const toggle = await screen.findByRole("button", { name: "Show installer log" });
    expect(screen.queryByText(/STEP apply migrations/)).toBeNull();

    await user.click(toggle);

    expect(screen.getByText(/STEP apply migrations/)).toBeTruthy();
  });

  it("offers no log control for a run that recorded none", async () => {
    read.mockResolvedValue(activity({ latest: run({ log: null }) }));

    render(<PlatformUpdateActivityPanel refreshToken={0} />);

    const toggle = await screen.findByRole("button", { name: "No installer log recorded" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });

  /*
   * The run an operator opens this screen for. "rolled-back" is the agent's
   * word and it understates the outcome on a scanned line, so the heading says
   * what actually happened: the target was not applied and the machine is on
   * the release it started from.
   */
  it("says a rolled-back upgrade did not happen, and what is running instead", async () => {
    read.mockResolvedValue(activity({
      agent: { ...activity().agent!, phase: "rolled-back" },
      latest: run({
        phase: "rolled-back",
        detail: "the upgrade failed (installer exit 1); this deployment was restored and is serving",
        installedVersion: "v5.6.1",
        rollback: "install.sh: rolled-back",
      }),
    }));

    render(<PlatformUpdateActivityPanel refreshToken={0} />);

    expect(await screen.findByText("Rolled back")).toBeTruthy();
    expect(screen.getByText("v5.6.2 was not applied; running v5.6.1")).toBeTruthy();
    expect(screen.getByText(/install\.sh: rolled-back/)).toBeTruthy();
  });

  /*
   * The window this feature cannot cover: the API being replaced is the API this
   * panel asks. Saying "expected until 20:30" is the difference between a
   * restart and a stall, and the agent writes that moment down before it takes
   * anything down for exactly this reason.
   */
  it("tells a restart from a stall while the control plane is being replaced", async () => {
    read.mockResolvedValueOnce(activity({
      latest: run({
        phase: "upgrading",
        detail: "moving v5.6.1 to v5.6.2",
        completedAt: null,
        apiUnavailableUntil: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
      }),
    }));
    read.mockRejectedValue(new Error("Failed to fetch"));

    render(<PlatformUpdateActivityPanel refreshToken={0} />);
    expect(await screen.findByText("Upgrading")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(10_000);

    await waitFor(() => expect(screen.getByText(/cannot reach it/)).toBeTruthy());
  });

  it("stops polling once a run has reached a terminal phase", async () => {
    read.mockResolvedValue(activity());

    render(<PlatformUpdateActivityPanel refreshToken={0} />);
    await screen.findByText("Update applied");
    const afterFirstRead = read.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);

    // A tab left open on a settled deployment must not talk to the control
    // plane forever to be told nothing changed; the agent's own timer is ten
    // minutes, so there is nothing to see between ticks anyway.
    expect(read.mock.calls.length).toBe(afterFirstRead);
  });

  it("renders nothing at all before the first read returns", () => {
    read.mockReturnValue(new Promise(() => undefined));

    const { container } = render(<PlatformUpdateActivityPanel refreshToken={0} />);

    expect(container.textContent).toBe("");
  });

  /*
   * The way to look at this panel without a signed-in session and a VM1 that
   * has actually rolled an upgrade back. `UPDATE_ACTIVITY_PREVIEW_OUT` writes
   * the rendered markup; pair it with the stylesheet from
   * `pnpm --filter @orcasynapse/web build` and serve it from apps/web/public.
   *
   * It hangs off a real case rather than living in a scratch file, so it is run
   * by the suite and cannot rot. The rolled-back run with its log open is the
   * state worth looking at: the longest copy, the widest content, and the one
   * an operator reads under pressure.
   */
  it("renders a rolled-back run with its log open", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    read.mockResolvedValue(activity({
      agent: { ...activity().agent!, phase: "rolled-back" },
      latest: run({
        phase: "rolled-back",
        detail: "the upgrade failed (installer exit 1); this deployment was restored and is serving",
        installedVersion: "v5.6.1",
        rollback: "install.sh: rolled-back",
        log: [
          "--- install-20260815T195012Z.log",
          "STEP 1/6 Verify the host meets the deployment floor",
          "STEP 2/6 Back the database up before migrating",
          "  dump written to /opt/orcasynapse/.local/backups/pre-upgrade-20260815T195014Z.sql.gz",
          "STEP 3/6 Bring the stack up at v5.6.2",
          "STEP 4/6 Apply migrations",
          "FAIL Apply migrations - output tail:",
          "  error: relation \"AgentProfileVersion\" already exists",
          "  migration 0006_wandering_madrox.sql exited 1",
          "--- install-20260815T195231Z.log",
          "STEP 1/6 Restore the database recorded before the upgrade",
          "STEP 2/6 Reinstall v5.6.1 from the recorded commit",
          "STEP 6/6 ORCASYNAPSE IS READY (v5.6.1)",
        ].join("\n"),
      }),
    }));

    render(<PlatformUpdateActivityPanel refreshToken={0} />);
    await user.click(await screen.findByRole("button", { name: "Show installer log" }));

    expect(screen.getByText(/already exists/)).toBeTruthy();

    if (process.env.UPDATE_ACTIVITY_PREVIEW_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.UPDATE_ACTIVITY_PREVIEW_OUT, document.body.innerHTML, "utf8");
    }
  });
});

describe("activity labels", () => {
  it("ages the agent's last check in whole units", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

    expect(sinceLabel(at(30_000), NOW.getTime())).toBe("just now");
    expect(sinceLabel(at(60_000), NOW.getTime())).toBe("1 minute ago");
    expect(sinceLabel(at(45 * 60_000), NOW.getTime())).toBe("45 minutes ago");
    expect(sinceLabel(at(2 * 3_600_000), NOW.getTime())).toBe("2 hours ago");
    expect(sinceLabel(at(3 * 86_400_000), NOW.getTime())).toBe("3 days ago");
  });

  it("falls back to a short commit when a run names no version", () => {
    expect(transitionLabel(run({ phase: "upgrading", targetVersion: null, installedVersion: null })))
      .toBe(`${COMMIT.slice(0, 12)} → ${COMMIT.slice(0, 12)}`);
  });
});
