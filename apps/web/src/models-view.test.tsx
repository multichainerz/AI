/**
 * @vitest-environment jsdom
 *
 * Models, populated. Like `chat-transcript.test.tsx`, this is both a test and
 * the only way to *see* the screen: every governance view renders only its
 * locked state without a session, so a screenshot of the running app proves
 * nothing about the catalogue. Set `VIEW_PREVIEW_OUT` to a path and it writes
 * the rendered markup there; pair that with the stylesheet from
 * `pnpm --filter @orcasynapse/web build` and it opens in a browser.
 */
import { ADMIN_SCOPES, type AdministratorSession, type ModelDeployment, type ModelObservation, type ServiceConnectionSummary } from "@orcasynapse/contracts";
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

const connections = [
  { id: "conn-1", displayName: "Primary vLLM", kind: "INFERENCE", enabled: true, status: "HEALTHY" },
] as unknown as ServiceConnectionSummary[];

const model = (over: Partial<ModelDeployment>): ModelDeployment => ({
  id: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b",
  slug: "laguna-hermes",
  displayName: "Laguna Hermes",
  modelAlias: "hermes-agent",
  workload: "AGENT",
  connection: { id: "conn-1", displayName: "Primary vLLM", kind: "INFERENCE", status: "HEALTHY" },
  version: "2.1-nvfp4",
  license: "Approved: internal-use",
  contextWindowTokens: 131_072,
  maxOutputTokens: 8_192,
  maxConcurrentRequests: 2,
  status: "ACTIVE",
  isDefault: true,
  revision: 3,
  firstActivatedAt: "2026-08-01T00:00:00.000Z",
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  ...over,
} as ModelDeployment);

const draftRoute = model({
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  slug: "chat-frontline",
  displayName: "Chat frontline",
  modelAlias: "qwen3.6-27b",
  workload: "CHAT",
  version: "3.6-awq",
  status: "DRAFT",
  isDefault: false,
  revision: 1,
  firstActivatedAt: null,
  license: null,
});

const models = [model({}), draftRoute];

/** What the API would return now, which a conflict test moves underneath the screen. */
let catalogue: ModelDeployment[] = models;
let observed: ModelObservation[] = [];

const updateModelDeployment = vi.fn();
const changeModelDeploymentState = vi.fn();
const createModelDeployment = vi.fn();

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getModelDeployments: vi.fn(async () => ({ items: catalogue })),
    getModelObservations: vi.fn(async () => ({
      connectionId: connections[0]!.id,
      refreshedAt: observed[0]?.lastSeenAt ?? null,
      items: observed,
    })),
    refreshConnectionModels: vi.fn(async () => ({
      connectionId: connections[0]!.id,
      refreshedAt: "2026-08-22T00:00:00.000Z",
      upserted: observed.length,
      vanished: 0,
      items: observed,
      backfill: null,
    })),
    createModelDeployment: (...args: unknown[]) => createModelDeployment(...args as []),
    updateModelDeployment: (...args: unknown[]) => updateModelDeployment(...args as []),
    changeModelDeploymentState: (...args: unknown[]) => changeModelDeploymentState(...args as []),
  };
});

const { ModelsView } = await import("./models-view.js");
const { OrcaSynapseApiError } = await import("./api.js");

async function view() {
  render(
    <main>
      <ModelsView
        session={session}
        connections={connections}
        onConfigureConnections={vi.fn()}
        onOpenOperations={vi.fn()}
        onSessionExpired={vi.fn()}
      />
    </main>,
  );
  await waitFor(() => screen.getByText("Laguna Hermes"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

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

afterEach(() => {
  cleanup();
  catalogue = models;
  observed = [];
  updateModelDeployment.mockReset();
  changeModelDeploymentState.mockReset();
  createModelDeployment.mockReset();
});

describe("a route another operator moved first", () => {
  /** The revision the screen loaded is dead; only the one that won can succeed. */
  function conflictOnce(then: ModelDeployment) {
    return async (_id: string, ...rest: unknown[]) => {
      const input = rest.at(-1) as { expectedRevision: number };
      if (input.expectedRevision === draftRoute.revision) {
        catalogue = [models[0]!, then];
        throw new OrcaSynapseApiError(409, "This model route changed since it was loaded.");
      }
      return { ...then, revision: then.revision + 1 };
    };
  }

  it("activates on the retry after a conflict, instead of failing identically forever", async () => {
    // Without a refetch here every retry resends the revision that already lost
    // and the only escape is leaving the screen.
    changeModelDeploymentState.mockImplementation(
      conflictOnce(model({ ...draftRoute, revision: 2 })),
    );
    await view();

    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    fireEvent.change(screen.getByLabelText(/^Operator reason/), {
      target: { value: "Evidence promoted for 3.6-awq." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => screen.getByText(/changed since it was loaded/));

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => screen.getByText("Model route activated."));
    expect(changeModelDeploymentState.mock.calls[1]![2]).toMatchObject({ expectedRevision: 2 });
  });

  it("saves the edit on the retry after a conflict", async () => {
    // The open editor holds its own snapshot of the record, so a refetch that
    // only refreshes the list still leaves the form sending the lost revision.
    updateModelDeployment.mockImplementation(conflictOnce(model({ ...draftRoute, revision: 2 })));
    await view();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save new revision" }));
    await waitFor(() => screen.getByText(/changed since it was loaded/));

    fireEvent.click(screen.getByRole("button", { name: "Save new revision" }));
    await waitFor(() => screen.getByText(/Model route updated/));
    expect(updateModelDeployment.mock.calls[1]![1]).toMatchObject({ expectedRevision: 2 });
  });
});

describe("naming a new route", () => {
  it("lets a hyphen be typed into the slug, because every seeded slug has one", async () => {
    // Trimming the trailing hyphen on each keystroke deletes the separator
    // before the next character arrives, so 'chat-frontline' would be
    // unreachable by typing.
    await view();
    fireEvent.click(screen.getByRole("button", { name: "New model route" }));
    const slug = screen.getByLabelText(/^Slug/);
    fireEvent.change(slug, { target: { value: "" } });

    typeInto(slug, "chat-frontline");
    expect(slug).toHaveProperty("value", "chat-frontline");
  });

  it("trims a half-typed trailing hyphen when the field is left", async () => {
    await view();
    fireEvent.click(screen.getByRole("button", { name: "New model route" }));
    const slug = screen.getByLabelText(/^Slug/);
    fireEvent.change(slug, { target: { value: "" } });

    typeInto(slug, "chat-frontline-");
    fireEvent.blur(slug);
    expect(slug).toHaveProperty("value", "chat-frontline");
  });

  it("keeps Save reachable when the form grows past the viewport", async () => {
    /*
     * The same structure `governance-views.test.tsx` pins on the guardrail
     * editor, asserted here because this form is the other one that can outgrow
     * its page. At >=761px `.workspace-page` is `height: 100dvh; overflow:
     * hidden`, so a panel that is `shrink-0` with no overflow of its own has
     * its bottom -- Save included -- cut off with nothing to scroll. Ten fields
     * in a three-column grid survives a tall window and does not survive a
     * short one.
     *
     * jsdom has no layout, so this asserts the structure that makes scrolling
     * possible rather than the scrolling itself.
     */
    await view();
    fireEvent.click(screen.getByRole("button", { name: "New model route" }));

    const body = screen.getByTestId("route-editor-body");
    expect(body.className).toContain("overflow-y-auto");
    // Without min-h-0 a flex item refuses to shrink below its content, and the
    // overflow above never engages.
    expect(body.className).toContain("min-h-0");

    // The fields live inside the scroll region, because they are what grows.
    expect(within(body).getByLabelText(/^Slug/)).toBeTruthy();

    // Save does not, because it is the thing being reached for.
    const save = screen.getByRole("button", { name: "Create draft route" });
    expect(body.contains(save)).toBe(false);
  });
});

describe("models catalogue", () => {
  it("counts the catalogue by the things an operator decides about", async () => {
    await view();
    const summary = screen.getByLabelText("Model catalogue summary");

    // Two routes, one active, one default, two workloads.
    expect(within(summary).getByText("Admitted routes")).toBeTruthy();
    expect(within(summary).getAllByText("2")).not.toHaveLength(0);
  });

  it("stops presenting the loaded window as the catalogue's size", async () => {
    /*
     * `DrizzleModelManager.list` is a bare `limit: 200` and the contract has no
     * total, so at the cap `models.length` is the size of the response and not
     * of the catalogue -- while the label above it says "Catalogue routes" and
     * the caption below says "Versioned records". Both describe the table.
     */
    catalogue = Array.from({ length: 200 }, (_, index) => model({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      slug: `route-${index}`,
      displayName: `Route ${index}`,
    }));
    render(
      <main>
        <ModelsView
          session={session}
          connections={connections}
          onConfigureConnections={vi.fn()}
          onOpenOperations={vi.fn()}
          onSessionExpired={vi.fn()}
        />
      </main>,
    );
    const summary = await screen.findByLabelText("Model catalogue summary");

    await waitFor(() => expect(within(summary).getByText("200+")).toBeTruthy());
    expect(within(summary).getByText("Newest 200 loaded")).toBeTruthy();
    expect(within(summary).queryByText("Versioned records")).toBeNull();
    expect(within(summary).getByText("Admitted routes")).toBeTruthy();
  });

  it("defaults Activate to make-default for AGENT routes, not CHAT", async () => {
    const draftAgent = model({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      slug: "draft-agent",
      displayName: "Draft agent",
      workload: "AGENT",
      status: "DRAFT",
      isDefault: false,
      firstActivatedAt: null,
    });
    catalogue = [draftAgent, draftRoute];
    render(
      <main>
        <ModelsView
          session={session}
          connections={connections}
          onConfigureConnections={vi.fn()}
          onOpenOperations={vi.fn()}
          onSessionExpired={vi.fn()}
        />
      </main>,
    );
    await waitFor(() => screen.getByText("Draft agent"));

    fireEvent.click(screen.getAllByRole("button", { name: "Activate" })[0]!);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Activate" })[1]!);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("distinguishes a route that is serving from one that is not", async () => {
    await view();

    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("draft")).toBeTruthy();
    // The default carries a mark, because "which one answers by default" is not
    // derivable from anything else on the card.
    expect(screen.getByText("Default")).toBeTruthy();
  });

  it("shows the immutable version, which is what a route is pinned to", async () => {
    await view();
    expect(screen.getByText("2.1-nvfp4")).toBeTruthy();
    expect(screen.getByText("3.6-awq")).toBeTruthy();
    // Whether a route has ever served traffic is the fact the card carries:
    // suspending one that has is the fail-closed decision.
    expect(screen.getByText("Started")).toBeTruthy();
    expect(screen.getByText("Never active")).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });

  it("asks the operator to refresh from the connected inference server", async () => {
    catalogue = [];
    render(
      <main>
        <ModelsView
          session={session}
          connections={connections}
          onConfigureConnections={vi.fn()}
          onOpenOperations={vi.fn()}
          onSessionExpired={vi.fn()}
        />
      </main>,
    );
    await waitFor(() => screen.getByText("Refresh from the connected inference server"));
    expect(screen.queryByText(/Legacy connection aliases remain active/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Refresh from endpoint" }).length).toBeGreaterThan(0);
  });

  it("does not prefill Laguna dummy limits when observed capabilities are unknown", async () => {
    observed = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      connectionId: "conn-1",
      alias: "local-qwen",
      displayName: "Local Qwen",
      observedContextWindowTokens: null,
      observedMaxOutputTokens: null,
      inputModalities: [],
      ownedBy: "vllm",
      lastSeenAt: "2026-08-22T00:00:00.000Z",
      missingFromUpstream: false,
      admittedWorkloads: [],
    }];
    catalogue = [];
    render(
      <main>
        <ModelsView
          session={session}
          connections={connections}
          onConfigureConnections={vi.fn()}
          onOpenOperations={vi.fn()}
          onSessionExpired={vi.fn()}
        />
      </main>,
    );
    await waitFor(() => screen.getByText("local-qwen"));
    fireEvent.click(screen.getByRole("button", { name: "Admit" }));
    expect(screen.getByLabelText(/^Context window/)).toHaveProperty("value", "");
    expect(screen.getByLabelText(/^Maximum output/)).toHaveProperty("value", "");
    expect(screen.getByLabelText(/^Context window/)).not.toHaveProperty("value", "131072");
    expect(screen.getByLabelText(/^Maximum output/)).not.toHaveProperty("value", "8192");
  });

  it("marks an active route Degraded when it disappeared from upstream", async () => {
    catalogue = [model({ missingFromUpstream: true })];
    await view();
    expect(screen.getByText("Degraded")).toBeTruthy();
  });
});
