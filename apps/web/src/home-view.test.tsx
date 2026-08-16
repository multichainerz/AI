/**
 * @vitest-environment jsdom
 *
 * Home had no test at all while it was the screen every operator lands on. The
 * cases below are the ones a rebuild can silently break: what a locked session
 * is allowed to see, where the one primary action points, and whether a layer
 * row still routes to the right platform tab.
 */
import type { AgentMetrics, ChatMetrics, ToolMetrics } from "@orcasynapse/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeView, type HomeLayer, type HomeReadinessCheck } from "./home-view.js";

afterEach(cleanup);

const layers: HomeLayer[] = [
  { key: "inference", name: "AI Inference", role: "Enterprise model serving", mark: "AI", state: { label: "Ready", tone: "ready" }, components: [] },
  {
    key: "agentic",
    name: "Agentic System",
    role: "Governed Hermes execution",
    mark: "AS",
    state: { label: "Degraded", tone: "degraded" },
    components: [{ name: "Hermes", label: "Needs Profile or policy", tone: "degraded" }],
  },
  { key: "access", name: "Enterprise Access", role: "OIDC and RBAC", mark: "EA", state: { label: "Not configured", tone: "unconfigured" }, components: [] },
];

const readiness = (ready: boolean): HomeReadinessCheck[] => [
  { label: "AI Inference", detail: "Approved model serving is reachable", ready: true, action: "Deployment", setupStep: "inference" },
  { label: "Isolated agent runtime", detail: "VM2 is online and Hermes is reachable", ready: true, action: "Deployment", setupStep: "runtime" },
  { label: "Active Agent Profile", detail: "Create and activate an Agent Profile", ready, action: "Agents" },
];

/*
 * Only the fields the activity banner reads. Enumerating whole payloads would
 * make this fail every time one of four contracts grows a field, and the cast
 * is what keeps the fixture honest about how little Home actually consumes.
 *
 * It used to be one field. The banner reported readiness, which the callout
 * directly above it already carried, so the loudest surface on the screen was
 * saying nothing the screen did not say twice.
 */
const chatMetrics = {
  conversations: 342,
  responses: 1_284,
  // 1,249 + 24 + 11 = 1,284. The outcome bar divides the response total, so a
  // fixture whose parts do not sum to it would draw a bar that cannot occur.
  completed: 1_249,
  failed: 24,
  cancelled: 11,
  totalTokens: 1_284_930,
  averageLatencyMs: 1_450,
  failureRate: 0.02,
  windowStartedAt: "2026-08-02T00:00:00.000Z",
  feedback: { helpful: 88, notHelpful: 12 },
} as ChatMetrics;
const agentMetrics = {
  profiles: 4,
  activeProfiles: 2,
  queuedRuns: 3,
  runningRuns: 2,
  completedRuns: 180,
  failedRuns: 15,
} as AgentMetrics;
const toolMetrics = {
  activeTools: 6,
  activeGrants: 3,
  pendingApprovals: 2,
  executingCalls: 1,
  completedCalls: 940,
  deniedCalls: 7,
  failedCalls: 4,
} as ToolMetrics;
const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function props(overrides: Partial<Parameters<typeof HomeView>[0]> = {}) {
  return {
    apiAvailable: true,
    bootstrapState: "READY" as const,
    unlocked: true,
    healthyConnections: 3,
    monitoring: { enabled: true, intervalSeconds: 300, reason: null, updatedAt: "2026-08-07T00:00:00.000Z", updatedBy: null },
    chatMetrics,
    agentMetrics,
    toolMetrics,
    layers,
    readiness: readiness(false),
    onSelect: vi.fn(),
    onUnlock: vi.fn(),
    ...overrides,
  };
}

describe("Home", () => {
  it("shows no figures and offers only sign-in while the session is locked", async () => {
    // `unlocked` is not `signed in`: the shell renders Home either way, so every
    // figure it draws from an authenticated read has to withhold itself here.
    const onUnlock = vi.fn();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<HomeView {...props({ unlocked: false, onUnlock, onSelect })} />);

    // Every figure on the command panel is an authenticated read, so none of
    // them may show a number here.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText("Approved model serving is reachable")).toBeNull();
    expect(screen.getAllByText("Sign in to inspect readiness")).toHaveLength(3);
    // One per KPI tile: every headline figure is an authenticated read.
    expect(screen.getAllByText("sign in to view")).toHaveLength(6);
    expect(screen.queryByText("1,249 completed")).toBeNull();
    expect(screen.queryByText("97% completed")).toBeNull();
    expect(screen.queryByText("2 active")).toBeNull();
    expect(screen.queryByText("3 grants")).toBeNull();
    // Readiness detail is withheld while the session is locked.
    expect(screen.getAllByText("Locked").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onUnlock).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names the next blocking step rather than a generic welcome", () => {
    render(<HomeView {...props()} />);

    /*
     * The masthead is gone: its title and its "N of 3 ready. Next: <step>"
     * line both restated the Required capabilities panel directly beneath.
     * The blocking step is still named, by the surface that owns it.
     */
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("OrcaSynapse control center");
    expect(screen.queryByText(/Finish your private AI workspace/)).toBeNull();
    expect(screen.queryByText(/required capabilities are ready/)).toBeNull();
    expect(screen.getAllByText("Create and activate an Agent Profile").length).toBeGreaterThan(0);
    expect(screen.getByText("2/3 ready")).toBeTruthy();
    expect(screen.getByText("Next")).toBeTruthy();
  });

  it("keeps the dashboard to one command surface without duplicate sections or shortcuts", () => {
    const { container } = render(<HomeView {...props()} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Three operating layers" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "One governed execution path" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Agent profiles Instructions/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Required capabilities" })).toBeTruthy();
    /*
     * Three hops, counted as the ordered list's own children rather than as
     * every listitem on the screen. The global count was standing in for "the
     * path was not duplicated", and it broke the moment a hop grew a nested
     * list of its own diagnostics — which is a different claim entirely.
     */
    expect(container.querySelector("ol")?.querySelectorAll(":scope > li")).toHaveLength(3);
  });

  it("sends the primary action to the blocking step, and to Session once nothing blocks", async () => {
    const user = userEvent.setup();
    const blocked = vi.fn();
    const { unmount } = render(<HomeView {...props({ onSelect: blocked })} />);
    await user.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(blocked).toHaveBeenCalledWith("Agents");
    unmount();

    const ready = vi.fn();
    render(<HomeView {...props({ readiness: readiness(true), onSelect: ready })} />);
    // The label is the product word; the argument is the routing token, which
    // deliberately did not follow the rename.
    await user.click(screen.getByRole("button", { name: "Open Session" }));
    expect(ready).toHaveBeenCalledWith("Chat");
  });

  it("does not offer a session composer until required capabilities are ready", () => {
    render(<HomeView {...props()} />);
    expect(screen.queryByRole("button", { name: "Ask your Hermes agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start a session" })).toBeNull();

    cleanup();
    render(<HomeView {...props({ readiness: readiness(true) })} />);
    expect(screen.getByRole("button", { name: "Ask your Hermes agent" })).toBeTruthy();
  });

  it("routes each readiness repair to its exact workspace", async () => {
    // VM2 is enrolled in setup's second step; landing an operator on the first
    // when they clicked the runtime check is the difference between one click
    // and five. The destination is a step key now rather than a tab name — the
    // three-block screen those tabs belonged to no longer exists.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HomeView {...props({ onSelect })} />);

    await user.click(screen.getByRole("button", { name: /AI Inference/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Deployment", "inference");

    await user.click(screen.getByRole("button", { name: /Isolated agent runtime/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Deployment", "runtime");

    await user.click(screen.getByRole("button", { name: /Active Agent Profile/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Agents");
  });

  it("says the control plane is offline instead of showing stale figures as live", () => {
    render(<HomeView {...props({ apiAvailable: false })} />);
    expect(screen.getByText("Control plane offline")).toBeTruthy();
  });

  it("offers local sign-in once bootstrap is done but the session is not an administrator one", () => {
    /*
     * This masthead used to have a second locked arm for a pending password
     * change. It cannot render: `app.tsx` hands a password-change session to
     * the front page instead of the shell, so Home only ever draws while that
     * flag is false. Pinning the surviving copy is what makes deleting the
     * other arm a provable no-op rather than a hopeful one.
     */
    render(<HomeView {...props({ unlocked: false })} />);
    // The masthead carried this copy; the action label is what survives it.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("keeps installation ahead of everything else until bootstrap completes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HomeView {...props({ bootstrapState: "REQUIRED", unlocked: false, onSelect })} />);
    await user.click(screen.getByRole("button", { name: "Open setup" }));
    expect(onSelect).toHaveBeenCalledWith("Deployment", "inference");
  });

  it("renders no inline style, which the CSP would refuse in the built container", () => {
    expect(renderToStaticMarkup(<HomeView {...props()} />)).not.toMatch(/\sstyle=/);
  });

  it("leaves the authenticated Dashboard clear of the shared synapse field", () => {
    const { container } = render(<HomeView {...props()} />);

    expect(container.querySelector("svg.dashboard-synapse")).toBeNull();
  });

  it("uses the themed workspace canvas instead of a fixed violet command field", () => {
    render(<HomeView {...props()} />);

    const panel = screen.getByLabelText("Deployment command panel");
    expect(panel.outerHTML).not.toContain("border-white");
    expect(panel.outerHTML).not.toContain("bg-white");
    expect(panel.outerHTML).not.toContain("text-white/");
    expect(panel.outerHTML).not.toContain("bg-[#2B1364]");

    const heroRule = /\.dashboard-hero \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";
    expect(heroRule).toContain("background: var(--bg)");
    expect(heroRule).not.toContain("--brand-rgb");
  });

  /*
   * The sticky band above the panel used to be asserted here as themed too, on
   * the grounds that band and panel should read as one field. The band has since
   * been given the rail's violet deliberately -- it continues the sidebar rather
   * than the canvas -- so the assertion moved here and inverted. The panel above
   * is still the thing that must not go violet; this is the thing that must.
   *
   * The token lines are the half worth guarding. A brand background with
   * page-coloured ink is the failure mode that has no visible symptom in the
   * dark theme and puts near-black text on deep violet in the light one, so the
   * background and the foreground override are asserted as a pair.
   */
  it("keeps the sticky band on the rail's violet, with ink re-pointed for it", () => {
    const bandRule = /\n\.workspace-header \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";
    const immersiveRule = /\.workspace-header--immersive \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";

    expect(bandRule).toContain("background: rgb(var(--brand-rgb))");
    expect(immersiveRule).toContain("background: rgb(var(--brand-rgb))");
    expect(bandRule).toContain("--text-rgb: 255 255 255");
    // `--foreground-rgb` is a separate declaration and not a forward of
    // `--text-rgb`: the alias is substituted on <html>, so overriding one and
    // not the other leaves the operator control's `text-foreground` dark.
    expect(bandRule).toContain("--foreground-rgb: 255 255 255");
  });

  it("reports what the deployment has done, not what it is ready to do", () => {
    /*
     * The old banner restated readiness, so activity and its time window now
     * live together in the shallow metric strip rather than in another card:
     * "342 conversations" is not a fact until you know over what.
     */
    render(<HomeView {...props()} />);

    expect(screen.getByLabelText("Operational activity")).toBeTruthy();
    expect(screen.getByText("342")).toBeTruthy();
    /*
     * The window is stated, not its spelling: `toLocaleDateString` renders
     * "2 August" or "August 2" depending on where this runs, and pinning one of
     * those makes the suite fail on a machine in the wrong place rather than on
     * a caption that stopped saying anything.
     */
    expect(screen.getByText(/^since \w/)).toBeTruthy();
    expect(screen.getByText("1,249 completed")).toBeTruthy();
    // The governed path, with each hop's real state rather than a decorative one.
    // Hermes and AI Inference each name a topology hop;
    // the panel-specific assertion is the verdict it draws from them.
    expect(screen.getAllByText("Hermes").length).toBeGreaterThan(0);
    expect(screen.getByText("Identity, policy, audit")).toBeTruthy();
    expect(screen.getByText("Serving")).toBeTruthy();
    expect(screen.getByText("The path is not complete")).toBeTruthy();
    expect(screen.getByText("3 grants")).toBeTruthy();

    /*
     * Home takes every figure through props, so unlike the shell it can be seen
     * without a session. Set `HOME_PREVIEW_OUT` to a path and this writes the
     * populated markup there; pair it with the stylesheet from a web build and
     * the banner opens in a browser. Attached to a real test rather than kept
     * as a scratch script, so it cannot rot unnoticed.
     */
    if (process.env.HOME_PREVIEW_OUT) {
      writeFileSync(process.env.HOME_PREVIEW_OUT, document.body.innerHTML, "utf8");
    }
  });

  /*
   * The panel polls four contracts and drew about half of what they carry.
   * `queuedRuns`, `runningRuns`, `completedRuns`, `failedRuns`, `failed`,
   * `cancelled`, `totalTokens`, `feedback`, `pendingApprovals` and
   * `deniedCalls` all arrived on every refresh and reached no pixel: the
   * screen could say how many Profiles existed but not whether any of them
   * were running. These cases pin the figures to the surfaces that now own
   * them, so a future tidy-up cannot quietly drop them back out of sight.
   */
  it("draws the run pipeline, which the poll always reported and nothing drew", () => {
    render(<HomeView {...props()} />);
    const pipeline = within(screen.getByRole("region", { name: "Run pipeline" }));

    expect(pipeline.getByText("Queued")).toBeTruthy();
    expect(pipeline.getByText("Running")).toBeTruthy();
    expect(pipeline.getByText("180")).toBeTruthy();
    expect(pipeline.getByText("15")).toBeTruthy();
  });

  it("divides the response total into its outcomes instead of only counting it", () => {
    render(<HomeView {...props()} />);
    const pipeline = within(screen.getByRole("region", { name: "Run pipeline" }));

    expect(pipeline.getByText("1,249 completed")).toBeTruthy();
    expect(pipeline.getByText("24 failed")).toBeTruthy();
    expect(pipeline.getByText("11 cancelled")).toBeTruthy();
    // The tile above states the share; the bar below states the counts. One
    // fact, one place — the count used to be printed in both.
    expect(screen.getByText("97% completed")).toBeTruthy();
  });

  it("surfaces the tool decisions that are waiting on a person", () => {
    render(<HomeView {...props()} />);
    const pipeline = within(screen.getByRole("region", { name: "Run pipeline" }));

    // Scoped to each figure's own pair: "2" is also the running-run count, and
    // a bare getByText would pass while pointing at the wrong number.
    const figure = (label: string) =>
      within(pipeline.getByText(label).parentElement as HTMLElement).getAllByRole("definition")[0]?.textContent;
    expect(figure("Awaiting approval")).toBe("2");
    expect(figure("Denied calls")).toBe("7");
  });

  /*
   * Six figures in one strip, drawn from three contracts covering two different
   * periods, and nothing on the screen said which was which: "Responses 12" sat
   * beside "Tool calls 8,431" as though they described the same day. The cases
   * below hold each figure to the window its label claims.
   */
  it("names the window every figure covers, so a day's count is not read as an all-time one", () => {
    render(<HomeView {...props()} />);
    const strip = within(screen.getByLabelText("Operational activity"));
    // The tile, not the label: the window rides beside the name in the same
    // `<dt>`, so the claim is about what that whole pair says.
    const tile = (label: string) => strip.getByText(label).closest("div")?.textContent ?? "";

    for (const chat of ["Sessions", "Responses", "Avg response", "Tokens", "Rated helpful"]) {
      expect(tile(chat), `${chat} does not state its window`).toContain("24h");
    }
    // Tool counts have no window at all — they are every call since install.
    expect(tile("Tool calls")).toContain("all time");
    expect(tile("Tool calls")).not.toContain("24h");

    // Same mix inside the execution column: agent runs are all-time, the
    // response outcomes beneath them are the same 24 hours as the strip.
    const execution = within(screen.getByRole("region", { name: "Run pipeline" }));
    expect(execution.getByText(/all time/i)).toBeTruthy();
    expect(execution.getByText(/Response outcomes \/ 24h/i)).toBeTruthy();
  });

  it("states the hour the 24-hour window opened, not only its date", () => {
    /*
     * A trailing window that opened at 09:00 yesterday read "since 14 August",
     * which is the one thing it is not: the window covers a *quarter* of the
     * 14th and three quarters of the 15th. The spelling is still the locale's
     * — only the presence of a clock time is asserted.
     */
    render(<HomeView {...props()} />);
    expect(screen.getByText(/^since \w/).textContent).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it("counts every tool call the ledger holds, not only the completed ones", () => {
    /*
     * "Tool calls 940" beside "Denied 7" invites a subtraction that gives the
     * wrong answer, because the 940 never included the 7 — or the 4 failures,
     * which were fetched on every poll and drawn nowhere at all.
     */
    render(<HomeView {...props()} />);
    const strip = within(screen.getByLabelText("Operational activity"));

    // 940 completed + 7 denied + 4 failed.
    expect(strip.getByText("951")).toBeTruthy();
    expect(strip.queryByText("940")).toBeNull();

    const execution = within(screen.getByRole("region", { name: "Run pipeline" }));
    const figure = (label: string) =>
      within(execution.getByText(label).parentElement as HTMLElement).getAllByRole("definition")[0]?.textContent;
    expect(figure("Failed calls")).toBe("4");
    expect(figure("Denied calls")).toBe("7");
  });

  it("does not call the pipeline bars a share of all runs, because three statuses are in no bucket", () => {
    /*
     * `AGENT_RUN_STATUSES` carries CANCELLED, TIMED_OUT and DENIED as well, and
     * `AgentMetrics` reports none of them — so the denominator is the four
     * stages drawn here and nothing wider. A bar announcing "share of all runs"
     * is a claim the contract cannot support.
     */
    render(<HomeView {...props()} />);
    const bars = within(screen.getByRole("region", { name: "Run pipeline" })).getAllByRole("progressbar");

    // Length first: `[].every()` is true, so a missing bar would pass silently.
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.map((bar) => bar.getAttribute("aria-label") ?? "").join(" ")).not.toMatch(/all runs/i);
    expect(bars[0]?.getAttribute("aria-label")).toMatch(/these four stages/i);
  });

  it("does not call one unhappy rating a failing satisfaction score", () => {
    /*
     * `helpfulShare < 0.5` with no minimum sample: a single not-helpful rating
     * makes the tile read 0% in warn colour, which is a verdict on the
     * deployment drawn from one click. Nothing in the product writes chat
     * feedback today, so the honest states are "nothing rated" and "too few to
     * judge" — never "failing".
     */
    const single = { ...chatMetrics, feedback: { helpful: 0, notHelpful: 1 } } as ChatMetrics;
    render(<HomeView {...props({ chatMetrics: single })} />);

    const bar = screen.getByLabelText("Rated helpful: proportion of the total");
    expect(bar.className).not.toContain("is-warn");

    cleanup();
    // And with a real sample behind it, the warning still fires.
    const poor = { ...chatMetrics, feedback: { helpful: 4, notHelpful: 46 } } as ChatMetrics;
    render(<HomeView {...props({ chatMetrics: poor })} />);
    expect(screen.getByLabelText("Rated helpful: proportion of the total").className).toContain("is-warn");
  });

  it("says nothing was rated rather than drawing a zero score", () => {
    // The state every deployment is actually in: no surface writes chat
    // feedback, so this tile is structurally 0 of 0 and must not read as 0%.
    const unrated = { ...chatMetrics, feedback: { helpful: 0, notHelpful: 0 } } as ChatMetrics;
    render(<HomeView {...props({ chatMetrics: unrated })} />);

    expect(screen.getByText("no ratings yet")).toBeTruthy();
    expect(screen.queryByLabelText("Rated helpful: proportion of the total")).toBeNull();
  });

  it("compacts a seven-figure token total into the width a column has", () => {
    render(<HomeView {...props()} />);
    // 1,284,930 in a cell sized for four glyphs is a truncated number, which
    // is worse than a rounded one.
    expect(screen.getByText("1.3M")).toBeTruthy();
    expect(screen.queryByText("1,284,930")).toBeNull();
  });

  it("draws bring-up progress as a ring, not only as a fraction in a chip", () => {
    const { container, unmount } = render(<HomeView {...props()} />);
    const dash = () => container.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray") ?? "";
    const [filled, circumference] = dash().split(" ").map(Number);

    expect(circumference).toBeGreaterThan(0);
    expect((filled ?? 0) / (circumference ?? 1)).toBeCloseTo(2 / 3, 5);
    unmount();

    // Locked, the ring is a track and nothing else: a two-thirds arc drawn from
    // figures nobody is allowed to read would be an invented reading.
    const { container: locked } = render(<HomeView {...props({ unlocked: false })} />);
    expect(locked.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toMatch(/^0 /);
  });

  it("reports identity without restating what the governed path already says", () => {
    /*
     * The path column derives its two middle hops from the inference and
     * agentic layer states, so listing all three layers beside it printed
     * "Ready" and "Degraded" on the screen twice. Enterprise access is the one
     * layer no other panel carries, so it is the one that stays — and as text,
     * because "AI Inference" already names a capability *button* here and two
     * controls with one name are ambiguous to a pointer and a screen reader
     * alike.
     */
    render(<HomeView {...props()} />);

    // The layer's own diagnostic, which said why a hop was degraded and until
    // now reached no pixel at all.
    expect(screen.getByText(/Needs Profile or policy/)).toBeTruthy();
    expect(screen.getByText("Identity")).toBeTruthy();
    expect(screen.getByText("Enterprise Access")).toBeTruthy();
    expect(screen.queryByText("Agentic System")).toBeNull();
    expect(screen.getAllByRole("button", { name: /AI Inference/ })).toHaveLength(1);
    // Stated once, by the hop that owns it.
    expect(screen.getAllByText("Degraded")).toHaveLength(1);
  });

  it("draws the completed share as a bar, because a fraction has a denominator worth seeing", () => {
    /*
     * The one figure here with a denominator. Moving the banner onto HeroBanner
     * in v1.7.0 dropped the `fill` that drew it and nothing failed: `Metric`
     * renders the bar only when a caller passes `fill`, the only production
     * caller was this one, and `ui.test.tsx` kept exercising the branch
     * directly. The feature left the product and the tests stayed green.
     */
    const { container } = render(<HomeView {...props()} />);
    const bar = container.querySelector("progress");
    expect(bar, "the responses figure renders no progress bar").toBeTruthy();
    // 1,249 of 1,284 responses completed.
    expect(bar).toHaveProperty("value", 97);
  });

  it("colours the bar by the failure rate, not by decoration", () => {
    /*
     * The tone reached the component and stopped there: HeroBanner's accent
     * branch forwarded `fill` but not `tone`, so every bar painted white and
     * the three `.is-*` rules had no consumer. Asserting on the class is what
     * makes the difference between "the prop is set" and "the pixel changes".
     */
    const { container } = render(<HomeView {...props()} />);
    expect(container.querySelector("progress")?.className).toContain("is-good");

    cleanup();
    const failing = { ...chatMetrics, failureRate: 0.4 } as ChatMetrics;
    const { container: warned } = render(<HomeView {...props({ chatMetrics: failing })} />);
    expect(warned.querySelector("progress")?.className).toContain("is-warn");
  });

  it("draws no bar before anything has run, rather than a full green one", () => {
    /*
     * `completed / responses` is 0/0 with no runs. A bar drawn from that is
     * either NaN or, worse, rounds to something that reads as "everything
     * succeeded" when the truth is "nothing has been attempted".
     */
    const untouched = { ...chatMetrics, conversations: 0, responses: 0, completed: 0 } as ChatMetrics;
    render(<HomeView {...props({ chatMetrics: untouched })} />);
    // Named rather than "the first progress in the tree": the run pipeline and
    // the satisfaction tile draw their own bars from metrics this fixture
    // leaves populated, so only this one's absence is the claim.
    expect(screen.queryByLabelText("Responses: proportion of the total")).toBeNull();
  });

  it("draws no bar while the session is locked, rather than an empty one", () => {
    // A zero-width bar under a dash reads as "nothing is ready" instead of
    // "nobody has looked yet", which is the distinction the whole screen turns on.
    const { container } = render(<HomeView {...props({ unlocked: false })} />);
    expect(container.querySelector("progress")).toBeNull();
  });
});
