/**
 * @vitest-environment jsdom
 *
 * Authoring a policy. `governance-views.test.tsx` covers the populated screen;
 * this file covers the one thing that can only be seen by typing — the slug
 * field, which rewrites what it is given on every keystroke.
 */
import { ADMIN_SCOPES, type AdministratorSession, type GuardrailPolicy } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const draftPolicy: GuardrailPolicy = {
  id: "1f2e3d4c-5b6a-4978-8867-564534231201",
  slug: "chat-safety",
  displayName: "Chat safety",
  description: "Approved input and output controls for internal OrcaSynapse chat.",
  version: "1.0.0",
  status: "DRAFT",
  rules: [],
  maxInputCharacters: 12_000,
  maxOutputCharacters: 200_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
  firstActivatedAt: null,
  revision: 1,
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

/** What the API would return now, which a conflict test moves underneath the screen. */
let catalogue: GuardrailPolicy[] = [];

const updateGuardrailPolicy = vi.fn();
const changeGuardrailPolicyState = vi.fn();
const createGuardrailPolicy = vi.fn();

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getGuardrailPolicies: vi.fn(async () => ({ items: catalogue })),
    updateGuardrailPolicy: (...args: unknown[]) => updateGuardrailPolicy(...args as []),
    createGuardrailPolicy: (...args: unknown[]) => createGuardrailPolicy(...args as []),
    changeGuardrailPolicyState: (...args: unknown[]) => changeGuardrailPolicyState(...args as []),
  };
});

const { GuardrailsView } = await import("./guardrails-view.js");
const { OrcaSynapseApiError } = await import("./api.js");

/**
 * Renders, and waits for the load to land rather than for the shell.
 *
 * The header renders before getGuardrailPolicies resolves, so waiting only on
 * "New policy" hands back a screen whose policy cards have not been committed
 * yet and every query for one races the fetch. The two are ordered by the Node
 * event loop, not by React: the timer that resolves waitFor and the task React
 * renders on are in different phases, so on a machine busy enough for the timer
 * to already be due the query runs first and finds no cards at all. Waiting for
 * the cards themselves is what makes the screen the same under a concurrent
 * `pnpm test` as on an idle machine.
 */
async function view() {
  render(<main><GuardrailsView
    session={session}
    onConfigureInference={vi.fn()}
    onSessionExpired={vi.fn()}
  /></main>);
  await screen.findAllByRole("button", { name: "Add control" });
  for (const { displayName } of catalogue) await screen.findByRole("heading", { name: displayName });
}

/** Opens the control dialog on one kind and returns its form. */
async function controlForm(kind: string): Promise<HTMLElement> {
  await view();
  fireEvent.click(screen.getAllByRole("button", { name: "Add control" })[0]!);
  fireEvent.click(within(screen.getByLabelText("Control types")).getByText(kind));
  return document.getElementById("guardrail-control-editor")!;
}


afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  catalogue = [];
  updateGuardrailPolicy.mockReset();
  changeGuardrailPolicyState.mockReset();
  createGuardrailPolicy.mockReset();
});

describe("counting the records", () => {
  it("stops presenting the loaded window as the record count", async () => {
    /*
     * `DrizzleGuardrailManager.list` is a bare `limit: 100` and
     * `GuardrailPolicyList` carries no total, so at the cap the figure under
     * "Policy records" describes the response rather than the table its caption
     * claims to be counting.
     */
    catalogue = Array.from({ length: 100 }, (_, index) => ({
      ...draftPolicy, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, displayName: `Policy ${index}`,
    }));
    render(<main><GuardrailsView
      session={session}
      onConfigureInference={vi.fn()}
      onSessionExpired={vi.fn()}
    /></main>);
    const summary = await screen.findByLabelText("Guardrail policy summary");

    await waitFor(() => expect(within(summary).getByText("100+")).toBeTruthy());
    expect(within(summary).getByText("Newest 100 loaded")).toBeTruthy();
    expect(within(summary).queryByText("Version controlled")).toBeNull();
  });
});

describe("a policy another operator moved first", () => {
  /** The revision the screen loaded is dead; only the one that won can succeed. */
  function conflictOnce() {
    const winner: GuardrailPolicy = { ...draftPolicy, revision: 2 };
    return async (_id: string, ...rest: unknown[]) => {
      const input = rest.at(-1) as { expectedRevision: number };
      if (input.expectedRevision === draftPolicy.revision) {
        catalogue = [winner];
        throw new OrcaSynapseApiError(409, "This guardrail policy changed since it was loaded.");
      }
      return { ...winner, revision: 3 };
    };
  }

  it("activates on the retry after a conflict, instead of failing identically forever", async () => {
    // Nothing on this screen refetches — there is no Refresh control and load()
    // runs only on [session] — so without a refetch here every retry resends
    // the revision that already lost and the only escape is leaving the screen.
    catalogue = [draftPolicy];
    changeGuardrailPolicyState.mockImplementation(conflictOnce());
    await view();

    fireEvent.click(screen.getByRole("button", { name: "Activate draft" }));
    fireEvent.change(screen.getByLabelText(/^Operator reason/), {
      target: { value: "Safety evidence promoted for v1.0.0." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => screen.getByText(/changed since it was loaded/));

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => screen.getByText(/Guardrail policy activated for chat/));
    expect(changeGuardrailPolicyState.mock.calls[1]![2]).toMatchObject({ expectedRevision: 2 });
  });

  it("saves the edit on the retry after a conflict", async () => {
    // The open editor holds its own snapshot of the record, so a refetch that
    // only refreshes the list still leaves the form sending the lost revision.
    catalogue = [draftPolicy];
    updateGuardrailPolicy.mockImplementation(conflictOnce());
    await view();

    // Editing a control saves the whole draft, so the conflict path is the
    // same one a record edit used to take -- but the revision now comes from
    // state at save time rather than from a snapshot the dialog captured.
    const rows = within(screen.getByLabelText("Boundary control rows"));
    fireEvent.click(within(rows.getByText("Input ceiling").closest("li")!).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save control" }));
    await waitFor(() => screen.getByText(/changed since it was loaded/));

    fireEvent.click(screen.getByRole("button", { name: "Save control" }));
    await waitFor(() => screen.getByText(/Input ceiling saved/));
    expect(updateGuardrailPolicy.mock.calls[1]![1]).toMatchObject({ expectedRevision: 2 });
  });
});

describe("saving one control", () => {
  it("writes a whole first boundary from a single word filter", async () => {
    /*
     * The operator's decision is one rule; the record still has to be a
     * complete, versioned boundary because that is what the server enforces
     * and audits. The screen supplies the rest -- version, slug, ceilings --
     * so a blocked word costs one dialog rather than a fifteen-field form.
     */
    catalogue = [];
    createGuardrailPolicy.mockResolvedValue(draftPolicy);
    const form = await controlForm("Word filter");

    fireEvent.change(within(form).getByLabelText(/^Label/), { target: { value: "Internal codename" } });
    fireEvent.change(within(form).getByLabelText(/^Text to match/), { target: { value: "orcaproject" } });
    fireEvent.click(screen.getByRole("button", { name: "Save control" }));

    await waitFor(() => expect(createGuardrailPolicy).toHaveBeenCalled());
    expect(createGuardrailPolicy.mock.calls[0]![0]).toMatchObject({
      version: "1.0.0",
      slug: "chat-boundary-1-0-0",
      rules: [{ type: "WORD", label: "Internal codename", pattern: "orcaproject", action: "BLOCK", enabled: true }],
    });
  });

  it("adds to the open draft under a bumped version rather than starting another record", async () => {
    // The server refuses a material change that reuses a version, and refuses
    // a second ACTIVE record. One draft that accumulates controls is what
    // keeps both true without asking the operator to type a version.
    catalogue = [draftPolicy];
    updateGuardrailPolicy.mockResolvedValue({ ...draftPolicy, revision: 2 });
    const form = await controlForm("Phrase filter");

    fireEvent.change(within(form).getByLabelText(/^Label/), { target: { value: "Client name" } });
    fireEvent.change(within(form).getByLabelText(/^Text to match/), { target: { value: "acme holdings" } });
    fireEvent.click(screen.getByRole("button", { name: "Save control" }));

    await waitFor(() => expect(updateGuardrailPolicy).toHaveBeenCalled());
    expect(createGuardrailPolicy).not.toHaveBeenCalled();
    expect(updateGuardrailPolicy.mock.calls[0]![0]).toBe(draftPolicy.id);
    expect(updateGuardrailPolicy.mock.calls[0]![1]).toMatchObject({
      version: "1.0.1",
      expectedRevision: 1,
      rules: [{ type: "PHRASE", pattern: "acme holdings" }],
    });
  });
});
