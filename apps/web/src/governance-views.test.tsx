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
  render(<main><GuardrailsView session={session} onConfigureInference={vi.fn()} onOpenOperations={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByRole("heading", { name: "Baseline chat boundary" }));
  dump("guardrails");
}

afterEach(cleanup);

describe("guardrails", () => {
  it("names the policy enforcing chat and the checks it turns on", async () => {
    await guardrailsView();
    expect(screen.getByText("Baseline chat boundary v2.0 is enforcing chat.")).toBeTruthy();
    expect(screen.getByText("control chars")).toBeTruthy();
    expect(screen.getByText("credentials")).toBeTruthy();
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
    expect(within(summary).getByText("Active checks")).toBeTruthy();
    expect(within(summary).getByText("4")).toBeTruthy();
    expect(within(summary).getByText("2 built-in · 2 rules")).toBeTruthy();
  });

  it("offers Suspend on the active policy, which is the fail-closed decision", async () => {
    await guardrailsView();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("says that guardrails inspect what is sent, and makes no claim about responses", async () => {
    /*
     * The scope claim, pinned. This screen is the deployment's statement of
     * what it filters, and an operator reading "guardrails" reasonably assumes
     * both directions. Nothing inspects response content — only its length is
     * capped — so the screen has to say so in words rather than leave it to be
     * inferred from an absence.
     */
    await guardrailsView();
    expect(screen.getByText(/what is sent to the model/)).toBeTruthy();
    expect(screen.getByText(/Responses are capped in length but their content is not inspected/)).toBeTruthy();
  });

  it("warns that editing a rule returns the policy to Draft", async () => {
    // Rules are a material change like any threshold, so an operator who edits
    // one and lands back in Draft has to have been told that is the design.
    await guardrailsView();
    await userEvent.click(screen.getByRole("button", { name: "New policy" }));
    expect(screen.getByText(/Changing a limit, a detector or a rule requires a new version number/)).toBeTruthy();
  });

  it("keeps Save reachable when the form grows past the viewport", async () => {
    /*
     * The regression the rules editor caused. At >=761px `.workspace-page` is
     * `height: 100dvh; overflow: hidden`, so a form taller than the space
     * available is simply cut off -- and the editor panel was `shrink-0` with
     * no overflow of its own, which made the bottom of the form, Save
     * included, unreachable with nothing to scroll.
     *
     * jsdom has no layout, so this asserts the structure that makes scrolling
     * possible rather than the scrolling itself: one scroll container holding
     * everything that grows, and the submit button outside it.
     */
    await guardrailsView();
    await userEvent.click(screen.getByRole("button", { name: "New policy" }));

    const body = screen.getByTestId("policy-editor-body");
    expect(body.className).toContain("overflow-y-auto");
    // Without min-h-0 a flex item refuses to shrink below its content, and the
    // overflow above never engages.
    expect(body.className).toContain("min-h-0");

    // The rules live inside the scroll region, because they are what grows.
    expect(within(body).getByLabelText("Guardrail rules")).toBeTruthy();

    // Save does not, because it is the thing being reached for.
    const save = screen.getByRole("button", { name: "Create draft policy" });
    expect(body.contains(save)).toBe(false);
  });

  it("adds and removes a rule row", async () => {
    await guardrailsView();
    await userEvent.click(screen.getByRole("button", { name: "New policy" }));

    const rules = screen.getByLabelText("Guardrail rules");
    expect(within(rules).getByText("No rules. The two checks above still apply.")).toBeTruthy();

    await userEvent.click(within(rules).getByRole("button", { name: "Add rule" }));
    expect(within(rules).getByLabelText("Name")).toBeTruthy();
    // The type selector explains what it will do, rather than making an
    // operator guess whether "word" means substring.
    expect(within(rules).getByText(/does not match/)).toBeTruthy();

    await userEvent.click(within(rules).getByRole("button", { name: "Remove" }));
    expect(within(rules).getByText("No rules. The two checks above still apply.")).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await guardrailsView();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
