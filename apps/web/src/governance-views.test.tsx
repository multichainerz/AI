/**
 * @vitest-environment jsdom
 *
 * Guardrails, populated. This file used to pair Prompts with Guardrails as
 * sibling screens; Prompts is gone from Gateway because nothing under
 * `apps/api/src/chat` or `apps/worker/src` reads `PromptTemplate`. Guardrails
 * still release an artefact into the chat path and fail closed when a
 * previously-active policy is suspended.
 *
 * As with `models-view.test.tsx`, `VIEW_PREVIEW_OUT` writes the rendered markup
 * to a file so the screen can be looked at without a session.
 */
import { ADMIN_SCOPES, type AdministratorSession, type GuardrailPolicy } from "@orcasynapse/contracts";
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

const shared = {
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  firstActivatedAt: "2026-08-02T00:00:00.000Z",
  revision: 4,
};

const policies = [
  {
    ...shared,
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    slug: "baseline-chat",
    displayName: "Baseline chat boundary",
    description: "Size ceilings plus the two OrcaSynapse-native detectors.",
    version: "2.0",
    maxInputCharacters: 16_000,
    maxOutputCharacters: 120_000,
    blockControlCharacters: true,
    blockCredentialPatterns: true,
    /*
     * Two enabled and one not, so the "Active checks" figure has something to
     * be wrong about: it counts the two built-in detectors plus enabled rules,
     * and a fixture with an empty list would pass whether or not the rules were
     * counted at all.
     */
    rules: [
      { id: "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e01", label: "Internal codename", type: "WORD", pattern: "seahorse", action: "BLOCK", caseSensitive: false, enabled: true },
      { id: "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e02", label: "Ticket reference", type: "REGEX", pattern: "[A-Z]{2}\\d{6}", action: "REDACT", caseSensitive: true, enabled: true },
      { id: "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e03", label: "Draft wording", type: "PHRASE", pattern: "not for release", action: "FLAG", caseSensitive: false, enabled: false },
    ],
    status: "ACTIVE",
  },
] as unknown as GuardrailPolicy[];

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getGuardrailPolicies: vi.fn(async () => ({ items: policies })),
  };
});

const { GuardrailsView } = await import("./guardrails-view.js");

const dump = (name: string) => {
  const out = process.env.VIEW_PREVIEW_OUT;
  if (out) writeFileSync(out.replace("VIEW", name), document.body.innerHTML, "utf8");
};

async function guardrailsView() {
  render(<main><GuardrailsView session={session} onConfigureInference={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByRole("heading", { name: "Baseline chat boundary" }));
  dump("guardrails");
}

afterEach(cleanup);

describe("guardrails", () => {
  it("names the policy enforcing chat and the checks it turns on", async () => {
    await guardrailsView();
    // The enforcing version, on the one-line strip. The sentence this replaces
    // sat in a prose block above the table; the policy's display name is in the
    // version history at the table's foot, where the record itself lives.
    expect(screen.getByText("Enforcing 2.0")).toBeTruthy();
    // The boundary facts are rows in the one table, stated once -- the chips
    // these replace repeated them on every policy card, and the summary panel
    // that briefly replaced those repeated them a second time above the table.
    const rows = within(screen.getByLabelText("Boundary control rows"));
    expect(rows.getByText("Control characters")).toBeTruthy();
    expect(rows.getByText("Credential patterns")).toBeTruthy();
  });

  it("counts the detectors and the rules that are actually switched on", async () => {
    /*
     * Two built-in detectors plus two enabled rules. The fixture's third rule
     * is disabled and must not be counted, for the same reason a switched-off
     * detector is not: a disabled rule enforces nothing.
     *
     * This asserted `2` while rules existed and were not counted, which meant a
     * policy carrying forty rules reported the same figure as one carrying
     * none — the metric measured configuration rather than enforcement.
     */
    await guardrailsView();
    const summary = screen.getByLabelText("Guardrail policy summary");
    expect(within(summary).getByText("Checks")).toBeTruthy();
    expect(within(summary).getByText("4")).toBeTruthy();
    expect(within(summary).getByText("2 built-in · 2 rules")).toBeTruthy();
  });

  it("offers Suspend on the active policy, which is the fail-closed decision", async () => {
    await guardrailsView();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
    // No record-level Edit: an ACTIVE policy cannot be changed, and controls
    // are edited row by row into a draft rather than by reopening the record.
    const records = screen.getByLabelText("Configured guardrail policies");
    expect(within(records).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("says that guardrails inspect what is sent, and makes no claim about responses", async () => {
    /*
     * The scope claim, pinned. This screen is the deployment's statement of
     * what it filters, and an operator reading "guardrails" reasonably assumes
     * both directions. Nothing inspects response content — only its length is
     * capped — so it has to be said in words rather than inferred from an
     * absence.
     *
     * It moved off the page and into the control chooser when the prose block
     * above the table went: the claim answers "what will this control check?",
     * which is the question being asked at exactly that moment.
     */
    await guardrailsView();
    await userEvent.click(screen.getAllByRole("button", { name: "Add control" })[0]!);
    expect(screen.getByText(/what is sent to the model/)).toBeTruthy();
    expect(screen.getByText(/their content is not inspected/)).toBeTruthy();
  });

  it("promises the enforced boundary is untouched, where an operator is about to edit it", async () => {
    /*
     * Rules are a material change like any threshold, so an operator who edits
     * one and lands back in Draft has to have been told that is the design.
     * The sentence lives in the dialog rather than on the page strip: it is
     * the moment it answers a question, and the strip is one line by intent.
     */
    await guardrailsView();
    await userEvent.click(screen.getAllByRole("button", { name: "Add control" })[0]!);
    expect(screen.getByText(/enforced boundary is untouched until that draft is activated/)).toBeTruthy();
  });

  it("asks what kind of control first, then only that control's fields", async () => {
    /*
     * The whole point of the redesign. Adding one blocked word used to mean
     * filling in a slug, a version, a description, two ceilings and two
     * detectors, because every control shared one record-shaped form.
     */
    await guardrailsView();
    await userEvent.click(screen.getAllByRole("button", { name: "Add control" })[0]!);

    const kinds = screen.getByLabelText("Control types");
    expect(within(kinds).getByText("Word filter")).toBeTruthy();
    expect(within(kinds).getByText("Input ceiling")).toBeTruthy();
    // Singletons already on the boundary cannot be added a second time.
    expect(within(kinds).getAllByText("already set").length).toBeGreaterThan(0);

    await userEvent.click(within(kinds).getByText("Word filter"));

    const form = document.getElementById("guardrail-control-editor")!;
    expect(within(form).getByLabelText(/^Label/)).toBeTruthy();
    expect(within(form).getByLabelText(/^Text to match/)).toBeTruthy();
    // None of the record's own fields are asked for.
    expect(within(form).queryByLabelText(/slug/i)).toBeNull();
    expect(within(form).queryByLabelText(/version/i)).toBeNull();

    // Save sits in the dialog footer, associated by form id rather than by
    // containment, so it is never something to scroll to find.
    const save = screen.getByRole("button", { name: "Save control" });
    expect(form.contains(save)).toBe(false);
    expect(save.getAttribute("form")).toBe("guardrail-control-editor");
  });

  it("lists every control as its own row, ceilings included", async () => {
    await guardrailsView();
    const rows = within(screen.getByLabelText("Boundary control rows"));

    // The fixture policy carries both ceilings, both detectors and its rules,
    // and each is a row rather than a field inside one record card.
    expect(rows.getByText("Input ceiling")).toBeTruthy();
    expect(rows.getByText("Output ceiling")).toBeTruthy();
    expect(rows.getByText("Control characters")).toBeTruthy();
    expect(rows.getByText("Credential patterns")).toBeTruthy();

    // A ceiling is always enforced once a policy exists, so it is editable but
    // never removable; a detector and a filter are both.
    const ceiling = rows.getByText("Input ceiling").closest("li")!;
    expect(within(ceiling).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(ceiling).queryByRole("button", { name: "Remove" })).toBeNull();

    const detector = rows.getByText("Control characters").closest("li")!;
    expect(within(detector).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await guardrailsView();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
