/**
 * @vitest-environment jsdom
 *
 * The three figures the Dashboard polls for, and the paths that have to carry
 * them.
 *
 * `setChatMetrics` was called from six places; `setAgentMetrics` and
 * `setToolMetrics` from exactly one each, inside the mount-time session restore
 * that returns early when `getAdministratorSession` rejects. So an operator who
 * signed in *inside* the app rather than arriving with a live cookie saw Tool
 * calls, Tools live, Awaiting approval, Denied and all four run-pipeline rows
 * as em dashes until they pressed F5 — and even in the good case those figures
 * were frozen at page-load values while every figure beside them refreshed.
 *
 * These cases hold the wiring rather than the rendering: the shell is the only
 * thing that knows where a metric is fetched, and no view test can see it.
 */
import type {
  AdministratorSession,
  AgentMetrics,
  AgentRuntimeControl,
  ChatMetrics,
  ConnectionMonitoringControl,
  PlatformMeta,
  ToolMetrics,
} from "@orcasynapse/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPlatformMeta: vi.fn(),
  getAdministratorSession: vi.fn(),
  getEnterpriseSession: vi.fn(),
  getConnections: vi.fn(),
  getConnectionMonitoring: vi.fn(),
  getChatMetrics: vi.fn(),
  getAgentMetrics: vi.fn(),
  getToolMetrics: vi.fn(),
  getAgentRuntime: vi.fn(),
  getAgentProfiles: vi.fn(),
  getHermesRuntimeNodes: vi.fn(),
  getGatewayUsage: vi.fn(),
  getAgentRuns: vi.fn(),
  getOperationalIncidents: vi.fn(),
  createLocalAdministratorSession: vi.fn(),
  createLocalPersonSession: vi.fn(),
  revokeAdministratorSession: vi.fn(),
  revokeEnterpriseSession: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, ...api };
});

const { default: App } = await import("./app.js");

const session = {
  role: "PLATFORM_ADMIN",
  scopes: [],
  passwordChangeRequired: false,
} as unknown as AdministratorSession;

const chatMetrics = {
  windowStartedAt: "2026-08-14T09:00:00.000Z",
  conversations: 4,
  responses: 12,
  completed: 12,
  failed: 0,
  cancelled: 0,
  totalTokens: 900,
  averageLatencyMs: 1_200,
  failureRate: 0,
  feedback: { helpful: 0, notHelpful: 0 },
} as ChatMetrics;

const agentMetrics = (completedRuns: number) => ({
  profiles: 2, activeProfiles: 1, queuedRuns: 0, runningRuns: 0, completedRuns, failedRuns: 0,
}) as AgentMetrics;

/*
 * The sentinel figure is `pendingApprovals`: it is the one tool metric the
 * Dashboard still draws as a number (the Awaiting approval cell), so it is the
 * one that can prove a fetched answer reached a pixel.
 */
const toolMetrics = (pendingApprovals: number) => ({
  activeTools: 6, activeGrants: 3, pendingApprovals,
  executingCalls: 0, completedCalls: 940, deniedCalls: 0, failedCalls: 0,
}) as ToolMetrics;

/**
 * A signed-in reload, as opposed to a sign-in.
 *
 * The distinction is the whole defect: `getAdministratorSession` resolving at
 * mount is the one path that ever loaded these two figures.
 */
function arriveWithASession() {
  api.getAdministratorSession.mockResolvedValue(session);
}

/** No cookie at all, so the front page renders and credentials are required. */
function arriveSignedOut() {
  api.getAdministratorSession.mockRejectedValue(new Error("no session"));
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getPlatformMeta.mockResolvedValue({ bootstrapState: "READY", version: "5.1.0" } as PlatformMeta);
  api.getEnterpriseSession.mockRejectedValue(new Error("no enterprise session"));
  api.getConnections.mockResolvedValue({ items: [] });
  api.getConnectionMonitoring.mockResolvedValue({
    enabled: true, intervalSeconds: 300, reason: null, updatedAt: "2026-08-15T00:00:00.000Z", updatedBy: null,
  } as ConnectionMonitoringControl);
  api.getChatMetrics.mockResolvedValue(chatMetrics);
  api.getAgentMetrics.mockResolvedValue(agentMetrics(7));
  api.getToolMetrics.mockResolvedValue(toolMetrics(8_431));
  api.getAgentRuntime.mockResolvedValue({ enabled: false } as AgentRuntimeControl);
  api.getAgentProfiles.mockResolvedValue({ items: [] });
  api.getHermesRuntimeNodes.mockResolvedValue({ items: [] });
  // The Dashboard's own reads, pending on purpose: these cases are about the
  // three metric scalars the shell wires, not the panels HomeView fetches.
  api.getGatewayUsage.mockReturnValue(new Promise(() => undefined));
  api.getAgentRuns.mockReturnValue(new Promise(() => undefined));
  api.getOperationalIncidents.mockReturnValue(new Promise(() => undefined));
  api.revokeAdministratorSession.mockResolvedValue(undefined);
  api.revokeEnterpriseSession.mockResolvedValue(undefined);
  /*
   * Reduced motion shortens the deliberate brand beat from 1.4 s to 240 ms.
   * The boot screen is a real gate — nothing else renders until it clears — so
   * every case here waits it out rather than mocking it away.
   */
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"), media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Dashboard's operational figures", () => {
  it("loads the tool and agent figures for an operator who signs in inside the app", async () => {
    /*
     * The reported symptom, reproduced end to end: no cookie, sign in on the
     * front page, and the whole right-hand column of the Dashboard stays blank
     * until a manual reload puts the mount-time restore back on the happy path.
     */
    arriveSignedOut();
    api.createLocalAdministratorSession.mockResolvedValue(session);
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeTruthy(), { timeout: 3_000 });
    // Nothing has been signed in yet, so nothing may have been read yet — an
    // assertion that these were called later is worthless if they were already
    // called here.
    expect(api.getToolMetrics).not.toHaveBeenCalled();
    expect(api.getAgentMetrics).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Username"), "orca-admin");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /Sign in/ }));

    await waitFor(() => expect(api.getChatMetrics).toHaveBeenCalled());
    await waitFor(() => {
      expect(api.getAgentMetrics).toHaveBeenCalled();
      expect(api.getToolMetrics).toHaveBeenCalled();
    });
  });

  it("still draws them when a sign-in lands on a runtime read that hangs", async () => {
    /*
     * Why the sign-in path reads them itself rather than leaving it to the
     * fifteen-second reconciler: that reconciler gathers seven calls with
     * `Promise.all`, so a single unanswered one — `getAgentRuntime` is the one
     * that hangs when VM2 does — holds back every figure in the batch. The
     * metrics have no dependency on the runtime read and should not wait on it.
     */
    arriveSignedOut();
    api.createLocalAdministratorSession.mockResolvedValue(session);
    api.getAgentRuntime.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeTruthy(), { timeout: 3_000 });
    await user.type(screen.getByLabelText("Username"), "orca-admin");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /Sign in/ }));

    await waitFor(() => expect(screen.getByText("8,431")).toBeTruthy());
  });

  it("re-reads them on every poll instead of freezing them at page load", async () => {
    /*
     * The panel's own comment claims "every figure in this column already
     * arrived on each poll". Only the chat figures did: these two were written
     * once, at mount, and then held while the fifteen-second reconciler
     * refreshed everything beside them.
     */
    vi.useFakeTimers();
    arriveWithASession();
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const atLoad = api.getToolMetrics.mock.calls.length;
    expect(atLoad).toBeGreaterThan(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });

    expect(api.getToolMetrics.mock.calls.length).toBeGreaterThan(atLoad);
    expect(api.getAgentMetrics.mock.calls.length).toBeGreaterThan(atLoad);
  });

  it("draws the refreshed figures rather than the ones the page opened with", async () => {
    // The wiring assertions above prove the calls happen; this one proves the
    // answers reach a pixel, which is the claim an operator actually reads.
    vi.useFakeTimers();
    arriveWithASession();
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText("8,431")).toBeTruthy();

    // Swapped between the two reads rather than queued with `mockResolvedValueOnce`:
    // page load calls this twice (the session restore and the reconciler's first
    // pass), so a queued answer lands on a call this case is not about.
    api.getToolMetrics.mockResolvedValue(toolMetrics(8_500));
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(screen.getByText("8,500")).toBeTruthy();
    expect(screen.queryByText("8,431")).toBeNull();
  });

  it("does not carry one operator's figures into the next session", async () => {
    /*
     * Sign-out drops the chat figures and the connection list; these two used
     * to survive it, held in state that only the mount-time restore ever wrote.
     *
     * Asserted across a *second* sign-in rather than on the signed-out screen,
     * because signing out swaps the whole app to the front page: the Dashboard
     * is not rendered there, so "the number is gone" would be true of a
     * component that had cleared nothing at all. The second session's read is
     * left pending on purpose — the only figure that can reach the panel now is
     * one carried over from the first.
     */
    const user = userEvent.setup();
    arriveWithASession();
    api.createLocalAdministratorSession.mockResolvedValue(session);
    render(<App />);
    await waitFor(() => expect(screen.getByText("8,431")).toBeTruthy(), { timeout: 3_000 });

    // The account chip holds the only sign-out control there is.
    await user.click(screen.getByRole("button", { name: /System administrator/ }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByLabelText("Username")).toBeTruthy());

    api.getToolMetrics.mockReturnValue(new Promise(() => undefined));
    api.getAgentMetrics.mockReturnValue(new Promise(() => undefined));
    await user.type(screen.getByLabelText("Username"), "orca-admin");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /Sign in/ }));

    // Prove the panel is back before asserting what it does not say.
    await waitFor(() => expect(screen.getByLabelText("Deployment command panel")).toBeTruthy());
    expect(screen.queryByText("8,431")).toBeNull();
  });
});
