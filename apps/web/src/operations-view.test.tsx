/**
 * @vitest-environment jsdom
 *
 * The operational control room, populated — four tabs over health, incidents,
 * release gates and pilot readiness, and no test until now.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so it can be looked at without
 * a session; see `chat-transcript.test.tsx`.
 */
import { ADMIN_SCOPES, type AdministratorSession } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-08-07T00:00:00.000Z",
  idleExpiresAt: "2026-08-07T01:00:00.000Z",
  absoluteExpiresAt: "2026-08-07T08:00:00.000Z",
};

const overview = {
  status: "DEGRADED",
  generatedAt: "2026-08-07T11:00:00.000Z",
  components: [
    { id: "c1", label: "AI Inference", status: "HEALTHY", summary: "vLLM answering within budget.", source: "LAST_VERIFIED", observedAt: "2026-08-07T10:58:00.000Z", affectedWorkflows: ["TOOL_USE"] },
    { id: "c2", label: "Hermes runtime", status: "DEGRADED", summary: "One node missed its last heartbeat.", source: "LIVE", observedAt: "2026-08-07T10:59:00.000Z", affectedWorkflows: [] },
  ],
  guardrails: [
    { layer: "APPLICATION", label: "Chat boundary", status: "ENFORCED", summary: "Size and credential checks active.", evidence: "policy:baseline-chat v2.0" },
  ],
  incidents: {
    open: 1,
    critical: 1,
    items: [{ id: "i1", title: "Hermes node vm2-b unreachable", severity: "CRITICAL", status: "OPEN", detectedAt: "2026-08-07T10:40:00.000Z", lastObservedAt: "2026-08-07T10:59:00.000Z", component: "hermes-vm2", owner: null, summary: "No heartbeat for 19 minutes.", automated: true, resolutionNote: null }],
  },
  evaluations: { drafts: 1, passed: 2, failed: 0, promoted: 1 },
  metrics: {
    chat: { responses: 1_284, failureRate: 0.012, averageLatencyMs: 4_120 },
    documents: { processing: 0, ready: 12, failed: 1, retainedSourceBytes: 0 },
    agents: { runningRuns: 1, queuedRuns: 0, failedRuns: 2 },
    tools: { executingCalls: 0, pendingApprovals: 1, deniedCalls: 3 },
  },
  runtime: {
    capturedAt: "2026-08-07T11:00:00.000Z",
    workloads: [{ name: "document-index", displayName: "Document indexing", pendingCount: 0, activeCount: 1, failedCount: 2, totalCount: 40 }],
    executors: [{ id: "w1", name: "worker-1", status: "HEALTHY", version: "1.64.0", workloads: ["document-index"], lastSeenAt: "2026-08-07T10:59:50.000Z" }],
  },
};

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getAiOpsOverview: vi.fn(async () => overview),
    getOperationalIncidents: vi.fn(async () => ({ items: overview.incidents.items })),
    getEvaluationRuns: vi.fn(async () => ({ items: [] })),
    getProductionReadiness: vi.fn(async () => ({
      status: "NOT_READY",
      summary: { blockedControls: 2, verifiedControls: 4, totalControls: 6 },
      controls: [
        { key: "backup", label: "Backup drill", status: "BLOCKED", category: "RECOVERY", detail: "No restore has been rehearsed.", evidenceRef: null, updatedAt: "2026-08-07T09:00:00.000Z" },
      ],
      approvals: [],
    })),
  };
});

const { OperationsView } = await import("./operations-view.js");

async function view() {
  render(<main><OperationsView session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByText("Hermes runtime"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(cleanup);

describe("operations control room", () => {
  it("puts the degraded component first, since that is the one to act on", async () => {
    await view();
    const topology = screen.getByText("Service topology").closest("section")!;
    const labels = within(topology).getAllByText(/AI Inference|Hermes runtime/).map((node) => node.textContent);
    expect(labels[0]).toBe("Hermes runtime");
  });

  it("distinguishes a live reading from a last-verified one", async () => {
    // A cached connection test presented as live state is how an operator ends
    // up trusting a service that stopped answering an hour ago.
    await view();
    expect(screen.getByText(/^Verified /)).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("carries the open-incident count on the tab, from whichever tab you are on", async () => {
    await view();
    const tabs = screen.getByLabelText("AI operations views");
    expect(within(tabs).getByText("1")).toBeTruthy();
    expect(within(tabs).getByText("2")).toBeTruthy();
  });

  it("marks a failed workload count without recolouring the healthy ones", async () => {
    await view();
    const failed = screen.getByText("2", { selector: "td" });
    expect(failed.className).toContain("text-bad");
  });

  it("reaches the incident ledger and keeps the severity legible there", async () => {
    const user = userEvent.setup();
    await view();
    await user.click(screen.getByRole("button", { name: /Incidents/ }));
    expect(await screen.findByText("Hermes node vm2-b unreachable")).toBeTruthy();
    expect(screen.getAllByText("Critical").length).toBeGreaterThan(0);
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
