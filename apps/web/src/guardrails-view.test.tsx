/**
 * @vitest-environment jsdom
 *
 * Authoring a policy. `governance-views.test.tsx` covers the populated screen;
 * this file covers the one thing that can only be seen by typing — the slug
 * field, which rewrites what it is given on every keystroke.
 */
import { ADMIN_SCOPES, type AdministratorSession, type GuardrailPolicy } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getGuardrailPolicies: vi.fn(async () => ({ items: catalogue })),
    updateGuardrailPolicy: (...args: unknown[]) => updateGuardrailPolicy(...args as []),
    changeGuardrailPolicyState: (...args: unknown[]) => changeGuardrailPolicyState(...args as []),
  };
});

const { GuardrailsView } = await import("./guardrails-view.js");
const { OrcaSynapseApiError } = await import("./api.js");

/**
 * Types one character at a time, which is the only way a keystroke-by-keystroke
 * rewrite can be observed. Setting the whole string at once hides it.
 */
function typeInto(input: HTMLElement, text: string) {
  const control = input as HTMLInputElement;
  for (const character of text) {
    fireEvent.change(control, { target: { value: control.value + character } });
  }
}

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
    onOpenOperations={vi.fn()}
    onSessionExpired={vi.fn()}
  /></main>);
  await screen.findByRole("button", { name: "New policy" });
  for (const { displayName } of catalogue) await screen.findByRole("heading", { name: displayName });
}

async function editor(): Promise<HTMLElement> {
  await view();
  fireEvent.click(screen.getByRole("button", { name: "New policy" }));
  const slug = screen.getByLabelText(/^Policy slug/);
  fireEvent.change(slug, { target: { value: "" } });
  return slug;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  catalogue = [];
  updateGuardrailPolicy.mockReset();
  changeGuardrailPolicyState.mockReset();
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

    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy revision" }));
    await waitFor(() => screen.getByText(/changed since it was loaded/));

    fireEvent.click(screen.getByRole("button", { name: "Save policy revision" }));
    await waitFor(() => screen.getByText(/Policy updated/));
    expect(updateGuardrailPolicy.mock.calls[1]![1]).toMatchObject({ expectedRevision: 2 });
  });
});

describe("naming a new policy", () => {
  it("lets a hyphen be typed into the slug, because every seeded slug has one", async () => {
    // Trimming the trailing hyphen on each keystroke deletes the separator
    // before the next character arrives, so 'chat-safety' would be unreachable
    // by typing.
    const slug = await editor();
    typeInto(slug, "chat-safety");
    expect(slug).toHaveProperty("value", "chat-safety");
  });

  it("trims a half-typed trailing hyphen when the field is left", async () => {
    const slug = await editor();
    typeInto(slug, "chat-safety-");
    fireEvent.blur(slug);
    expect(slug).toHaveProperty("value", "chat-safety");
  });
});
