/**
 * @vitest-environment jsdom
 *
 * Authoring a suite. `VIEW_PREVIEW_OUT` dumps the rendered drawer, the same
 * trick the view tests use — see `benchmarks-view.test.tsx`.
 */
import type { BenchmarkSuite, CreateBenchmarkSuite, UpdateBenchmarkSuite } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const existing: BenchmarkSuite = {
  id: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b",
  slug: "chat-baseline",
  displayName: "Chat baseline",
  description: "The questions this installation must keep answering correctly.",
  kind: "CHAT_QUALITY",
  cases: [{
    id: "cites-runbook",
    prompt: "What should we check before promoting?",
    intent: "A promotion question must cite the runbook.",
    assertions: [{ kind: "MUST_INCLUDE", value: "migrations" }],
  }],
  passThreshold: 0.9,
  revision: 2,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

const createBenchmarkSuite = vi.fn(async (_input: CreateBenchmarkSuite) => existing);
const updateBenchmarkSuite = vi.fn(async (_id: string, _input: UpdateBenchmarkSuite) => existing);

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    createBenchmarkSuite: (...args: unknown[]) => createBenchmarkSuite(...args as [CreateBenchmarkSuite]),
    updateBenchmarkSuite: (...args: unknown[]) => updateBenchmarkSuite(...args as [string, UpdateBenchmarkSuite]),
  };
});

const { BenchmarkSuiteEditor } = await import("./benchmark-suite-editor.js");

const onSaved = vi.fn();

function editor(suite: BenchmarkSuite | null = null) {
  render(<main><BenchmarkSuiteEditor suite={suite} onSaved={onSaved} onClose={vi.fn()} /></main>);
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
  return screen.getByRole("dialog");
}

/**
 * Fields are matched by a leading-text regex, not an exact string.
 *
 * `Field` renders its hint inside the `<label>`, so a hinted field's accessible
 * name is "Slug Fixed: past runs are filed under it." rather than "Slug".
 */
function field(scope: HTMLElement, label: string): HTMLElement {
  return within(scope).getByLabelText(new RegExp(`^\s*${label}`));
}

function fill(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(field(scope, label), { target: { value } });
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("authoring a suite", () => {
  it("opens with one case that already has a check", async () => {
    // A case with no assertions passes by doing nothing, so the starting point
    // is never that shape.
    const drawer = editor();
    expect(within(drawer).getByText("Cases (1)")).toBeTruthy();
    expect(within(drawer).getByLabelText("Case case-1 check 1 kind")).toHaveProperty("value", "MUST_INCLUDE");
  });

  it("derives the slug from the name so the operator does not invent one", () => {
    const drawer = editor();
    fill(drawer, "Display name", "Chat baseline (core)");
    expect(field(drawer, "Slug")).toHaveProperty("value", "chat-baseline-core");
  });

  it("sends what was authored", async () => {
    const drawer = editor();
    fill(drawer, "Display name", "Chat baseline");
    fill(drawer, "Description", "The questions this installation must keep answering.");
    fill(drawer, "Question", "What should we check before promoting?");
    fill(drawer, "Why this case exists", "A promotion question must cite the runbook.");
    fill(drawer, "Case case-1 check 1 value", "migrations");

    fireEvent.click(within(drawer).getByRole("button", { name: "Create suite" }));
    await waitFor(() => expect(createBenchmarkSuite).toHaveBeenCalledWith(expect.objectContaining({
      slug: "chat-baseline",
      kind: "CHAT_QUALITY",
      passThreshold: 0.9,
      cases: [expect.objectContaining({ id: "case-1", assertions: [{ kind: "MUST_INCLUDE", value: "migrations" }] })],
    })));
  });

  it("adds and removes cases and checks", () => {
    const drawer = editor();
    fireEvent.click(within(drawer).getByRole("button", { name: "Add case" }));
    expect(within(drawer).getByText("Cases (2)")).toBeTruthy();

    fireEvent.click(within(drawer).getAllByRole("button", { name: "Add check" })[0]!);
    expect(within(drawer).getByLabelText("Case case-1 check 2 kind")).toBeTruthy();

    fireEvent.click(within(drawer).getByRole("button", { name: "Remove check 2 from case-1" }));
    expect(within(drawer).queryByLabelText("Case case-1 check 2 kind")).toBeNull();

    fireEvent.click(within(drawer).getAllByRole("button", { name: "Remove case" })[1]!);
    expect(within(drawer).getByText("Cases (1)")).toBeTruthy();
  });

  it("refuses to save two cases sharing an id, and says why", () => {
    // The id names a row in the results, so a reused one hides a regression in
    // the second case.
    const drawer = editor();
    fireEvent.click(within(drawer).getByRole("button", { name: "Add case" }));
    fill(drawer, "Case case-2 check 1 value", "anything");
    fireEvent.change(within(drawer).getAllByLabelText("Case id")[1]!, { target: { value: "case-1" } });

    expect(within(drawer).getByText(/share the id 'case-1'/)).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Create suite" })).toHaveProperty("disabled", true);
  });

  it("takes a whole number of milliseconds for a latency check", () => {
    // The contract refuses anything else, so the field should not invite it.
    const drawer = editor();
    fireEvent.change(within(drawer).getByLabelText("Case case-1 check 1 kind"), {
      target: { value: "MAX_LATENCY_MS" },
    });
    expect(within(drawer).getByLabelText("Case case-1 check 1 value")).toHaveProperty("type", "number");
  });
});

describe("editing a suite", () => {
  it("fixes the slug and the kind, because past runs are filed under them", () => {
    const drawer = editor(existing);
    expect(field(drawer, "Slug")).toHaveProperty("disabled", true);
    expect(field(drawer, "Exercises")).toHaveProperty("disabled", true);
  });

  it("sends the revision it was opened at, so two editors cannot overwrite each other", async () => {
    const drawer = editor(existing);
    fill(drawer, "Display name", "Chat baseline (core)");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateBenchmarkSuite).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ expectedRevision: 2, displayName: "Chat baseline (core)" }),
    ));
  });

  it("renders no inline style, which the CSP would refuse in the built container", () => {
    editor(existing);
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
