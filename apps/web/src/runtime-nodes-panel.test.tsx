/**
 * @vitest-environment jsdom
 *
 * The VM2 installer generator. This panel was the one file the design-system
 * migration missed: its layout lived in `.setup-evidence-editor` and
 * `.setup-empty`, both deleted when styles.css was cut from 2,020 lines to 700,
 * and nothing here caught it because the file had no test at all.
 *
 * `VIEW_PREVIEW_OUT` dumps the rendered markup, as elsewhere.
 */
import type { HermesRuntimeNode, ServiceConnectionSummary } from "@orcasynapse/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodes: HermesRuntimeNode[] = [];

/*
 * Hoisted so each case can decide what the fleet read answers with. The panel
 * now polls, so "what does the list return" is a per-call question rather than
 * a fixture: the staleness demotion the poll exists to catch only shows up in
 * the *second* response.
 */
const api = vi.hoisted(() => ({
  getHermesRuntimeNodes: vi.fn(),
  mutateHermesRuntimeNode: vi.fn(),
  createHermesNodeInvitation: vi.fn(),
  refreshConnectionModels: vi.fn(),
  getModelObservations: vi.fn(),
  getModelDeployments: vi.fn(),
  createModelDeployment: vi.fn(),
  changeModelDeploymentState: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, ...api };
});

const { RuntimeNodesPanel } = await import("./runtime-nodes-panel.js");

function runtimeNode(overrides: Partial<HermesRuntimeNode> = {}): HermesRuntimeNode {
  return {
    id: "3f1d1b9c-5a5c-4a58-9a1e-8b7f3c2d1e00",
    slug: "hermes-runtime-01",
    displayName: "Hermes Runtime 01",
    baseUrl: "http://10.0.0.12:8642",
    status: "ONLINE",
    revision: 3,
    enrolledAt: "2026-08-15T00:00:00.000Z",
    revokedAt: null,
    lastSeenAt: "2026-08-15T00:00:00.000Z",
    hostname: "hermes-01.internal",
    ...overrides,
  } as HermesRuntimeNode;
}

beforeEach(() => {
  api.getHermesRuntimeNodes.mockReset();
  api.getHermesRuntimeNodes.mockResolvedValue({ items: nodes });
  api.mutateHermesRuntimeNode.mockReset();
  api.mutateHermesRuntimeNode.mockResolvedValue(undefined);
  api.createHermesNodeInvitation.mockReset();
  api.refreshConnectionModels.mockReset();
  api.refreshConnectionModels.mockResolvedValue({ items: [], connectionId: "conn-1", refreshedAt: null, upserted: 0, vanished: 0, backfill: null });
  api.getModelObservations.mockReset();
  api.getModelObservations.mockResolvedValue({ items: [], connectionId: "conn-1", refreshedAt: null });
  api.getModelDeployments.mockReset();
  api.getModelDeployments.mockResolvedValue({ items: [] });
});

const inferenceConnection = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  displayName: "OpenRouter",
  kind: "INFERENCE",
  enabled: true,
  status: "HEALTHY",
  baseUrl: "https://openrouter.ai/api/v1",
} as ServiceConnectionSummary;

async function panel(
  inferenceReady = true,
  targetEnvironment: "DEVELOPMENT" | "PRODUCTION" | null = "DEVELOPMENT",
  agentModelReady = true,
) {
  render(
    <main>
      <RuntimeNodesPanel
        targetEnvironment={targetEnvironment}
        inferenceReady={inferenceReady}
        agentModelReady={agentModelReady}
        inferenceConnection={inferenceReady ? inferenceConnection : null}
        onConfigureInference={vi.fn()}
        onSessionExpired={vi.fn()}
      />
    </main>,
  );
  await waitFor(() => screen.getByRole("region", { name: "Agent runtime" }));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(cleanup);

describe("the fresh-install state", () => {
  it("offers the installer once inference is ready", async () => {
    await panel();
    expect(screen.getByRole("button", { name: "Generate installer" })).toBeTruthy();
    expect(screen.queryByText("Required paths")).toBeNull();
    expect(screen.queryByText("Network contract")).toBeNull();
  });

  it("sends the operator to inference first when it is not", async () => {
    await panel(false);
    expect(screen.getByRole("button", { name: "Configure AI Inference" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate installer" })).toBeNull();
  });

  it("keeps Generate disabled until an ACTIVE default AGENT route exists", async () => {
    await panel(true, "DEVELOPMENT", false);
    const generate = screen.getByRole("button", { name: "Generate installer" });
    expect(generate).toHaveProperty("disabled", true);
    expect(generate).toHaveProperty("title", "Pick a default Agent model below.");
    expect(screen.getByRole("region", { name: "Default agent model" })).toBeTruthy();
    expect(screen.getByLabelText("Free OpenRouter model")).toBeTruthy();
  });

  it("admits the default Agent on this step so Generate does not require leaving Setup", async () => {
    const free = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      connectionId: inferenceConnection.id,
      alias: "nvidia/nemotron-3-nano:free",
      displayName: "Nemotron Nano (free)",
      observedContextWindowTokens: 131_072,
      observedMaxOutputTokens: 8_192,
      inputModalities: ["text"],
      ownedBy: "nvidia",
      lastSeenAt: "2026-08-22T00:00:00.000Z",
      missingFromUpstream: false,
      admittedWorkloads: [],
    };
    api.refreshConnectionModels.mockResolvedValue({
      items: [free],
      connectionId: inferenceConnection.id,
      refreshedAt: "2026-08-22T00:00:00.000Z",
      upserted: 1,
      vanished: 0,
      backfill: null,
    });
    api.createModelDeployment.mockResolvedValue({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      slug: "nvidia-nemotron-3-nano-free",
      modelAlias: free.alias,
      workload: "AGENT",
      status: "DRAFT",
      isDefault: false,
      revision: 1,
      connection: { id: inferenceConnection.id },
    });
    api.changeModelDeploymentState.mockResolvedValue({ status: "ACTIVE", isDefault: true });
    const onAgentModelReady = vi.fn();
    render(
      <main>
        <RuntimeNodesPanel
          targetEnvironment="DEVELOPMENT"
          inferenceReady
          agentModelReady={false}
          inferenceConnection={inferenceConnection}
          onConfigureInference={vi.fn()}
          onAgentModelReady={onAgentModelReady}
          onSessionExpired={vi.fn()}
        />
      </main>,
    );

    const select = await screen.findByLabelText("Free OpenRouter model");
    await waitFor(() => expect(select).toHaveProperty("value", free.alias));
    fireEvent.click(screen.getByRole("button", { name: "Use as default Agent" }));
    await waitFor(() => expect(onAgentModelReady).toHaveBeenCalled());
    expect(api.createModelDeployment).toHaveBeenCalledWith(expect.objectContaining({
      modelAlias: "nvidia/nemotron-3-nano:free",
      workload: "AGENT",
    }));
  });
});

describe("the installer generator", () => {
  async function open() {
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "Generate installer" }));
    const dialog = await screen.findByRole("dialog");
    if (process.env.VIEW_PREVIEW_DIALOG_OUT) {
      writeFileSync(process.env.VIEW_PREVIEW_DIALOG_OUT, document.body.innerHTML, "utf8");
    }
    return dialog;
  }

  it("opens as a real dialog rather than a bare section", async () => {
    // The hand-rolled backdrop had no role, no focus trap and no Escape. Its
    // width and padding came from a stylesheet rule that no longer exists.
    const dialog = await open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Generate the VM2 installer")).toBeTruthy();
  });

  it("labels the address field so it cannot collide with its own input", async () => {
    const dialog = await open();
    const address = within(dialog).getByLabelText(/VM2 private address/);
    expect(address).toHaveProperty("tagName", "INPUT");
    expect(address).toHaveProperty("required", true);
  });

  it("asks for the private address when the control plane is behind a tunnel", async () => {
    /*
     * Zero Trust and its kin refuse machines at the edge, so the callback
     * address VM2 enrolls against must be the LAN one. The toggle empties the
     * field rather than pre-filling the public origin, which under a tunnel
     * is guaranteed wrong.
     */
    const dialog = await open();

    fireEvent.click(within(dialog).getByRole("switch"));
    const address = within(dialog).getByLabelText(/OrcaSynapse private address visible to VM2/);
    expect(address).toHaveProperty("value", "");
    fireEvent.change(address, { target: { value: "http://10.0.0.160:8080" } });
    fireEvent.submit(address.closest("form")!);

    await waitFor(() => expect(api.createHermesNodeInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ controlPlaneUrl: "http://10.0.0.160:8080" }),
    ));

    // And switching back hides the field and restores the public default.
    api.createHermesNodeInvitation.mockClear();
    fireEvent.click(within(dialog).getByRole("switch"));
    expect(within(dialog).queryByLabelText(/OrcaSynapse private address/)).toBeNull();
  });

  it("keeps the submit reachable from the dialog footer", async () => {
    // The button moved out of the form into Drawer's footer, so it now needs
    // the form attribute to submit anything at all.
    const dialog = await open();
    const submit = within(dialog).getByRole("button", { name: "Generate install command" });
    expect(submit.getAttribute("form")).toBe("vm2-installer-form");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("closes on Escape, which the hand-rolled modal never did", async () => {
    const dialog = await open();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await open();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});

describe("typing in a dialog", () => {
  it("keeps focus in the field across the re-renders typing causes", async () => {
    // Every overlay call site passes an inline `onClose` arrow, so it is a new
    // function each render — and typing into a dialog field re-renders the
    // component that owns the dialog. While the focus-trap effect depended on
    // `onClose`, it tore down per keystroke: the cleanup restored focus to the
    // element that opened the dialog and the new run pulled it to the panel's
    // first focusable. Only the first character of any value could be typed,
    // which made every dialog form unusable — VM2 enrollment included.
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "Generate installer" }));
    const dialog = await screen.findByRole("dialog");
    // Let the dialog's own opening focus land first. Measuring before that
    // frame runs conflates "the overlay focused itself on open", which is
    // correct behaviour, with "the overlay stole focus while typing".
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const address = within(dialog).getByLabelText(/VM2 private address/) as HTMLInputElement;
    address.focus();

    for (const typed of ["h", "ht", "htt", "http"]) {
      fireEvent.change(address, { target: { value: typed } });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }

    expect(document.activeElement, "focus left the field while typing").toBe(address);
    expect(address.value).toBe("http");
  });
});

describe("the production artifact pin", () => {
  // The runtime is pinned to a git commit rather than an image digest, and the
  // 40-hex test is dashboard-only logic: the API refuses an unpinned PRODUCTION
  // enrollment too, but by then the operator has already left this form.
  async function openProduction() {
    await panel(true, "PRODUCTION");
    fireEvent.click(screen.getByRole("button", { name: "Generate installer" }));
    return screen.findByRole("dialog");
  }

  it("accepts the default commit without flagging the artifact", async () => {
    const dialog = await openProduction();
    // jsdom serves the page over http, so the HTTPS bullet is present either
    // way. Only the commit bullet is under test.
    expect(within(dialog).queryByText(/not pinned to a 40-character commit/)).toBeNull();
    expect(within(dialog).getByLabelText(/Hermes commit/)).toHaveProperty("value", "c015663b215c0e14de4295346b0727db602cbb1d");
  });

  it("flags a branch name, a short SHA, and the image reference it replaced", async () => {
    const dialog = await openProduction();
    const commit = within(dialog).getByLabelText(/Hermes commit/);
    for (const rejected of ["main", "c015663b215c", "nousresearch/hermes-agent:latest"]) {
      fireEvent.change(commit, { target: { value: rejected } });
      expect(
        within(dialog).queryByText(/not pinned to a 40-character commit/),
        `expected ${rejected} to be flagged as unpinned`,
      ).toBeTruthy();
    }
    fireEvent.change(commit, { target: { value: "C015663B215C0E14DE4295346B0727DB602CBB1D" } });
    // Uppercase is the same commit; the field lowercases rather than refusing.
    expect(within(dialog).queryByText(/not pinned to a 40-character commit/)).toBeNull();
  });
});

describe("an unknown target environment", () => {
  /*
   * The panel used to be handed `snapshot?.architecture.targetEnvironment ??
   * "DEVELOPMENT"`. A PRODUCTION install whose snapshot has not loaded — or
   * whose load failed — therefore got the development path: the "development
   * release defaults" note, and a Generate button that would happily issue an
   * unpinned, plain-HTTP enrolment the API is about to refuse. Guessing
   * DEVELOPMENT is the one guess that removes a guard, so the panel now refuses
   * to guess at all.
   */
  it("refuses to offer enrolment before it knows what it is enrolling into", async () => {
    await panel(true, null);

    const generate = screen.getByRole("button", { name: "Generate installer" });
    expect(generate).toHaveProperty("disabled", true);
    expect(screen.getByText(/architecture decision has not loaded/)).toBeTruthy();
  });

  it("does not claim development defaults are selected", async () => {
    await panel(true, null);

    // Positive first: a `queryByText(...)` that is null because the whole
    // screen failed to render would pass this vacuously.
    expect(screen.getByRole("region", { name: "Agent runtime" })).toBeTruthy();
    expect(screen.queryByText(/Development release defaults are selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Generate installer" })).toHaveProperty("disabled", true);
  });
});

describe("the hand-off to VM2", () => {
  /*
   * Step 2 gives work to another machine for 15-20 minutes with long silent
   * stretches, and everything needed during that silence used to live inside
   * the drawer that issued the claim — so closing it lost the command, the
   * claim and any sense of how long it had been running. This is the designed
   * waiting state: the command, a clock, the claim's remaining life, the node's
   * own status, and what the installer is doing while it says nothing.
   */
  const pending = runtimeNode({ status: "PENDING", lastSeenAt: null, enrolledAt: null, hostname: null });

  async function issue() {
    api.createHermesNodeInvitation.mockResolvedValue({
      node: pending,
      bundle: {
        format: "orcasynapse-hermes-enrollment/v1",
        nodeId: pending.id,
        nodeSlug: pending.slug,
        token: "a-one-time-claim-that-never-reaches-the-command",
        controlPlaneUrl: "https://orcasynapse.internal",
        hermesBaseUrl: pending.baseUrl,
        hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
        expiresAt: new Date(Date.now() + 27 * 60_000).toISOString(),
      },
    });
    // Empty until the claim is issued: the record appears with the invitation,
    // which is what `load()` re-reads immediately afterwards.
    api.getHermesRuntimeNodes.mockResolvedValue({ items: [] });
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "Generate installer" }));
    await screen.findByRole("dialog");
    api.getHermesRuntimeNodes.mockResolvedValue({ items: [pending] });
    fireEvent.click(screen.getByRole("button", { name: "Generate install command" }));
    return waitFor(() => screen.getByRole("article", { name: "VM2 enrollment in progress" }));
  }

  it("keeps the command, the clock and the claim's life on the screen", async () => {
    const waiting = within(await issue());

    // The command the operator runs — and it carries no claim, which is the
    // property that lets it be pasted into a shared terminal at all.
    const command = waiting.getByText(/curl -fsSL https:\/\/orcasynapse.internal\/install\/agentic-node.sh/);
    expect(command.textContent).not.toContain("a-one-time-claim");
    expect(waiting.getByText(/The command contains no claim/)).toBeTruthy();

    // A clock that moves, so a silent stretch reads as running rather than hung.
    expect(waiting.getByText(/^\d+:\d{2}$/)).toBeTruthy();
    // The claim's remaining life, in the units the invitation form sets it in.
    expect(waiting.getByText(/^in 2[67] min$/)).toBeTruthy();
    // What the installer is doing during the silence.
    expect(waiting.getByText(/15–20 minutes on a first install/)).toBeTruthy();
    expect(waiting.getByText(/180,000 objects/)).toBeTruthy();
  });

  it("reports the node's own status rather than assuming it arrived", async () => {
    const waiting = within(await issue());
    // Enrolment leaves the node PENDING; only its own signed heartbeat promotes
    // it, so "the claim was issued" and "VM2 answered" are different facts.
    expect(waiting.getByText("Pending")).toBeTruthy();
    expect(waiting.getByText("None yet")).toBeTruthy();
  });

  it("stops watching once the node is online, rather than waiting forever", async () => {
    await issue();
    api.getHermesRuntimeNodes.mockResolvedValue({ items: [runtimeNode({ status: "ONLINE" })] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(screen.queryByRole("article", { name: "VM2 enrollment in progress" })).toBeNull());
    expect(screen.getByText("Online")).toBeTruthy();
  });
});

describe("a node that did not take the commit it was given", () => {
  /*
   * The control plane now tells each node which Hermes commit to run, and the
   * node reports back what it is actually running. A node that quietly failed
   * to move is the failure mode worth seeing: it stays Online, it heartbeats,
   * and nothing else on this screen distinguishes it from one that moved.
   */
  const RUNNING = "1f".repeat(20);
  const EXPECTED = "9c".repeat(20);

  async function fleet(node: HermesRuntimeNode) {
    api.getHermesRuntimeNodes.mockResolvedValue({ items: [node] });
    render(
      <main>
        <RuntimeNodesPanel
          targetEnvironment="DEVELOPMENT"
          inferenceReady
          agentModelReady
          onConfigureInference={vi.fn()}
          onSessionExpired={vi.fn()}
        />
      </main>,
    );
    await waitFor(() => screen.getByText("Hermes Runtime 01"));
  }

  it("says so, and names both commits", async () => {
    await fleet(runtimeNode({ hermesVersion: RUNNING, expectedHermesCommit: EXPECTED }));

    expect(screen.getByText("Commit drift")).toBeTruthy();
    expect(screen.getByText(new RegExp(`${RUNNING.slice(0, 12)}.*expects ${EXPECTED.slice(0, 12)}`))).toBeTruthy();
  });

  it("stays quiet when the node is running what it was told to", async () => {
    await fleet(runtimeNode({ hermesVersion: EXPECTED, expectedHermesCommit: EXPECTED }));

    // Positive first: a null `queryByText` proves nothing if the card never
    // rendered at all.
    expect(screen.getByText(new RegExp(EXPECTED.slice(0, 12)))).toBeTruthy();
    expect(screen.queryByText("Commit drift")).toBeNull();
  });

  it("does not call an unrecorded target drift", async () => {
    // A node enrolled before the pin was recorded has no target. Unknown and
    // disagreeing are different facts, and only one of them is a fault.
    await fleet(runtimeNode({ hermesVersion: RUNNING, expectedHermesCommit: null }));

    expect(screen.getByText(new RegExp(RUNNING.slice(0, 12)))).toBeTruthy();
    expect(screen.queryByText("Commit drift")).toBeNull();
  });

  it("does not call an unreadable running version drift", async () => {
    // "unknown" is what a node reports when it could not resolve a commit of
    // its own. It is not evidence that the node is on the wrong one.
    await fleet(runtimeNode({ hermesVersion: "unknown", expectedHermesCommit: EXPECTED }));

    expect(screen.getByText(/unknown/)).toBeTruthy();
    expect(screen.queryByText("Commit drift")).toBeNull();
  });
});

describe("the node poll", () => {
  /*
   * Nothing in the product polled before this. VM2 enrolment hands off to
   * another machine for 15-20 minutes and the node's status is written by its
   * own heartbeat, so without a poll the screen that says "watch the node come
   * online" could only be made to say it by pressing Refresh.
   */
  it("re-reads the fleet without a manual refresh", async () => {
    vi.useFakeTimers();
    try {
      render(
        <main>
          <RuntimeNodesPanel
            targetEnvironment="DEVELOPMENT"
            inferenceReady
            agentModelReady
            onConfigureInference={vi.fn()}
            onSessionExpired={vi.fn()}
          />
        </main>,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(api.getHermesRuntimeNodes).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(api.getHermesRuntimeNodes.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acts on the revision the last poll returned, not the one it first drew", async () => {
    /*
     * `list()` bumps a node's `revision` when it demotes one that has gone
     * quiet past NODE_STALE_AFTER_MS (180 s). A panel that holds the revision
     * it first rendered therefore sends a stale `expectedRevision` and every
     * Drain, Suspend and Revoke answers 409 — the failure mode a poll
     * introduces if its result is diffed away instead of written through.
     */
    api.getHermesRuntimeNodes
      .mockResolvedValueOnce({ items: [runtimeNode({ revision: 3 })] })
      .mockResolvedValue({ items: [runtimeNode({ revision: 4, status: "OFFLINE" })] });

    vi.useFakeTimers();
    try {
      render(
        <main>
          <RuntimeNodesPanel
            targetEnvironment="DEVELOPMENT"
            inferenceReady
            agentModelReady
            onConfigureInference={vi.fn()}
            onSessionExpired={vi.fn()}
          />
        </main>,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText("Hermes Runtime 01")).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

      // The demotion is on screen, which is what proves the second response was
      // adopted rather than discarded as "the same node".
      expect(screen.getByText("Offline")).toBeTruthy();

      const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
      });
      confirmed.mockRestore();
      const [, body] = api.mutateHermesRuntimeNode.mock.calls[0] ?? [];
      expect(body).toMatchObject({ action: "REVOKE", expectedRevision: 4 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the enrolled runtime's maintenance path", () => {
  /*
   * The install command lives in the enrollment tile, which leaves the screen
   * the moment the node heartbeats — and a fresh installer is then correctly
   * refused, because the deployment holds one execution boundary. The backend
   * keeps the installer downloadable after enrollment for exactly the repair
   * rerun, and until this block no pixel said so: an operator with an enrolled
   * node had no visible way to update it.
   */
  it("offers the repair command once a node is enrolled", async () => {
    api.getHermesRuntimeNodes.mockResolvedValue({
      items: [runtimeNode({ controlPlaneUrl: "http://10.0.0.160:8080" })],
    });
    await panel();

    const maintenance = within(await screen.findByRole("article", { name: "Runtime maintenance" }));
    // --repair, not --connect: on a completed enrollment the installer refuses
    // --connect outright and tells the operator to decommission.
    const command = maintenance.getByText(/curl -fsSL .*\/install\/agentic-node\.sh \| sudo bash -s -- --repair/);
    expect(command.textContent).toContain("http://10.0.0.160:8080/install/agentic-node.sh");
    expect(command.textContent).not.toContain("--connect");
    expect(maintenance.getByRole("button", { name: "Copy command" })).toBeTruthy();
    // The ordering that bit tonight's deployment twice: the node downloads
    // this script from the control plane, so a stale control plane silently
    // hands out the stale fix.
    expect(maintenance.getByText(/Update OrcaSynapse first/)).toBeTruthy();
  });

  it("offers nothing to maintain before a node exists", async () => {
    await panel();
    expect(screen.queryByRole("article", { name: "Runtime maintenance" })).toBeNull();
  });

  it("retires the block with the boundary, not with the row", async () => {
    // A revoked node still renders in the fleet list (its Remove action lives
    // there), but there is no runtime left to repair.
    api.getHermesRuntimeNodes.mockResolvedValue({
      items: [runtimeNode({ status: "REVOKED", revokedAt: "2026-08-16T00:00:00.000Z" })],
    });
    await panel();
    expect(screen.queryByRole("article", { name: "Runtime maintenance" })).toBeNull();
    const generate = screen.getByRole("button", { name: "Generate installer" });
    expect(generate).toHaveProperty("disabled", false);
    expect(screen.getByText(/Generate a one-time command/)).toBeTruthy();
    expect(screen.queryByText(/Revoke it before enrolling a replacement/)).toBeNull();
  });
});
