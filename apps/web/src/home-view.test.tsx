/**
 * @vitest-environment jsdom
 *
 * Home had no test at all while it was the screen every operator lands on. The
 * cases below are the ones a rebuild can silently break: what a locked session
 * is allowed to see, where the one primary action points, and whether a layer
 * row still routes to the right platform tab.
 */
import type { ChatMetrics } from "@orcasynapse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  { label: "AI Inference", detail: "Approved model serving is reachable", ready: true, action: "Deployment" },
  { label: "Isolated agent runtime", detail: "VM2 is online and Hermes is reachable", ready: true, action: "Deployment" },
  { label: "Active Agent Profile", detail: "Create and activate an Agent Profile", ready, action: "Agents" },
];

// Home reads exactly one field off the metrics payload; enumerating the other
// nineteen would make this test fail every time the chat contract grows.
const chatMetrics = { responses: 1_284 } as ChatMetrics;

function props(overrides: Partial<Parameters<typeof HomeView>[0]> = {}) {
  return {
    apiAvailable: true,
    bootstrapState: "READY" as const,
    unlocked: true,
    passwordChangePending: false,
    healthyConnections: 3,
    monitoring: { enabled: true, intervalSeconds: 300, reason: null, updatedAt: "2026-08-07T00:00:00.000Z", updatedBy: null },
    chatMetrics,
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

    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("Approved model serving is reachable")).toBeNull();
    expect(screen.getAllByText("Sign in to view current readiness")).toHaveLength(3);
    expect(screen.getByText("Sign in to verify")).toBeTruthy();
    expect(screen.getByText("Locked")).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "Sign in" })[0]!);
    expect(onUnlock).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names the next blocking step rather than a generic welcome", () => {
    render(<HomeView {...props()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Finish your private AI workspace");
    expect(screen.getByText("Next: Create and activate an Agent Profile")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
  });

  it("sends the primary action to the blocking step, and to Chat once nothing blocks", async () => {
    const user = userEvent.setup();
    const blocked = vi.fn();
    const { unmount } = render(<HomeView {...props({ onSelect: blocked })} />);
    await user.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(blocked).toHaveBeenCalledWith("Agents");
    unmount();

    const ready = vi.fn();
    render(<HomeView {...props({ readiness: readiness(true), onSelect: ready })} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your agentic workspace is ready");
    await user.click(screen.getByRole("button", { name: "Open Chat" }));
    expect(ready).toHaveBeenCalledWith("Chat");
  });

  it("opens the agentic layer on the nodes tab and the rest on the journey", async () => {
    // VM2 is enrolled under Nodes; landing an operator on the journey tab when
    // they clicked the runtime row is the difference between one click and five.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HomeView {...props({ onSelect })} />);

    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(onSelect).toHaveBeenLastCalledWith("Deployment", "journey");

    await user.click(screen.getAllByRole("button", { name: "Review" })[1]!);
    expect(onSelect).toHaveBeenLastCalledWith("Deployment", "nodes");
  });

  it("says the control plane is offline instead of showing stale figures as live", () => {
    render(<HomeView {...props({ apiAvailable: false })} />);
    expect(screen.getByText("Control plane offline")).toBeTruthy();
  });

  it("keeps the installer banner ahead of everything else until bootstrap completes", () => {
    render(<HomeView {...props({ bootstrapState: "REQUIRED", unlocked: false })} />);
    expect(screen.getByText("Installation required")).toBeTruthy();
    expect(screen.getByText("Run the protected VM1 installer before configuring services.")).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", () => {
    expect(renderToStaticMarkup(<HomeView {...props()} />)).not.toMatch(/\sstyle=/);
  });

  it("draws readiness as a bar, because a fraction has a denominator worth seeing", () => {
    /*
     * The one figure on this screen with a denominator. Moving the banner onto
     * HeroBanner in ai-v1.88.0 dropped the `fill` that drew it, and nothing
     * failed: `Metric` renders the bar only when a caller passes `fill`, the
     * only production caller was this one, and `ui.test.tsx` kept exercising
     * the branch directly. The feature left the product and the tests stayed
     * green. Asserting on the rendered screen is what closes that gap.
     */
    const { container } = render(<HomeView {...props()} />);
    const bar = container.querySelector("progress");
    expect(bar, "the readiness figure renders no progress bar").toBeTruthy();
    // Two of three checks ready, as the default fixture states.
    expect(bar).toHaveProperty("value", 67);
  });

  it("colours the bar by readiness, not by decoration", () => {
    /*
     * The tone reached the component and stopped there: HeroBanner's accent
     * branch forwarded `fill` but not `tone`, so every bar painted white and
     * the three `.is-*` rules had no consumer. Asserting on the class is what
     * makes the difference between "the prop is set" and "the pixel changes".
     */
    const { container } = render(<HomeView {...props()} />);
    expect(container.querySelector("progress")?.className).toContain("is-warn");
  });

  it("draws no bar while the session is locked, rather than an empty one", () => {
    // A zero-width bar under a dash reads as "nothing is ready" instead of
    // "nobody has looked yet", which is the distinction the whole screen turns on.
    const { container } = render(<HomeView {...props({ unlocked: false })} />);
    expect(container.querySelector("progress")).toBeNull();
  });
});
