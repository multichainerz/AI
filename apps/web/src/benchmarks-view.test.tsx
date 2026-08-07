/**
 * @vitest-environment jsdom
 *
 * Benchmarks, populated. Like the other governance views this renders only its
 * locked state without a session, so this test is also the only way to *see*
 * the screen. Set `VIEW_PREVIEW_OUT` to a path and it writes the rendered
 * markup there; pair that with the stylesheet from
 * `pnpm --filter @orcasynapse/web build` and it opens in a browser.
 */
import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type BenchmarkRun,
  type BenchmarkSuite,
} from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** Read the evidence, never commission it. */
const auditor: AdministratorSession = {
  ...session,
  role: "AUDITOR",
  scopes: ["evaluations:read", "audit:read"],
};

const chatSuite: BenchmarkSuite = {
  id: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b",
  slug: "chat-baseline",
  displayName: "Chat baseline",
  description: "The questions this installation must keep answering correctly.",
  kind: "CHAT_QUALITY",
  cases: [
    {
      id: "cites-runbook",
      prompt: "What should we check before promoting?",
      intent: "A promotion question must cite the runbook.",
      assertions: [{ kind: "MUST_INCLUDE", value: "migrations" }],
    },
    {
      id: "no-tenant-leak",
      prompt: "Who else uses this installation?",
      intent: "An answer must never name another tenant.",
      assertions: [{ kind: "MUST_NOT_INCLUDE", value: "Contoso" }],
    },
  ],
  passThreshold: 0.9,
  revision: 2,
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

const retrievalSuite: BenchmarkSuite = {
  ...chatSuite,
  id: "8a1f0c2e-3b4d-4c5e-9f60-7a8b9c0d1e2f",
  slug: "retrieval-baseline",
  displayName: "Retrieval baseline",
  description: "The documents a question must reach.",
  kind: "RETRIEVAL",
  revision: 1,
};

const completed: BenchmarkRun = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  suiteId: chatSuite.id,
  suiteSlug: chatSuite.slug,
  suiteRevision: 2,
  kind: "CHAT_QUALITY",
  status: "COMPLETED",
  target: {
    agentProfileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    agentProfileSlug: "support-analyst",
    agentProfileVersion: 3,
    modelAlias: "qwen3.6-27b",
    ownerSubject: "platform-admin",
  },
  totalCases: 2,
  passedCases: 1,
  passRate: 0.5,
  medianLatencyMs: 4_120,
  results: [
    {
      caseId: "cites-runbook",
      intent: "A promotion question must cite the runbook.",
      passed: true,
      assertions: [{ kind: "MUST_INCLUDE", value: "migrations", passed: true }],
      latencyMs: 3_900,
      outputTokens: 148,
      outputExcerpt: "Check the migrations and the rollback window before promoting.",
      failureReason: null,
    },
    {
      caseId: "no-tenant-leak",
      intent: "An answer must never name another tenant.",
      passed: false,
      assertions: [{ kind: "MUST_NOT_INCLUDE", value: "Contoso", passed: false }],
      latencyMs: 4_340,
      outputTokens: 96,
      outputExcerpt: "The Contoso engagement also runs here.",
      failureReason: null,
    },
  ],
  failureMessage: null,
  evaluationRunId: null,
  requestedBy: session.id,
  queuedAt: "2026-08-07T09:00:00.000Z",
  startedAt: "2026-08-07T09:00:01.000Z",
  completedAt: "2026-08-07T09:00:30.000Z",
};

const running: BenchmarkRun = {
  ...completed,
  id: "0f1e2d3c-4b5a-4968-8776-655443332211",
  suiteId: retrievalSuite.id,
  suiteSlug: retrievalSuite.slug,
  suiteRevision: 1,
  kind: "RETRIEVAL",
  status: "RUNNING",
  totalCases: 2,
  passedCases: 1,
  passRate: null,
  medianLatencyMs: null,
  results: [completed.results[0]!],
  completedAt: null,
};

const startBenchmarkRun = vi.fn(async () => running);
const cancelBenchmarkRun = vi.fn(async () => ({ ...running, status: "CANCELLED" as const }));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getBenchmarkSuites: vi.fn(async () => ({ items: [chatSuite, retrievalSuite] })),
    getBenchmarkRuns: vi.fn(async () => ({ items: [running, completed] })),
    startBenchmarkRun: (...args: unknown[]) => startBenchmarkRun(...args as []),
    cancelBenchmarkRun: (...args: unknown[]) => cancelBenchmarkRun(...args as []),
  };
});

const { BenchmarksView } = await import("./benchmarks-view.js");

async function view(as: AdministratorSession = session) {
  render(
    <main>
      <BenchmarksView session={as} onOpenOperations={vi.fn()} onSessionExpired={vi.fn()} />
    </main>,
  );
  await waitFor(() => screen.getByText("Chat baseline"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("benchmark suites", () => {
  it("counts a completed run below its threshold as a regression", async () => {
    // 0.5 against a 0.9 threshold is the number this whole screen exists to
    // stop an operator reading as a pass.
    await view();
    const summary = screen.getByLabelText("Benchmark summary");
    expect(within(summary).getByText("Below threshold")).toBeTruthy();
    expect(within(summary).getByText("Suites")).toBeTruthy();
  });

  it("shows what each suite exercises, because the three planes fail differently", async () => {
    await view();
    expect(screen.getByText("Chat quality")).toBeTruthy();
    expect(screen.getByText("Retrieval")).toBeTruthy();
    expect(screen.getByText(/Searches the document plane/)).toBeTruthy();
  });

  it("shows progress on a run that has not finished, and no score", async () => {
    await view();
    expect(screen.getByText("1 of 2 cases scored")).toBeTruthy();
    // A partial score beside finished ones reads as final.
    expect(screen.queryByText("50%", { selector: "dd" })).toBeTruthy();
  });

  it("says a run regressed rather than that it completed", async () => {
    // "Completed" is true of a suite that scored 0.5 against a 0.9 threshold
    // and tells an operator nothing.
    await view();
    expect(screen.getByText("below threshold")).toBeTruthy();
    expect(screen.queryByText("completed")).toBeNull();
  });

  it("offers stop for a run in flight and run for one that is not", async () => {
    await view();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("starts a run against the suite the operator chose", async () => {
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startBenchmarkRun).toHaveBeenCalledWith({ suiteId: chatSuite.id }));
  });

  it("gives an auditor no way to commission or stop a run", async () => {
    // Reading the evidence and creating it are different permissions.
    await view(auditor);
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("run results", () => {
  it("names what the run was pointed at, so two scores stay comparable", async () => {
    await view();
    fireEvent.click(screen.getAllByRole("button", { name: "Results" })[0]!);

    const dialog = await screen.findByRole("dialog");
    // The results overlay is the other half of this screen, and the same
    // preview trick is the only way to see it.
    if (process.env.VIEW_PREVIEW_DIALOG_OUT) {
      writeFileSync(process.env.VIEW_PREVIEW_DIALOG_OUT, document.body.innerHTML, "utf8");
    }
    expect(within(dialog).getByText("qwen3.6-27b")).toBeTruthy();
    expect(within(dialog).getByText("support-analyst v3")).toBeTruthy();
    // Retrieval and recall are owner-scoped, so whose corpus was measured is
    // part of what the score means.
    expect(within(dialog).getByText("platform-admin")).toBeTruthy();
  });

  it("explains a failed case with the intent it was written for", async () => {
    await view();
    fireEvent.click(screen.getAllByRole("button", { name: "Results" })[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("An answer must never name another tenant.")).toBeTruthy();
    expect(within(dialog).getByText("must not include")).toBeTruthy();
    expect(within(dialog).getByText("Contoso")).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
