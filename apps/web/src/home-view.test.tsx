/**
 * @vitest-environment jsdom
 *
 * Home had no test at all while it was the screen every operator lands on. The
 * cases below are the ones a rebuild can silently break: what a locked session
 * is allowed to see, where the one primary action points, and whether a layer
 * row still routes to the right platform tab.
 */
import type { AgentMetrics, ChatMetrics, DocumentMetrics, ToolMetrics } from "@orcasynapse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFileSync } from "node:fs";
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
  { label: "AI Inference", detail: "Approved model serving is reachable", ready: true, action: "Deployment", deploymentTab: "journey" },
  { label: "Isolated agent runtime", detail: "VM2 is online and Hermes is reachable", ready: true, action: "Deployment", deploymentTab: "nodes" },
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
  completed: 1_249,
  failureRate: 0.02,
  windowStartedAt: "2026-08-02T00:00:00.000Z",
} as ChatMetrics;
const documentMetrics = { total: 58, ready: 55 } as DocumentMetrics;
const agentMetrics = { profiles: 4, activeProfiles: 2 } as AgentMetrics;
const toolMetrics = { activeTools: 6, activeGrants: 3 } as ToolMetrics;

function props(overrides: Partial<Parameters<typeof HomeView>[0]> = {}) {
  return {
    apiAvailable: true,
    bootstrapState: "READY" as const,
    unlocked: true,
    healthyConnections: 3,
    monitoring: { enabled: true, intervalSeconds: 300, reason: null, updatedAt: "2026-08-07T00:00:00.000Z", updatedBy: null },
    chatMetrics,
    documentMetrics,
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
    expect(screen.getAllByText("sign in to view")).toHaveLength(6);
    expect(screen.queryByText("55 indexed")).toBeNull();
    expect(screen.queryByText("1,249 completed")).toBeNull();
    expect(screen.queryByText("2 active")).toBeNull();
    expect(screen.queryByText("3 grants")).toBeNull();
    // "Locked" is the layer state; the panel says "Not readable" for the same
    // condition, because a hop reports whether it can answer, not why.
    expect(screen.getAllByText("Locked").length).toBeGreaterThan(0);
    expect(screen.getByText("Not readable")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onUnlock).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names the next blocking step rather than a generic welcome", () => {
    render(<HomeView {...props()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Finish your private AI workspace");
    /*
     * The panel states the title and the action, not the step — it is the high
     * level. The blocking step is still named on the screen, in the required
     * capabilities list, which is the surface that owns it.
     */
    expect(screen.getByText(/Next: Create and activate an Agent Profile\./)).toBeTruthy();
    expect(screen.getAllByText("Create and activate an Agent Profile").length).toBeGreaterThan(0);
    expect(screen.getByText("2/3 ready")).toBeTruthy();
    expect(screen.getByText("Next")).toBeTruthy();
  });

  it("keeps the dashboard to one command surface without duplicate sections or shortcuts", () => {
    render(<HomeView {...props()} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Three operating layers" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "One governed execution path" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add knowledge/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Agent profiles Instructions/ })).toBeNull();
    expect(screen.queryByText("What changed in my knowledge sources this week?")).toBeNull();
    expect(screen.getByRole("heading", { name: "Required capabilities" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
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
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your agentic workspace is ready");
    // The label is the product word; the argument is the routing token, which
    // deliberately did not follow the rename.
    await user.click(screen.getByRole("button", { name: "Open Session" }));
    expect(ready).toHaveBeenCalledWith("Chat");
  });

  it("routes each readiness repair to its exact workspace", async () => {
    // VM2 is enrolled under Nodes; landing an operator on Journey when they
    // clicked the runtime check is the difference between one click and five.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HomeView {...props({ onSelect })} />);

    await user.click(screen.getByRole("button", { name: /AI Inference/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Deployment", "journey");

    await user.click(screen.getByRole("button", { name: /Isolated agent runtime/ }));
    expect(onSelect).toHaveBeenLastCalledWith("Deployment", "nodes");

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
    expect(screen.getByText("Local sign-in ready")).toBeTruthy();
    expect(screen.getByText("Sign in to manage encrypted endpoints, agents, and knowledge.")).toBeTruthy();
  });

  it("keeps installation ahead of everything else until bootstrap completes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HomeView {...props({ bootstrapState: "REQUIRED", unlocked: false, onSelect })} />);
    expect(screen.getByText("Installation required")).toBeTruthy();
    expect(screen.getByText("Run the protected VM1 installer before configuring services.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open setup" }));
    expect(onSelect).toHaveBeenCalledWith("Deployment", "journey");
  });

  it("renders no inline style, which the CSP would refuse in the built container", () => {
    expect(renderToStaticMarkup(<HomeView {...props()} />)).not.toMatch(/\sstyle=/);
  });

  it("leaves the authenticated Dashboard clear of the shared synapse field", () => {
    const { container } = render(<HomeView {...props()} />);

    expect(container.querySelector("svg.dashboard-synapse")).toBeNull();
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
    expect(screen.getByText("55 indexed")).toBeTruthy();
    // The governed path, with each hop's real state rather than a decorative one.
    // Hermes and AI Inference each name both a layer row and a topology hop;
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
    const { container } = render(<HomeView {...props({ chatMetrics: untouched })} />);
    expect(container.querySelector("progress")).toBeNull();
  });

  it("draws no bar while the session is locked, rather than an empty one", () => {
    // A zero-width bar under a dash reads as "nothing is ready" instead of
    // "nobody has looked yet", which is the distinction the whole screen turns on.
    const { container } = render(<HomeView {...props({ unlocked: false })} />);
    expect(container.querySelector("progress")).toBeNull();
  });
});
