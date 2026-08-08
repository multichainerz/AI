/**
 * @vitest-environment jsdom
 *
 * Authoring a prompt. `governance-views.test.tsx` covers the populated screen;
 * this file covers the one thing that can only be seen by typing — the slug
 * field, which rewrites what it is given on every keystroke.
 */
import { ADMIN_SCOPES, type AdministratorSession, type PromptTemplate } from "@orcasynapse/contracts";
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

const draftPrompt: PromptTemplate = {
  id: "1f2e3d4c-5b6a-4978-8867-564534231201",
  slug: "orcasynapse-chat-system",
  displayName: "OrcaSynapse chat system",
  description: "Approved system behavior for internal employee chat.",
  purpose: "CHAT_SYSTEM",
  version: "1.0.0",
  status: "DRAFT",
  content: "You are the OrcaSynapse assistant. Be accurate, concise, and explicit about uncertainty.",
  contentChecksum: "a".repeat(64),
  activationEvaluationId: null,
  firstActivatedAt: null,
  revision: 1,
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

/** What the API would return now, which a conflict test moves underneath the screen. */
let catalogue: PromptTemplate[] = [];

const updatePromptTemplate = vi.fn();
const changePromptTemplateState = vi.fn();

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getPromptTemplates: vi.fn(async () => ({ items: catalogue })),
    updatePromptTemplate: (...args: unknown[]) => updatePromptTemplate(...args as []),
    changePromptTemplateState: (...args: unknown[]) => changePromptTemplateState(...args as []),
  };
});

const { PromptsView } = await import("./prompts-view.js");
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
 * The header renders before getPromptTemplates resolves, so waiting only on
 * "New prompt" hands back a screen whose prompt cards have not been committed
 * yet and every query for one races the fetch. The two are ordered by the Node
 * event loop, not by React: the timer that resolves waitFor and the task React
 * renders on are in different phases, so on a machine busy enough for the timer
 * to already be due the query runs first and finds no cards at all. Waiting for
 * the cards themselves is what makes the screen the same under a concurrent
 * `pnpm test` as on an idle machine.
 */
async function view() {
  render(<main><PromptsView
    session={session}
    onOpenOperations={vi.fn()}
    onOpenSettings={vi.fn()}
    onSessionExpired={vi.fn()}
  /></main>);
  await screen.findByRole("button", { name: "New prompt" });
  for (const { displayName } of catalogue) await screen.findByRole("heading", { name: displayName });
}

async function editor(): Promise<HTMLElement> {
  await view();
  fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
  const slug = screen.getByLabelText(/^Prompt slug/);
  fireEvent.change(slug, { target: { value: "" } });
  return slug;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  catalogue = [];
  updatePromptTemplate.mockReset();
  changePromptTemplateState.mockReset();
});

describe("a prompt another operator moved first", () => {
  /** The revision the screen loaded is dead; only the one that won can succeed. */
  function conflictOnce() {
    const winner: PromptTemplate = { ...draftPrompt, revision: 2 };
    return async (_id: string, ...rest: unknown[]) => {
      const input = rest.at(-1) as { expectedRevision: number };
      if (input.expectedRevision === draftPrompt.revision) {
        catalogue = [winner];
        throw new OrcaSynapseApiError(409, "This prompt changed since it was loaded.");
      }
      return { ...winner, revision: 3 };
    };
  }

  it("activates on the retry after a conflict, instead of failing identically forever", async () => {
    // Nothing on this screen refetches — there is no Refresh control and load()
    // runs only on [session] — so without a refetch here every retry resends
    // the revision that already lost and the only escape is leaving the screen.
    catalogue = [draftPrompt];
    changePromptTemplateState.mockImplementation(conflictOnce());
    await view();

    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    fireEvent.change(screen.getByLabelText(/^Operator reason/), {
      target: { value: "CHAT and SAFETY evidence promoted for v1.0.0." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => screen.getByText(/changed since it was loaded/));

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => screen.getByText(/chat-system prompt activated/));
    expect(changePromptTemplateState.mock.calls[1]![2]).toMatchObject({ expectedRevision: 2 });
  });

  it("saves the edit on the retry after a conflict", async () => {
    // The open editor holds its own snapshot of the record, so a refetch that
    // only refreshes the list still leaves the form sending the lost revision.
    catalogue = [draftPrompt];
    updatePromptTemplate.mockImplementation(conflictOnce());
    await view();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save prompt revision" }));
    await waitFor(() => screen.getByText(/changed since it was loaded/));

    fireEvent.click(screen.getByRole("button", { name: "Save prompt revision" }));
    await waitFor(() => screen.getByText(/Prompt revision saved/));
    expect(updatePromptTemplate.mock.calls[1]![1]).toMatchObject({ expectedRevision: 2 });
  });
});

describe("naming a new prompt", () => {
  it("lets a hyphen be typed into the slug, because every seeded slug has one", async () => {
    // Trimming the trailing hyphen on each keystroke deletes the separator
    // before the next character arrives, so 'orcasynapse-chat-system' would be
    // unreachable by typing.
    const slug = await editor();
    typeInto(slug, "orcasynapse-chat-system");
    expect(slug).toHaveProperty("value", "orcasynapse-chat-system");
  });

  it("trims a half-typed trailing hyphen when the field is left", async () => {
    const slug = await editor();
    typeInto(slug, "chat-system-");
    fireEvent.blur(slug);
    expect(slug).toHaveProperty("value", "chat-system");
  });
});
