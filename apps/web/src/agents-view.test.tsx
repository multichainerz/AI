/**
 * @vitest-environment jsdom
 *
 * Profiles, populated. One screen for what an agent is, what it has done, and
 * whether it may run at all.
 *
 * Those three were briefly two screens: a Runtime tab held the kill switch, the
 * counters and the execution ledger, and `agent-runtime-view.test.tsx` covered
 * them there. Its assertions live here now, beside the configuration ones,
 * because they describe one workflow -- and the tests that matter most are the
 * ones no per-half file could have written: that selecting a Profile scopes the
 * ledger to the runs it produced, and that the boundary's fix is on this screen
 * rather than behind a cross-tab button.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so it can be looked at without
 * a session; see `chat-transcript.test.tsx`.
 */
import { ADMIN_SCOPES } from "@orcasynapse/contracts";
import type {
  AdminScope, AdministratorSession, AgentProfile, AgentRun, AgentRunEvent,
} from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const version = {
  version: 3,
  displayName: "Support analyst",
  purpose: "Helps operators reason about their controlled environment.",
  instructions: "Be precise and state uncertainty.",
  soulMd: "Careful, evidence-led, candid about uncertainty.",
  skills: [],
  modelAlias: "hermes-agent",
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  distributionDigest: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6",
};

const profiles = [
  { id: "p1", slug: "support-analyst", status: "ACTIVE", activeVersion: 3, version },
  {
    id: "p2", slug: "draft-agent", status: "DRAFT", activeVersion: null,
    version: { ...version, version: 1, displayName: "Draft agent", purpose: "Not yet verified against Hermes." },
  },
] as unknown as AgentProfile[];

/** Newest first, as `listRuns` returns them. Two Profiles, so scoping is visible. */
const runs = [
  {
    id: "r1", profileId: "p1", profileName: "Support analyst", profileSlug: "support-analyst", profileVersion: 3,
    status: "COMPLETED", input: "What should we check before promoting?", output: "Three things: migrations, runtime, signature.",
    createdAt: "2026-08-07T09:00:00.000Z", queuedAt: "2026-08-07T09:00:00.000Z", updatedAt: "2026-08-07T09:00:06.000Z",
    startedAt: "2026-08-07T09:00:01.000Z", completedAt: "2026-08-07T09:00:06.000Z",
    profileDistributionDigest: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6", failureCode: null, failureMessage: null,
  },
  {
    id: "r2", profileId: "p2", profileName: "Draft agent", profileSlug: "draft-agent", profileVersion: 1,
    status: "COMPLETED", input: "Summarise the enrolment runbook.", output: "Four stages, two of them manual.",
    createdAt: "2026-08-06T09:00:00.000Z", queuedAt: "2026-08-06T09:00:00.000Z", updatedAt: "2026-08-06T09:00:04.000Z",
    startedAt: "2026-08-06T09:00:01.000Z", completedAt: "2026-08-06T09:00:04.000Z",
    profileDistributionDigest: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6", failureCode: null, failureMessage: null,
  },
] as unknown as AgentRun[];

/** Something to press Cancel on. The fixture runs above are all terminal. */
const runningRun = {
  ...runs[0]!, id: "r3", status: "RUNNING", output: null, completedAt: null,
} as unknown as AgentRun;

function sessionWith(role: AdministratorSession["role"], scopes: AdminScope[]): AdministratorSession {
  return {
    id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "admin", role, scopes,
    createdAt: "2026-08-07T00:00:00.000Z",
    idleExpiresAt: "2026-08-07T00:15:00.000Z", absoluteExpiresAt: "2026-08-07T08:00:00.000Z",
  };
}

/*
 * The agent-relevant slice of `ROLE_SCOPES` in
 * `apps/api/src/auth/admin-session.ts`, copied rather than derived: these
 * tests are about what this screen offers a role the API has already decided
 * about, so the two files disagreeing is the thing worth catching.
 */
const auditor = sessionWith("AUDITOR", ["agents:read"]);
const operations = sessionWith("OPERATIONS_ADMIN", ["agents:read", "agents:control", "readiness:manage"]);
const platform = sessionWith("PLATFORM_ADMIN", [...ADMIN_SCOPES]);

const events = [
  { id: "e1", type: "RUN_STARTED", summary: null, toolName: null, childSessionId: null, status: null, occurredAt: "2026-08-07T09:00:01.000Z", durationMs: null, inputTokens: null, outputTokens: null },
  { id: "e2", type: "RUN_COMPLETED", summary: "Answered from one source.", toolName: null, childSessionId: null, status: null, occurredAt: "2026-08-07T09:00:06.000Z", durationMs: 5_100, inputTokens: 880, outputTokens: 260 },
] as unknown as AgentRunEvent[];

const api = vi.hoisted(() => ({
  getAgentProfiles: vi.fn(),
  getAgentRuns: vi.fn(),
  getAgentRunEvents: vi.fn(),
  getAgentRuntime: vi.fn(),
  getAgentMetrics: vi.fn(),
  getConnections: vi.fn(),
  updateAgentRuntime: vi.fn(),
  cancelAgentRun: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { AgentsView } = await import("./agents-view.js");
/* Real: the mock factory spreads the real module, so this is the same class
   `agents-view.tsx` narrows against when it decides a 401 ended the session. */
const { OrcaSynapseApiError } = await import("./api.js");

const props = {
  unlocked: true,
  administrator: true,
  activationReady: true as boolean | null,
  activationMessage: null as string | null,
  oidcConfigured: false,
  onSignIn: vi.fn(),
  onConfigure: vi.fn(),
  onOpenChat: vi.fn(),
  onOpenReadiness: vi.fn(),
  onSessionExpired: vi.fn(),
};

interface ApiState {
  profiles?: AgentProfile[];
  runs?: AgentRun[];
  enabled?: boolean;
  metrics?: Partial<{ queuedRuns: number; runningRuns: number; completedRuns: number; failedRuns: number }>;
}

function setupApi({ profiles: profileList = profiles, runs: runList = runs, enabled = true, metrics = {} }: ApiState = {}) {
  api.getAgentProfiles.mockResolvedValue({ items: profileList });
  api.getAgentRuns.mockResolvedValue({ items: runList });
  api.getAgentRunEvents.mockResolvedValue({ items: events });
  api.getAgentRuntime.mockResolvedValue({ enabled, reason: "Verified against Hermes on node vm2-a." });
  api.getAgentMetrics.mockResolvedValue({
    profiles: profileList.length,
    activeProfiles: profileList.filter(({ status }) => status === "ACTIVE").length,
    queuedRuns: 0, runningRuns: 0, completedRuns: runList.length, failedRuns: 0,
    ...metrics,
  });
  api.getConnections.mockResolvedValue({ items: [] });
  api.updateAgentRuntime.mockResolvedValue({ enabled: !enabled, reason: "Manual." });
}

/*
 * `session` is deliberately absent from `props` above: `app.tsx` does not pass
 * it yet, so leaving it off here is what keeps every other test in this file
 * covering the boolean fallback the product is still running on.
 */
async function view(over: Partial<typeof props> & { session?: AdministratorSession | null } = {}) {
  render(<main><AgentsView {...props} {...over} /></main>);
  await waitFor(() => screen.getByLabelText("Execution ledger"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

/** The boundary panel, addressed before anything is asserted about its contents. */
function boundary(): HTMLElement {
  return screen.getByLabelText("Hermes execution boundary");
}

function ledger(): HTMLElement {
  return screen.getByLabelText("Execution ledger");
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("agents", () => {
  it("carries the kill switch, stated as a word rather than only a colour", async () => {
    // An operator reaching for this is already dealing with a problem, and it
    // is on the Profiles screen because nothing in the list below can run while
    // it is off -- it frames that list rather than following from it.
    setupApi();
    await view();
    expect(within(boundary()).getByText("ON")).toBeTruthy();
    expect(within(boundary()).getByText("Hermes execution")).toBeTruthy();
    expect(within(boundary()).getByText("Ready for Chat")).toBeTruthy();
    expect(within(boundary()).getByText("Verified against Hermes on node vm2-a.")).toBeTruthy();
  });

  it("keeps the disabled boundary's fix on this screen instead of another tab", async () => {
    /*
     * The boundary turns itself on with the first verified Profile, so a
     * disabled one is a Profiles problem -- which is exactly why splitting the
     * two stranded the operator: the sentence naming the fix was on one tab and
     * the fix on another, joined by an "Open Profiles" button. Both are here.
     */
    setupApi({ enabled: false });
    await view();
    const panel = boundary();
    expect(within(panel).getByText("OFF")).toBeTruthy();
    expect(within(panel).getByText(/Verify & activate on a Profile below/)).toBeTruthy();
    // The cross-tab jump has nowhere left to go, and the control it pointed at
    // is on screen. Asserted in that order: the panel above is what makes the
    // absence below a real absence rather than a missing element.
    expect(within(panel).queryByRole("button", { name: "Open Profiles" })).toBeNull();
    expect(screen.getByRole("button", { name: "Verify & activate" })).toBeTruthy();
  });

  it("names the fix for an off boundary without repeating the button under it", async () => {
    /*
     * Both wordings point down the same screen, and neither carries a control:
     * with no Profiles the empty state below already offers creation and the
     * header offers it again, so a third identical button on the boundary was
     * three calls to action for one job. Naming the right one is the boundary's
     * whole contribution.
     */
    setupApi({ enabled: false, profiles: [], runs: [] });
    await view();
    expect(within(boundary()).getByText(/Create a Profile below/)).toBeTruthy();
    expect(within(boundary()).queryByRole("button", { name: /Create/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Create starter agent" })).toBeTruthy();

    cleanup();
    setupApi({ enabled: false });
    await view();
    expect(within(boundary()).getByText(/Verify & activate on a Profile below/)).toBeTruthy();
    expect(within(boundary()).queryByRole("button", { name: /Create|Verify/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Verify & activate" })).toBeTruthy();
  });

  it("counts runs deployment-wide, from the figures the API can actually back", async () => {
    /*
     * `AgentMetrics` reports no per-profile breakdown and the run list is capped
     * at the newest 200, so these are the only trustworthy totals on the screen
     * and they belong to the screen-wide control. `completedRuns` is set higher
     * than the visible window on purpose: a summary derived from the two loaded
     * runs would read 2 and would be wrong on any deployment with history.
     */
    setupApi({ metrics: { completedRuns: 41, failedRuns: 3 } });
    await view();
    const summary = within(boundary()).getByLabelText("Hermes run summary");
    expect(within(summary).getByText("Completed")).toBeTruthy();
    expect(within(summary).getByText("41")).toBeTruthy();
    expect(within(summary).getByText("Failed")).toBeTruthy();
    expect(within(summary).getByText("3")).toBeTruthy();
  });

  it("says nothing has run rather than drawing four zeroes", async () => {
    // The deployment this was designed against has one Profile and no runs, and
    // four zero tiles there are decoration.
    setupApi({ runs: [], metrics: { completedRuns: 0 }, profiles: [profiles[0]!] });
    await view();
    // The deployment this ships to has exactly one, which is the count no
    // "N profiles" template ever gets right by accident.
    expect(screen.getByText("1 profile")).toBeTruthy();
    const panel = boundary();
    expect(within(panel).getByText("Hermes execution")).toBeTruthy();
    expect(within(panel).queryByLabelText("Hermes run summary")).toBeNull();
    expect(within(panel).getByText(/No runs yet/)).toBeTruthy();
  });

  it("scopes the ledger to the Profile selected in the list", async () => {
    /*
     * The join the split could not express. Runs are produced *by* profiles;
     * a flat ledger under an unrelated list is the weakest way to put both on
     * one screen, and the list's selection had no job at all before this.
     */
    setupApi();
    const user = userEvent.setup();
    await view();
    expect(within(ledger()).getByText(/Produced by Support analyst/)).toBeTruthy();
    expect(within(ledger()).getByText("What should we check before promoting?")).toBeTruthy();
    expect(within(ledger()).queryByText("Summarise the enrolment runbook.")).toBeNull();

    await user.click(screen.getByText("Draft agent"));
    await waitFor(() => expect(within(ledger()).getByText(/Produced by Draft agent/)).toBeTruthy());
    expect(within(ledger()).getByText("Summarise the enrolment runbook.")).toBeTruthy();
    expect(within(ledger()).queryByText("What should we check before promoting?")).toBeNull();
  });

  it("offers the runs its own scoping hides, and nothing when it hides none", async () => {
    /*
     * A non-administrator's profile list holds only ACTIVE profiles while their
     * run list holds everything they started, so runs from a since-suspended
     * Profile would otherwise be unreachable. It is an escape hatch rather than
     * a permanent toggle: on a single-profile deployment it never appears.
     */
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.click(within(ledger()).getByRole("button", { name: "Show all runs (2)" }));

    await waitFor(() => expect(within(ledger()).getByText(/Across every Profile/)).toBeTruthy());
    expect(within(ledger()).getByText("Draft agent")).toBeTruthy();
    expect(within(ledger()).getByRole("button", { name: "Show only Support analyst" })).toBeTruthy();

    // Widening is a one-off answer to "where did my run go", not a mode. The
    // next Profile selected re-scopes, or the list would stop meaning anything
    // for whatever the operator did next.
    await user.click(screen.getAllByText("Draft agent")[0]!);
    await waitFor(() => expect(within(ledger()).getByText(/Produced by Draft agent/)).toBeTruthy());

    cleanup();
    setupApi({ profiles: [profiles[0]!], runs: [runs[0]!] });
    await view();
    expect(within(ledger()).getByText("What should we check before promoting?")).toBeTruthy();
    expect(within(ledger()).queryByRole("button", { name: /Show all runs/ })).toBeNull();
  });

  it("names the Profile in the empty ledger a fresh install actually sees", async () => {
    setupApi({ runs: [] });
    await view();
    expect(within(ledger()).getByText("Nothing has run under Support analyst")).toBeTruthy();
  });

  it("drops the detail pane entirely when there is nothing anywhere to select", async () => {
    /*
     * The deployment this was designed against has one Profile and no runs. A
     * second panel beside the empty ledger, inviting the operator to select one
     * of the nothing that exists, is the kind of scaffolding that makes a fresh
     * install look broken. It comes back the moment a run does.
     */
    setupApi({ runs: [] });
    await view();
    expect(ledger()).toBeTruthy();
    expect(screen.queryByLabelText("Run detail")).toBeNull();

    cleanup();
    setupApi();
    await view();
    expect(screen.getByLabelText("Run detail")).toBeTruthy();
  });

  it("opens a run's bounded activity timeline without leaving the screen", async () => {
    // A bounded list read as a complete one would make absent tool arguments
    // look like tool calls that never happened.
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.click(within(ledger()).getByText("What should we check before promoting?"));
    const timeline = await screen.findByLabelText("Safe Hermes activity timeline");
    expect(within(timeline).getByText(/never retained here/)).toBeTruthy();
  });

  it("tells each Profile row how much recent work it produced", async () => {
    // Window-scoped, and worded that way: the run list is the newest 200, so a
    // per-profile figure derived from it is not a lifetime total.
    setupApi();
    await view();
    expect(screen.getByText("2 profiles")).toBeTruthy();
    // One each, and singular -- the first render of this said "1 recent runs"
    // on both rows, which no assertion about a count would have caught.
    expect(screen.getAllByText("1 recent run")).toHaveLength(2);

    cleanup();
    // Two runs for the first Profile, none for the second: the plural, and the
    // row that produced nothing saying so rather than saying nothing.
    setupApi({ runs: [runs[0]!, { ...runs[0]!, id: "r3" }] });
    await view();
    expect(screen.getByText("2 recent runs")).toBeTruthy();
    expect(screen.getByText("no recent runs")).toBeTruthy();
  });

  it("shows the distribution digest on the row, since that is what VM2 admits", async () => {
    // Both profiles carry it, which is the point — it identifies the build,
    // not the profile.
    setupApi();
    await view();
    expect(screen.getAllByText(/distro 9f2c4a1b7e/)).toHaveLength(2);
  });

  it("offers Suspend on an active profile and verification on one that is not", async () => {
    setupApi();
    await view();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify & activate" })).toBeTruthy();
  });

  it("points at the tab that now owns Hermes memory", async () => {
    /*
     * The editor's memory note used to say "Agents → Hermes corpus", a tab
     * that no longer exists. A stale cross-reference in a form that governs an
     * agent is worse than none: it sends the operator looking for a screen and
     * leaves them assuming the capability went away with the label.
     */
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Agents → Memory");
    expect(dialog.textContent).not.toContain("Hermes corpus");
  });

  it("keeps drafting possible while telling the operator activation is not", async () => {
    setupApi();
    await view({ activationReady: false, activationMessage: "VM2 is not enrolled yet." });
    expect(screen.getByText("Profiles can be drafted now")).toBeTruthy();
    expect(screen.getByText("VM2 is not enrolled yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft" })).toBeTruthy();
  });

  it("traps focus in the profile editor, which decides what an agent may do", async () => {
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    for (let press = 0; press < 8; press += 1) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows an AUDITOR the screen and none of the controls that would 403", async () => {
    /*
     * `ROLE_SCOPES` gives AUDITOR `agents:read` and nothing else, and
     * navigation is unfiltered, so they reach this screen. Every write here was
     * gated on `administrator` -- which is `adminAccess(session).unlocked`, and
     * answers "may this session call admin routes at all" rather than which --
     * so every one of them rendered and every one of them 403'd.
     */
    setupApi({ runs: [runningRun] });
    await view({ session: auditor });
    // The reads they do hold, first, so the absences below are judgements
    // about the controls rather than about a screen that never rendered.
    expect(screen.getByText("2 profiles")).toBeTruthy();
    expect(screen.getByLabelText("Hermes execution boundary")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify & activate" })).toBeNull();
    // Inside a closed `<details>`, so it is in the tree if it is rendered at
    // all -- the disclosure hides nothing from this query.
    expect(screen.queryByRole("button", { name: /Disable execution|Enable manually/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("lets an OPERATIONS_ADMIN work the boundary without authoring a Profile", async () => {
    // `agents:control` and no `agents:manage`: the switch and Cancel are
    // theirs, and the API refuses every profile write.
    setupApi({ runs: [runningRun] });
    await view({ session: operations });
    expect(screen.getByRole("button", { name: "Disable execution" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify & activate" })).toBeNull();
  });

  it("takes nothing away from the role that holds every scope", async () => {
    // The other direction. Gating that hides a control from a PLATFORM_ADMIN
    // is the same defect wearing the opposite sign, and is the failure a
    // scope-derived boolean makes easy.
    setupApi({ runs: [runningRun] });
    await view({ session: platform });
    expect(screen.getByRole("button", { name: "Create agent" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New version" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify & activate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable execution" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });

  it("surfaces a failed Refresh instead of leaving stale profiles on screen", async () => {
    /*
     * The admin session idles out after fifteen minutes. Every other call site
     * in this file attaches `.catch(fail)`; Refresh did not, so its rejection
     * was unhandled -- no Alert, no `onSessionExpired`, and a screen still
     * showing the profiles and runs of a quarter of an hour ago.
     */
    setupApi();
    const user = userEvent.setup();
    await view();
    api.getAgentProfiles.mockRejectedValue(
      new OrcaSynapseApiError(401, "The administrator session has expired."),
    );

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("The administrator session has expired.")).toBeTruthy();
    expect(props.onSessionExpired).toHaveBeenCalled();
  });

  it("does not promise a boundary a non-administrator never sees", async () => {
    // The header described "the global boundary deciding whether any of it may
    // execute" on a screen whose boundary panel is administrator-only.
    setupApi();
    await view({ administrator: false });
    expect(screen.getByRole("heading", { name: "Hermes Profiles" })).toBeTruthy();
    expect(screen.queryByLabelText("Hermes execution boundary")).toBeNull();
    expect(screen.queryByText(/boundary deciding whether any of it may execute/)).toBeNull();

    cleanup();
    setupApi();
    await view();
    expect(screen.getByLabelText("Hermes execution boundary")).toBeTruthy();
    expect(screen.getByText(/boundary deciding whether any of it may execute/)).toBeTruthy();
  });

  it("says whose runs the per-profile counter counted", async () => {
    /*
     * `GET /agents/runs` returns a non-administrator their own runs, against a
     * Profile that belongs to the whole deployment. "no recent runs" beside a
     * Profile colleagues have run fifty times is a statement about the reader.
     */
    setupApi();
    await view({ administrator: false });
    expect(screen.getAllByText("1 recent run by you")).toHaveLength(2);

    cleanup();
    setupApi({ runs: [] });
    await view({ administrator: false });
    expect(screen.getAllByText("no recent runs by you")).toHaveLength(2);
  });

  it("says whose runs the ledger is showing", async () => {
    /*
     * `GET /admin/agents/runs` returns every run in the window; `GET
     * /agents/runs` filters to the calling subject. Both render this one
     * component with the same shape, so nothing but the copy distinguishes
     * them -- and "Across every Profile, newest first." over one person's runs
     * is a claim about the deployment the list cannot support. Same axis the
     * Profile rows above already qualify with "by you".
     */
    setupApi();
    const user = userEvent.setup();
    await view({ administrator: false });
    expect(within(ledger()).getByText("Your runs produced by Support analyst, newest first.")).toBeTruthy();

    // The widened view is the one that made the deployment-wide claim.
    await user.click(within(ledger()).getByRole("button", { name: "Show all runs (2)" }));
    await waitFor(() => expect(
      within(ledger()).getByText("Your runs across every Profile, newest first."),
    ).toBeTruthy());

    // An administrator's ledger really is deployment-wide, and still says so.
    cleanup();
    setupApi();
    await view();
    expect(within(ledger()).getByText("Produced by Support analyst, newest first.")).toBeTruthy();
  });

  it("does not tell a non-administrator that nothing has run under a Profile others use", async () => {
    /*
     * The emptiest case is the one the wording gets most wrong: a second
     * enterprise user opening a Profile colleagues have run fifty times was
     * told "Nothing has run under Support analyst", which is not a hedge but a
     * false statement about the deployment.
     */
    setupApi({ runs: [] });
    await view({ administrator: false });
    const panel = ledger();
    expect(within(panel).getByText("You have not run Support analyst")).toBeTruthy();
    expect(within(panel).queryByText("Nothing has run under Support analyst")).toBeNull();
    expect(within(panel).getByText(/colleagues started against it are not shown/)).toBeTruthy();
  });

  it("says the Approved Skills field records references nothing delivers", async () => {
    /*
     * The triples are stored on the version and folded into
     * `distributionDigest`, and no run payload carries them: nothing in
     * `apps/worker` or `packages/runtime-clients` reads `version.skills`.
     * Keeping the field is a product decision; letting it read as "this
     * Profile is bound to that Skill" is not.
     */
    setupApi();
    const user = userEvent.setup();
    await view();
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/never sent to Hermes/i)).toBeTruthy();
    // The wording that implied a runtime consequence, gone. A plain substring
    // check over the whole dialog, so no element boundary can hide it.
    expect(dialog.textContent).not.toContain("Runtime installation remains evidence-gated");
  });

  it("keeps both halves behind an authenticated workspace", () => {
    setupApi();
    render(<AgentsView {...props} unlocked={false} />);
    expect(screen.getByRole("heading", { name: "Agent Profiles" })).toBeTruthy();
    expect(api.getAgentProfiles).not.toHaveBeenCalled();
    expect(api.getAgentRuns).not.toHaveBeenCalled();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    setupApi();
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
