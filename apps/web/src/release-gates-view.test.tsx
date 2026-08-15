/**
 * @vitest-environment jsdom
 *
 * Release gates, populated.
 *
 * The screen was carved out of Operations by moving the evaluation-card markup
 * across verbatim, which carried the same defect with it: a themed outer card
 * wrapping a `<header>`, a stat grid, a rationale quote and a `<footer>` that
 * had no classes at all. Nothing rendered the composition, and nothing tested
 * it either — this file is the first coverage the view has had.
 *
 * jsdom applies no stylesheet, so a class name is the only evidence a layout
 * exists. Every assertion below fails against the unstyled markup and was
 * re-checked by deleting the class it names from the view.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so the screen can be looked at
 * without a session or a seeded deployment; see `chat-transcript.test.tsx`.
 */
import { ADMIN_SCOPES, type AdministratorSession, type EvaluationRun } from "@orcasynapse/contracts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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

/** Read-only: the state the old shared tab strip expressed by disabling a tab. */
const reader: AdministratorSession = { ...session, scopes: ["evaluations:read"] };

const promoted: EvaluationRun = {
  id: "3f2b6c19-8d54-4a71-9d3e-72c1f0a54b18",
  name: "Laguna-S chat release",
  targetType: "MODEL",
  targetReference: "laguna-s",
  targetVersion: "2026.08.1-a41f9c",
  status: "PROMOTED",
  minimumPassRate: 0.95,
  requiredCategories: ["CHAT", "RETRIEVAL", "TOOL_USE", "SAFETY", "PERMISSIONS"],
  results: [],
  totalCases: 480,
  passedCases: 472,
  criticalFailures: 0,
  passRate: 0.9833,
  createdAt: "2026-08-07T08:00:00.000Z",
  completedAt: "2026-08-07T09:00:00.000Z",
  promotedAt: "2026-08-07T10:00:00.000Z",
  promotionReason: "Evidence reviewed with the safety owner; approved for the controlled pilot.",
};

/** The other end of the lifecycle: nothing recorded, so nothing to promote. */
const draft: EvaluationRun = {
  id: "b7d5e0a2-1c46-4f38-8a90-2ed4c6b7f331",
  name: "Hermes tool policy candidate",
  targetType: "POLICY",
  targetReference: "hermes-policy",
  targetVersion: "3.4.0",
  status: "DRAFT",
  minimumPassRate: 0.95,
  requiredCategories: ["SAFETY", "PERMISSIONS"],
  results: [],
  totalCases: 0,
  passedCases: 0,
  criticalFailures: 0,
  passRate: null,
  createdAt: "2026-08-07T10:30:00.000Z",
  completedAt: null,
  promotedAt: null,
  promotionReason: null,
};

let runs: EvaluationRun[] = [promoted, draft];

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getEvaluationRuns: vi.fn(async () => ({ items: runs })),
  };
});

const { ReleaseGatesView } = await import("./release-gates-view.js");
const { getEvaluationRuns } = await import("./api.js");

/**
 * Renders and waits for the cards themselves rather than for the header.
 *
 * `PageHeader` paints before `getEvaluationRuns` resolves, so waiting on
 * "Refresh" hands back a screen whose cards have not been committed and every
 * query races the fetch — the trap `guardrails-view.test.tsx` documents.
 */
async function view(as: AdministratorSession = session) {
  render(<main><ReleaseGatesView session={as} onConfigure={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  for (const run of runs) await screen.findByRole("heading", { name: run.name });
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

/** The card for a run, asserted present before anything is read off it. */
async function card(name: string, as: AdministratorSession = session): Promise<HTMLElement> {
  await view(as);
  const article = screen.getByRole("heading", { name }).closest("article");
  expect(article).toBeTruthy();
  return article as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  runs = [promoted, draft];
});

describe("evaluation record card", () => {
  it("names the artifact, then its exact version, then where it stands", async () => {
    const article = await card("Laguna-S chat release");
    const header = article.querySelector("header");
    expect(header).toBeTruthy();
    expect(header!.className).toContain("flex");

    // Kicker over title, the same order every other record in the product uses.
    expect(within(header!).getByText("Model").className).toContain("text-micro");
    expect(within(header!).getByRole("heading", { name: "Laguna-S chat release" }).className)
      .toContain("font-display");

    // The version is the whole point of the screen: evidence is per version, so
    // the reference alone would be a claim about the wrong artifact.
    const reference = within(header!).getByText(/laguna-s/);
    expect(reference.className).toContain("font-mono");
    expect(reference.textContent).toContain("2026.08.1-a41f9c");

    // `<strong className="promoted">` was a class with no rule behind it.
    const status = within(header!).getByText("Promoted");
    expect(status.className).toContain("tracking-[0.07em]");
    expect(status.className).toContain("text-success");
  });

  it("states the evidence as a labelled definition list, not four bare divs", async () => {
    const article = await card("Laguna-S chat release");
    const list = article.querySelector("dl");
    expect(list).toBeTruthy();
    expect(list!.className).toContain("grid-cols-2");
    expect(list!.className).toContain("sm:grid-cols-4");

    const terms = [...list!.querySelectorAll("dt")];
    const details = [...list!.querySelectorAll("dd")];
    // Counts pinned first: a `for` over an empty NodeList asserts nothing and
    // still reports success.
    expect(terms.map((term) => term.textContent))
      .toEqual(["Observed pass rate", "Cases passed", "Critical failures", "Required minimum"]);
    expect(details.map((detail) => detail.textContent)).toEqual(["98.3%", "472/480", "0", "95%"]);
    for (const term of terms) expect(term.className).toContain("text-micro");
    for (const detail of details) expect(detail.className).toContain("tabular-nums");
  });

  it("draws the required categories as chips instead of a run-on line", async () => {
    const article = await card("Hermes tool policy candidate");
    const chips = [...article.querySelectorAll("code")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Safety", "Permissions"]);
    for (const chip of chips) expect(chip.className).toContain("bg-raised");
  });

  it("labels the promotion rationale and keeps its accent stripe", async () => {
    const article = await card("Laguna-S chat release");
    const rationale = article.querySelector("blockquote");
    expect(rationale).toBeTruthy();
    expect(within(rationale!).getByText("Promotion rationale").className).toContain("text-micro");
    expect(rationale!.textContent).toContain("approved for the controlled pilot");
    expect(rationale!.className).toContain("border-l-accent");
  });

  it("closes the card with a footer row: when it happened, then what can be done", async () => {
    const article = await card("Laguna-S chat release");
    const footer = article.querySelector("footer");
    expect(footer).toBeTruthy();
    expect(footer!.className).toContain("flex");
    expect(footer!.className).toContain("justify-between");
    // Separated from the evidence above it rather than floating against it.
    expect(footer!.className).toContain("border-t");
    expect(within(footer!).getByText(/^Created /).textContent).toContain("promoted");
  });

  /*
   * The tone stripe Operations uses, carried across so the two ledgers read as
   * one family. Promotion is the only state that means "this shipped".
   */
  it("carries the status on a left stripe, as the incident ledger does", async () => {
    await view();
    const shipped = screen.getByRole("heading", { name: "Laguna-S chat release" }).closest("article");
    const candidate = screen.getByRole("heading", { name: "Hermes tool policy candidate" }).closest("article");
    expect(shipped).toBeTruthy();
    expect(candidate).toBeTruthy();
    expect(shipped!.className).toContain("border-l-good");
    expect(candidate!.className).toContain("border-l-warn");
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await view();
    // Asserted against a screen that actually drew both cards, so the check
    // cannot pass because there was nothing on the page.
    expect(document.body.innerHTML).toContain("Laguna-S chat release");
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});

describe("what a session may do with a candidate", () => {
  it("offers evidence on a draft and promotion on nothing else", async () => {
    const article = await card("Hermes tool policy candidate");
    expect(within(article).getByRole("button", { name: "Record evidence" })).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "Promote" })).toBeNull();
  });

  it("shows a reader the evidence and none of the controls", async () => {
    const article = await card("Hermes tool policy candidate", reader);
    // The card is on screen, so the absences below are absences and not an
    // empty page reporting success.
    expect(within(article).getByText("Observed pass rate")).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "Record evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New candidate" })).toBeNull();
  });

  it("does not reload on every parent render, which App produces every few seconds", async () => {
    // Same shape as Operations: App polls and hands down a fresh
    // `onSessionExpired` arrow each time, and tracking that identity through
    // handleError -> refresh refetches forever, disabling every submit.
    const props = { session, onConfigure: vi.fn() };
    const { rerender } = render(
      <main><ReleaseGatesView {...props} onSessionExpired={() => undefined} /></main>,
    );
    await screen.findByRole("heading", { name: "Laguna-S chat release" });
    const loads = vi.mocked(getEvaluationRuns).mock.calls.length;

    rerender(<main><ReleaseGatesView {...props} onSessionExpired={() => undefined} /></main>);
    await act(async () => { await Promise.resolve(); });

    expect(vi.mocked(getEvaluationRuns).mock.calls.length).toBe(loads);
  });
});
