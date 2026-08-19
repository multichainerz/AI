/**
 * @vitest-environment jsdom
 *
 * The screen every operator lands on. The cases below are the ones a rebuild
 * can silently break: what a locked session is allowed to see, where the one
 * primary action points, whether an attention row still routes to the surface
 * that owns the fix, and whether the figures stay honest about their windows.
 */
import type {
  AgentMetrics,
  AgentRun,
  ChatMetrics,
  HermesRuntimeNode,
  OperationalIncident,
  ToolMetrics,
  UsageReport,
} from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getGatewayUsage: vi.fn(),
  getAgentRuns: vi.fn(),
  getOperationalIncidents: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { HomeView } = await import("./home-view.js");
type HomeLayer = import("./home-view.js").HomeLayer;
type HomeReadinessCheck = import("./home-view.js").HomeReadinessCheck;

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
 * Only the fields the Dashboard reads. Enumerating whole payloads would make
 * this fail every time one of the contracts grows a field, and the cast is
 * what keeps the fixture honest about how little Home actually consumes.
 */
const chatMetrics = {
  conversations: 342,
  responses: 1_284,
  // 1,249 + 24 + 11 = 1,284: the completed share divides the response total.
  completed: 1_249,
  failed: 24,
  cancelled: 11,
  totalTokens: 1_284_930,
  averageLatencyMs: 1_450,
  failureRate: 0.02,
  windowStartedAt: "2026-08-02T00:00:00.000Z",
  feedback: { helpful: 0, notHelpful: 0 },
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

const runtimeNodes = [
  { id: "node-1", slug: "vm2-primary", displayName: "VM2 primary", status: "ONLINE" },
  { id: "node-2", slug: "vm2-lab", displayName: "VM2 lab", status: "OFFLINE" },
] as HermesRuntimeNode[];

/** A day of hourly buckets, with one visible failure hour. */
const series = Array.from({ length: 24 }, (_, hour) => ({
  at: `2026-08-18T${hour.toString().padStart(2, "0")}:00:00.000Z`,
  runs: hour === 6 ? 0 : 4 + (hour % 5),
  failed: hour === 14 ? 2 : 0,
  inputTokens: 900,
  outputTokens: 400,
  totalTokens: 1_300,
  costUsd: null,
}));

const usageReport = {
  window: "24h",
  windowStartedAt: "2026-08-18T00:00:00.000Z",
  generatedAt: "2026-08-19T00:00:00.000Z",
  bucket: "hour",
  totals: {
    runs: 132,
    failed: 2,
    totalTokens: 1_284_930,
    tokensReported: 130,
    tokensUnreported: 0,
    failureRate: 0.015,
    p95LatencyMs: 2_800,
    averageLatencyMs: 1_450,
    costUsd: null,
  },
  series,
} as unknown as UsageReport;

const recentRuns = [
  {
    id: "run-1",
    profileName: "Administrator",
    status: "COMPLETED",
    totalTokens: 1_240,
    queuedAt: "2026-08-19T03:00:00.000Z",
    startedAt: "2026-08-19T03:00:01.000Z",
    completedAt: "2026-08-19T03:00:09.000Z",
  },
  {
    id: "run-2",
    profileName: "Division analyst",
    status: "FAILED",
    totalTokens: null,
    queuedAt: "2026-08-19T02:00:00.000Z",
    startedAt: "2026-08-19T02:00:01.000Z",
    completedAt: "2026-08-19T02:00:04.000Z",
  },
] as AgentRun[];

const incident = {
  id: "b7f7b7e2-1111-4222-8333-444455556666",
  title: "Queue depth above threshold",
  severity: "WARNING",
  status: "OPEN",
  component: "worker",
} as OperationalIncident;

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

beforeEach(() => {
  api.getGatewayUsage.mockReset();
  api.getAgentRuns.mockReset();
  api.getOperationalIncidents.mockReset();
  /*
   * Pending by default, resolved per test. A test that is not about the
   * asynchronous panels should not have their state updates landing mid-assert;
   * the skeletons those panels draw while loading are a stable state.
   */
  api.getGatewayUsage.mockReturnValue(new Promise(() => undefined));
  api.getAgentRuns.mockReturnValue(new Promise(() => undefined));
  api.getOperationalIncidents.mockReturnValue(new Promise(() => undefined));
});

const settled = () => {
  api.getGatewayUsage.mockResolvedValue(usageReport);
  api.getAgentRuns.mockResolvedValue({ items: recentRuns });
  api.getOperationalIncidents.mockResolvedValue({ items: [] });
};

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
    runtimeNodes,
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
    render(<HomeView {...props({ unlocked: false, runtimeNodes: [], onUnlock, onSelect })} />);

    // Every figure on the command panel is an authenticated read, so none of
    // them may show a number here.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(6);
    // One per strip cell: every headline figure is an authenticated read.
    expect(screen.getAllByText("sign in to view")).toHaveLength(6);
    expect(screen.queryByText("342")).toBeNull();
    expect(screen.queryByText(/completed/)).toBeNull();
    expect(screen.getAllByText("Locked").length).toBeGreaterThan(0);
    // The Dashboard's own reads never leave the browser while locked.
    expect(api.getGatewayUsage).not.toHaveBeenCalled();
    expect(api.getAgentRuns).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onUnlock).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names the next blocking step rather than a generic welcome", () => {
    render(<HomeView {...props()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("OrcaSynapse control center");
    expect(screen.queryByText(/Finish your private AI workspace/)).toBeNull();
    expect(screen.queryByText(/required capabilities are ready/)).toBeNull();
    // The unready capability is an attention row, marked as the next step.
    expect(screen.getAllByText("Create and activate an Agent Profile").length).toBeGreaterThan(0);
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByText("Next")).toBeTruthy();
  });

  it("keeps the dashboard to one command surface without duplicate sections or shortcuts", () => {
    const { container } = render(<HomeView {...props()} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Three operating layers" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Required capabilities" })).toBeNull();
    expect(screen.getByRole("heading", { name: /items waiting|All clear/ })).toBeTruthy();
    /*
     * Three hops, counted as the ordered list's own children rather than as
     * every listitem on the screen: a hop can grow a nested diagnostic list,
     * which is a different claim entirely.
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

    cleanup();
    render(<HomeView {...props({ readiness: readiness(true) })} />);
    expect(screen.getByRole("button", { name: "Ask your Hermes agent" })).toBeTruthy();
  });

  it("routes each attention row to the surface that owns the fix", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <HomeView
        {...props({
          onSelect,
          readiness: [
            ...readiness(false).slice(0, 1),
            { label: "Isolated agent runtime", detail: "Enroll VM2 and verify Hermes health", ready: false, action: "Deployment", setupStep: "runtime" },
            ...readiness(false).slice(2),
          ],
        })}
      />,
    );

    // A decision someone can make now routes to the tools workspace.
    await user.click(screen.getByRole("button", { name: /2 approvals waiting/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Integrations");

    // A node fault routes to Deployment.
    await user.click(screen.getByRole("button", { name: /VM2 lab is offline/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Deployment");

    // Failed responses route to the ledger.
    await user.click(screen.getByRole("button", { name: /24 failed responses/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Agents");

    // A readiness gap routes to the exact setup step that repairs it.
    await user.click(screen.getByRole("button", { name: /Isolated agent runtime/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Deployment", "runtime");
  });

  it("ranks a decision above a fault and a fault above bring-up", () => {
    render(<HomeView {...props()} />);
    const queue = within(screen.getByRole("region", { name: /Needs attention/i }));
    const rows = queue.getAllByRole("button").map((row) => row.textContent ?? "");

    const position = (fragment: string) => rows.findIndex((row) => row.includes(fragment));
    expect(position("2 approvals waiting")).toBe(0);
    expect(position("VM2 lab is offline")).toBeGreaterThan(position("2 approvals waiting"));
    expect(position("24 failed responses")).toBeGreaterThan(position("VM2 lab is offline"));
    expect(position("Active Agent Profile")).toBeGreaterThan(position("24 failed responses"));
  });

  it("says all clear when nothing is waiting, instead of stretching placeholders", async () => {
    api.getOperationalIncidents.mockResolvedValue({ items: [] });
    const calm = { ...chatMetrics, failed: 0 } as ChatMetrics;
    const decided = { ...toolMetrics, pendingApprovals: 0 } as ToolMetrics;
    const online = [{ ...runtimeNodes[0] }] as HermesRuntimeNode[];
    render(
      <HomeView
        {...props({ chatMetrics: calm, toolMetrics: decided, runtimeNodes: online, readiness: readiness(true) })}
      />,
    );

    expect(await screen.findByText("Nothing is waiting on you")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All clear" })).toBeTruthy();
  });

  it("caps the queue at five rows and says how many it left out", async () => {
    const incidents = Array.from({ length: 7 }, (_, index) => ({
      ...incident,
      id: `${index}${incident.id.slice(1)}`,
      title: `Incident ${index + 1}`,
    })) as OperationalIncident[];
    api.getOperationalIncidents.mockResolvedValue({ items: incidents });
    const calm = { ...chatMetrics, failed: 0 } as ChatMetrics;
    const decided = { ...toolMetrics, pendingApprovals: 0 } as ToolMetrics;
    const online = [{ ...runtimeNodes[0] }] as HermesRuntimeNode[];
    render(
      <HomeView
        {...props({ chatMetrics: calm, toolMetrics: decided, runtimeNodes: online, readiness: readiness(true) })}
      />,
    );

    expect(await screen.findByText("+2 more in their own workspaces")).toBeTruthy();
    const queue = within(screen.getByRole("region", { name: /Needs attention/i }));
    expect(queue.getAllByRole("button")).toHaveLength(5);
    expect(screen.getByRole("heading", { name: "7 items waiting" })).toBeTruthy();
  });

  it("says the control plane is offline instead of showing stale figures as live", () => {
    render(<HomeView {...props({ apiAvailable: false })} />);
    expect(screen.getByText("Control plane offline")).toBeTruthy();
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
   * The band above the panel carries the rail's violet deliberately — it
   * continues the sidebar rather than the canvas. The token lines are the half
   * worth guarding: a brand background with page-coloured ink has no visible
   * symptom in the dark theme and puts near-black text on deep violet in the
   * light one, so background and foreground override are asserted as a pair.
   */
  it("keeps the sticky band on the rail's violet, with ink re-pointed for it", () => {
    const bandRule = /\n\.workspace-header \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";
    const immersiveRule = /\.workspace-header--immersive \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";

    expect(bandRule).toContain("background: rgb(var(--brand-rgb))");
    expect(immersiveRule).toContain("background: rgb(var(--brand-rgb))");
    expect(bandRule).toContain("--text-rgb: 255 255 255");
    expect(bandRule).toContain("--foreground-rgb: 255 255 255");
  });

  it("carries the title on the shared dot-grid field, and only the title", () => {
    const { container } = render(<HomeView {...props()} />);
    const field = container.querySelector(".workspace-intro-field");

    expect(field).toBeTruthy();
    expect(field?.querySelector("h1")).toBeTruthy();
    // Texture behind a name, never behind figures: the strip and the panels
    // live outside the field.
    expect(field?.textContent).not.toContain("Sessions");
    expect(field?.querySelector("dl")).toBeNull();
  });

  /*
   * The strip states its window once, as a group label, instead of as a
   * suffix on every cell — and it holds no all-time figure at all. The old
   * strip mixed one in and patched the confusion with labels.
   */
  it("states one window for the strip and keeps all-time out of it", () => {
    render(<HomeView {...props()} />);

    expect(screen.getByText("Last 24 hours")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.queryByText(/all time/i)).toBeNull();
    expect(screen.queryByText(/\/ 24h/)).toBeNull();
    // The retired cells stay retired.
    expect(screen.queryByText("Rated helpful")).toBeNull();
    expect(screen.queryByText("Tool calls")).toBeNull();
  });

  it("reports what the deployment has done, with the hour its window opened", () => {
    render(<HomeView {...props()} />);

    expect(screen.getByText("342")).toBeTruthy();
    /*
     * The window is stated, not its spelling: `toLocaleString` renders
     * "2 August" or "August 2" depending on where this runs. A trailing window
     * that opened at 09:00 must state the clock time, not only the date.
     */
    expect(screen.getByText(/^since \w/).textContent).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(screen.getByText("97% completed")).toBeTruthy();

    /*
     * Home takes the strip through props, so unlike the shell it can be seen
     * without a session. Set `HOME_PREVIEW_OUT` to a path and this writes the
     * populated markup there. Attached to a real test rather than kept as a
     * scratch script, so it cannot rot unnoticed.
     */
    if (process.env.HOME_PREVIEW_OUT) {
      writeFileSync(process.env.HOME_PREVIEW_OUT, document.body.innerHTML, "utf8");
    }
  });

  it("draws what is live right now beside the day, not buried in a column", () => {
    render(<HomeView {...props()} />);
    const live = within(screen.getByLabelText("Live right now"));

    const cell = (label: string) => live.getByText(label).closest("div")?.textContent ?? "";
    expect(cell("Running now")).toContain("2");
    expect(cell("Running now")).toContain("3 queued");
    expect(cell("Awaiting approval")).toContain("2");
    expect(cell("Awaiting approval")).toContain("decide in Tools");
  });

  it("compacts a seven-figure token total into the width a column has", () => {
    render(<HomeView {...props()} />);
    // 1,284,930 in a cell sized for four glyphs is a truncated number, which
    // is worse than a rounded one.
    expect(screen.getAllByText("1.3M").length).toBeGreaterThan(0);
    expect(screen.queryByText("1,284,930")).toBeNull();
  });

  it("draws the day's trend from the usage report, in the Usage screen's grammar", async () => {
    settled();
    render(<HomeView {...props()} />);

    const chart = await screen.findByRole("img", { name: /Runs per hour across 24 hours/ });
    // One bar per bucket with runs, plus the baseline. Hour 6 ran nothing and
    // draws nothing — absence, not a zero-height sliver.
    expect(chart.querySelectorAll("rect.fill-accent")).toHaveLength(23);
    // The one red thing on the screen is the hour that failed.
    expect(chart.querySelectorAll("rect.fill-bad")).toHaveLength(1);

    const activity = within(screen.getByRole("region", { name: "Activity" }));
    expect(activity.getByText("1.3M")).toBeTruthy();
    expect(activity.getByText("1.5%")).toBeTruthy();
    expect(activity.getByText("2.8 s")).toBeTruthy();
  });

  it("re-reads the trend when the operator widens the window", async () => {
    settled();
    const user = userEvent.setup();
    render(<HomeView {...props()} />);
    await screen.findByRole("img", { name: /Runs per hour/ });

    await user.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(api.getGatewayUsage).toHaveBeenLastCalledWith("7d"));
    expect(screen.getByRole("button", { name: "7d" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says no runs happened rather than drawing an empty chart as data", async () => {
    api.getGatewayUsage.mockResolvedValue({
      ...usageReport,
      totals: { ...usageReport.totals, runs: 0, failed: 0, totalTokens: 0, failureRate: 0 },
      series: [],
    } as unknown as UsageReport);
    render(<HomeView {...props()} />);

    expect(await screen.findByText("No runs in this window yet.")).toBeTruthy();
    // No denominator, no rate: a 0.0% claim needs at least one run behind it.
    const activity = within(screen.getByRole("region", { name: "Activity" }));
    const rate = activity.getByText("Failure rate").parentElement?.textContent ?? "";
    expect(rate).toContain("—");
  });

  it("admits when some tokens went uncounted instead of presenting a partial sum as whole", async () => {
    api.getGatewayUsage.mockResolvedValue({
      ...usageReport,
      totals: { ...usageReport.totals, tokensUnreported: 12 },
    } as unknown as UsageReport);
    render(<HomeView {...props()} />);

    expect(await screen.findByText("Tokens · partial")).toBeTruthy();
  });

  it("names the most recent sessions and routes them to the ledger", async () => {
    settled();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HomeView {...props({ onSelect })} />);

    expect(await screen.findByText("Administrator")).toBeTruthy();
    expect(screen.getByText("Division analyst")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Division analyst/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Agents");
  });

  it("says sessions will appear rather than drawing an empty ledger as loading", async () => {
    settled();
    api.getAgentRuns.mockResolvedValue({ items: [] });
    render(<HomeView {...props()} />);

    expect(await screen.findByText("Sessions will appear here as they execute.")).toBeTruthy();
  });

  it("draws bring-up progress as a ring, and only while bring-up is underway", () => {
    const { container, unmount } = render(<HomeView {...props()} />);
    const dash = () => container.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray") ?? "";
    const [filled, circumference] = dash().split(" ").map(Number);

    expect(circumference).toBeGreaterThan(0);
    expect((filled ?? 0) / (circumference ?? 1)).toBeCloseTo(2 / 3, 5);
    unmount();

    // Locked, there is no ring at all: an arc drawn from figures nobody is
    // allowed to read would be an invented reading.
    const { container: locked, unmount: unlockedDone } = render(<HomeView {...props({ unlocked: false })} />);
    expect(locked.querySelector("circle[stroke-dasharray]")).toBeNull();
    unlockedDone();

    // And once every capability is ready the ring retires with the checklist.
    const { container: ready } = render(<HomeView {...props({ readiness: readiness(true) })} />);
    expect(ready.querySelector("circle[stroke-dasharray]")).toBeNull();
  });

  it("keeps the system panel to the machinery: hops, nodes, identity", () => {
    render(<HomeView {...props()} />);
    const system = within(screen.getByRole("region", { name: /System/i }));

    expect(system.getByText("The path is not complete")).toBeTruthy();
    expect(system.getByText("Serving")).toBeTruthy();
    // The layer's own diagnostic, drawn only while the hop is not live.
    expect(system.getByText(/Needs Profile or policy/)).toBeTruthy();
    expect(system.getByText("1/2 online")).toBeTruthy();
    expect(system.getByText("Enterprise Access")).toBeTruthy();
    expect(system.getByText("Every run written to the ledger")).toBeTruthy();
    // Stated once, by the hop that owns it.
    expect(screen.getAllByText("Degraded")).toHaveLength(1);
  });

  it("draws the completed share as a bar, because a fraction has a denominator worth seeing", () => {
    const { container } = render(<HomeView {...props()} />);
    const bar = screen.getByLabelText("Responses: proportion of the total");
    expect(bar).toBeTruthy();
    // 1,249 of 1,284 responses completed.
    expect(bar).toHaveProperty("value", 97);
    expect(container.querySelector("progress")?.className).toContain("is-good");

    cleanup();
    const failing = { ...chatMetrics, failureRate: 0.4 } as ChatMetrics;
    const { container: warned } = render(<HomeView {...props({ chatMetrics: failing })} />);
    expect(warned.querySelector("progress")?.className).toContain("is-warn");
  });

  it("draws no bar before anything has run, rather than a full green one", () => {
    const untouched = { ...chatMetrics, conversations: 0, responses: 0, completed: 0 } as ChatMetrics;
    render(<HomeView {...props({ chatMetrics: untouched })} />);
    expect(screen.queryByLabelText("Responses: proportion of the total")).toBeNull();
  });

  it("draws no bar while the session is locked, rather than an empty one", () => {
    // A zero-width bar under a dash reads as "nothing is ready" instead of
    // "nobody has looked yet", which is the distinction the whole screen turns on.
    const { container } = render(<HomeView {...props({ unlocked: false })} />);
    expect(container.querySelector("progress")).toBeNull();
  });
});
