/**
 * @vitest-environment jsdom
 *
 * Gateway → Usage, populated. The three things worth pinning here are the ones
 * a rendering mistake would make invisible rather than obvious: that an
 * unmeasured figure draws as a dash and never as zero, that the per-person
 * panel refuses rather than empties when the session lacks `audit:read`, and
 * that the trend carries no inline style the container's CSP would refuse.
 *
 * As with the other view suites, `VIEW_PREVIEW_OUT` writes the rendered markup
 * to a file so the screen can be looked at without a session.
 */
import { ADMIN_SCOPES, type AdministratorSession, type UsageReport } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

function sessionWith(scopes: readonly string[]): AdministratorSession {
  return {
    id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
    subject: "platform-admin",
    role: "PLATFORM_ADMIN",
    scopes: scopes as AdministratorSession["scopes"],
    createdAt: "2026-08-17T00:00:00.000Z",
    idleExpiresAt: "2026-08-17T01:00:00.000Z",
    absoluteExpiresAt: "2026-08-17T08:00:00.000Z",
  };
}

const session = sessionWith([...ADMIN_SCOPES]);
const operationsOnly = sessionWith(["operations:read"]);

const emptyBreakdown = { rows: [], truncated: false, other: null };

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    window: "24h",
    windowStartedAt: "2026-08-16T00:00:00.000Z",
    generatedAt: "2026-08-17T00:00:00.000Z",
    bucket: "hour",
    totals: {
      runs: 40, completed: 36, failed: 3, cancelled: 1, denied: 1, timedOut: 2,
      inputTokens: 120_000, outputTokens: 240_000, reasoningTokens: 0, totalTokens: 360_000,
      tokensReported: 38, tokensUnreported: 2,
      costUsd: null, costReportedRuns: 0, costUnreportedRuns: 40,
      averageLatencyMs: 1_200, p95LatencyMs: 4_300, averageFirstTokenMs: 340,
      failureRate: 3 / 40,
    },
    series: [
      { at: "2026-08-16T09:00:00.000Z", runs: 12, failed: 0, inputTokens: 40_000, outputTokens: 80_000, totalTokens: 120_000, costUsd: null },
      { at: "2026-08-16T10:00:00.000Z", runs: 28, failed: 3, inputTokens: 80_000, outputTokens: 160_000, totalTokens: 240_000, costUsd: null },
    ],
    byModel: {
      rows: [{
        key: "hermes-agent", label: "hermes-agent", runs: 40, failed: 3,
        inputTokens: 120_000, outputTokens: 240_000, totalTokens: 360_000,
        costUsd: null, averageLatencyMs: 1_200,
      }],
      truncated: false,
      other: null,
    },
    byProfile: emptyBreakdown,
    byDivision: {
      rows: [
        { key: null, label: "Deployment-wide", runs: 25, failed: 2, inputTokens: 70_000, outputTokens: 140_000, totalTokens: 210_000, costUsd: null, averageLatencyMs: 1_100 },
        { key: "b0a5d2f9-6a6c-4a3f-9a1a-9c2f5f0d1234", label: "Legal", runs: 15, failed: 1, inputTokens: 50_000, outputTokens: 100_000, totalTokens: 150_000, costUsd: null, averageLatencyMs: 1_400 },
      ],
      truncated: false,
      other: null,
    },
    byUser: {
      rows: [{
        key: "user:ana", label: "user:ana", runs: 40, failed: 3,
        inputTokens: 120_000, outputTokens: 240_000, totalTokens: 360_000,
        costUsd: null, averageLatencyMs: 1_200,
      }],
      truncated: false,
      other: null,
    },
    gateway: { requests: 52, rejected: 4, rejectedByPolicy: 3, rejectedByRateLimit: 1 },
    tools: { calls: 6, completed: 5, denied: 1, failed: 0 },
    ...overrides,
  };
}

const getGatewayUsage = vi.fn(async (window: UsageReport["window"]) => report({ window }));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, getGatewayUsage: (...args: unknown[]) => getGatewayUsage(...args as [UsageReport["window"]]) };
});

const { UsageView } = await import("./usage-view.js");

const dump = (name: string) => {
  const out = process.env.VIEW_PREVIEW_OUT;
  if (out) writeFileSync(out.replace("VIEW", name), document.body.innerHTML, "utf8");
};

async function usageView(active: AdministratorSession | null = session) {
  render(<main><UsageView session={active} onConfigure={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  if (active) await waitFor(() => screen.getByLabelText("Gateway usage summary"));
  dump("usage");
}

afterEach(() => {
  cleanup();
  getGatewayUsage.mockClear();
});

describe("gateway usage", () => {
  it("reports what the window consumed, and reads the default window first", async () => {
    await usageView();

    expect(getGatewayUsage).toHaveBeenCalledWith("24h");
    const summary = within(screen.getByLabelText("Gateway usage summary"));
    expect(summary.getByText("40")).toBeTruthy();
    expect(summary.getByText("360K")).toBeTruthy();
    expect(summary.getByText("7.5%")).toBeTruthy();
  });

  it("draws an unpriced window as a dash rather than as free", async () => {
    /*
     * The one figure a rendering shortcut would quietly falsify. `costUsd` is
     * null because no route reported a price -- an on-premises vLLM does not --
     * and formatting that as `$0.00` is a claim nobody made.
     */
    await usageView();

    const summary = within(screen.getByLabelText("Gateway usage summary"));
    expect(summary.getByText("—")).toBeTruthy();
    expect(summary.queryByText("$0.00")).toBeNull();
    expect(summary.getByText("No route reported a price")).toBeTruthy();
  });

  it("says how many runs went uncounted instead of folding them into the total", async () => {
    await usageView();
    expect(screen.getByText(/2 unreported/)).toBeTruthy();
  });

  it("refetches when the window changes", async () => {
    await usageView();

    await userEvent.selectOptions(screen.getByRole("combobox"), "30d");

    await waitFor(() => expect(getGatewayUsage).toHaveBeenCalledWith("30d"));
  });

  it("gives a deployment-wide row a name rather than a blank cell", async () => {
    await usageView();
    expect(screen.getByText("Deployment-wide")).toBeTruthy();
    expect(screen.getByText("Legal")).toBeTruthy();
  });

  it("refuses the per-person panel rather than drawing it empty", async () => {
    /*
     * The scope split, from the reader's side. A session with
     * `operations:read` and not `audit:read` receives `byUser: null`, and an
     * empty table there would tell an operations admin that nobody has used
     * the system.
     */
    getGatewayUsage.mockImplementationOnce(async (window) => report({ window, byUser: null }));
    await usageView(operationsOnly);

    expect(screen.getByText("This breakdown needs the audit scope")).toBeTruthy();
    expect(screen.queryByText("user:ana")).toBeNull();
  });

  it("locks without a session instead of asking for data it cannot fetch", async () => {
    await usageView(null);
    expect(getGatewayUsage).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    /*
     * The reason the trend is hand-drawn SVG. `style-src 'self'` has no
     * `unsafe-inline`, so a charting library — every one of which writes bar
     * geometry into a style attribute — fails in the container and nowhere
     * else. Geometry lives in SVG presentation attributes instead.
     */
    await usageView();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
    expect(screen.getByRole("img", { name: /Tokens per hour/ })).toBeTruthy();
  });
});
