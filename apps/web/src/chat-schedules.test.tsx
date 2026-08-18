/**
 * @vitest-environment jsdom
 *
 * The panel that makes a stopped schedule visible.
 *
 * The dispatcher already refuses to fire for a disabled creator, an archived
 * conversation or a guardrail block, and stores why. Until something renders
 * that, a schedule which stopped a week ago is indistinguishable from one that
 * is simply not due yet — which is the whole failure mode this surface exists
 * to remove, and what most of these assertions are about.
 */
import type { ChatSchedule } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const CONVERSATION_ID = "8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e";

const base: ChatSchedule = {
  id: "c4f6f1f6-2a2f-4a71-9a1e-3b6d5c8e4a11",
  conversationId: CONVERSATION_ID,
  prompt: "Summarise overnight incidents.",
  intervalSeconds: 86_400,
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  lastRunAt: null,
  lastOutcome: null,
  lastDetail: null,
  enabled: true,
  createdBySubject: "local-admin:operator",
  revision: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

let items: ChatSchedule[] = [base];

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatSchedules: vi.fn(async () => ({ items })),
    createChatSchedule: vi.fn(async () => base),
    updateChatSchedule: vi.fn(async () => base),
    deleteChatSchedule: vi.fn(async () => undefined),
  };
});

const { ChatSchedules } = await import("./chat-schedules.js");
const { createChatSchedule, updateChatSchedule, deleteChatSchedule } = await import("./api.js");

afterEach(() => {
  cleanup();
  items = [base];
  vi.mocked(createChatSchedule).mockClear();
  vi.mocked(updateChatSchedule).mockClear();
  vi.mocked(deleteChatSchedule).mockClear();
});

async function panel() {
  render(<ChatSchedules conversationId={CONVERSATION_ID} />);
  await waitFor(() => screen.getByText("Summarise overnight incidents."));
}

describe("chat schedules", () => {
  it("says the turn runs as the operator and stops with their access", async () => {
    // The governance fact an operator has to know before creating one: this is
    // a standing grant of their own authority, not a system identity.
    await panel();

    expect(screen.getByText(/runs with your access, so it stops if your account is disabled/i)).toBeTruthy();
  });

  it("states that the first turn is one interval out", async () => {
    // Otherwise an operator waits on a turn that was never going to be
    // immediate, and concludes the feature is broken.
    await panel();

    expect(screen.getByText(/first turn runs one interval from now/i)).toBeTruthy();
  });

  it("creates a schedule from the prompt and cadence", async () => {
    await panel();
    await userEvent.type(screen.getByLabelText("Prompt"), "Daily rollup");
    await userEvent.selectOptions(screen.getByLabelText("How often"), "3600");

    await userEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    expect(vi.mocked(createChatSchedule)).toHaveBeenCalledWith(
      CONVERSATION_ID,
      { prompt: "Daily rollup", intervalSeconds: 3_600 },
    );
  });

  it("refuses to submit an empty prompt", async () => {
    await panel();

    expect(screen.getByRole("button", { name: "Add schedule" })).toHaveProperty("disabled", true);
  });

  it("shows a stopped schedule as stopped, never as due", async () => {
    /*
     * A disabled schedule still carries a `nextRunAt` — the claim moved it
     * forward before the failure was known — so rendering that field would
     * promise a turn that is not coming.
     */
    items = [{
      ...base,
      enabled: false,
      lastOutcome: "DISABLED",
      lastDetail: "local-admin:operator can no longer start conversations, so this schedule was disabled.",
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    }];
    await panel();

    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.queryByText(/^In \d/)).toBeNull();
    // And the reason, in the words the dispatcher stored.
    expect(screen.getByText(/can no longer start conversations/)).toBeTruthy();
  });

  it("distinguishes a skipped fire from a stopped schedule", async () => {
    // A rate-limited schedule is still armed and will retry; showing it the
    // same way as a disabled one would send an operator to fix nothing.
    items = [{ ...base, lastOutcome: "SKIPPED", lastDetail: "The chat request limit was reached." }];
    await panel();

    expect(screen.queryByText("Stopped")).toBeNull();
    expect(screen.getByText(/chat request limit/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("offers Resume on a stopped schedule and re-enables it", async () => {
    items = [{ ...base, enabled: false, lastOutcome: "DISABLED", lastDetail: "Blocked by rule." }];
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(vi.mocked(updateChatSchedule)).toHaveBeenCalledWith(base.id, { enabled: true });
  });

  it("deletes a schedule and stops showing it", async () => {
    /*
     * The Delete control was rendered and its API function was mocked, and no
     * case ever pressed it -- so the one destructive action in this panel was
     * the only one nothing pinned. It goes through the same `guard()` wrapper as
     * Resume, which is what refreshes the list afterwards.
     */
    await panel();
    items = [];

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(vi.mocked(deleteChatSchedule)).toHaveBeenCalledWith(base.id);
    await waitFor(() => expect(screen.queryByText("Summarise overnight incidents.")).toBeNull());
  });

  it("surfaces a refusal instead of leaving the row as though it had gone", async () => {
    // `guard()`'s error branch, which nothing rendered either. A delete that the
    // server refuses must say so; silently leaving the row is indistinguishable
    // from a delete that worked and a list that did not refresh.
    vi.mocked(deleteChatSchedule).mockRejectedValueOnce(new Error("The schedule is already gone."));
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText(/already gone/)).toBeTruthy());
  });

  it("names the cadence rather than the raw interval", async () => {
    await panel();

    const row = screen.getByText("Summarise overnight incidents.").closest("div")!.parentElement!;
    expect(within(row).getByText(/Daily/)).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await panel();

    expect(document.body.innerHTML).not.toMatch(/ style="/);
  });
});
