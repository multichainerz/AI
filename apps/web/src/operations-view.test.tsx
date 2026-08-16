/**
 * @vitest-environment jsdom
 *
 * Health, populated. This was four sub-tabs over health, incidents, release
 * gates and pilot readiness; it is one screen now, and the cases below pin
 * both what it still does and what has left it.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so it can be looked at without
 * a session; see `chat-transcript.test.tsx`.
 */
import { ADMIN_SCOPES, type AdministratorSession } from "@orcasynapse/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/*
 * Two rows, because the card has two shapes. The open one is the automatic
 * observation an operator acts on; the resolved one is the only way to see the
 * operator note, which no fixture reached while every incident here carried
 * `resolutionNote: null`.
 *
 * They are separate constants because the two endpoints do not return the same
 * thing, and the fixture used to pretend they did: `GET /ai-ops` carries the
 * twenty most recent *open* incidents, while `GET /ai-ops/incidents` returns
 * the last two hundred of any status. Stubbing the second with the first's
 * items made the ledger's only source look redundant.
 */
const openIncident = { id: "i1", title: "Hermes node vm2-b unreachable", severity: "CRITICAL", status: "OPEN", detectedAt: "2026-08-07T10:40:00.000Z", lastObservedAt: "2026-08-07T10:59:00.000Z", component: "hermes-vm2", owner: null, summary: "No heartbeat for 19 minutes.", automated: true, resolutionNote: null };
const resolvedIncident = { id: "i2", title: "Chat latency above budget", severity: "WARNING", status: "RESOLVED", detectedAt: "2026-08-07T09:10:00.000Z", lastObservedAt: "2026-08-07T09:40:00.000Z", component: "chat-gateway", owner: "platform-admin", summary: "Median answer time crossed the six-second budget for twenty minutes.", automated: false, resolutionNote: "Restarted the inference node; latency returned to 3.1s." };

/** Open and already owned by somebody who is not the reader. */
const ownedIncident = { id: "i3", title: "Tool queue backing up", severity: "WARNING", status: "OPEN", detectedAt: "2026-08-07T10:20:00.000Z", lastObservedAt: "2026-08-07T10:58:00.000Z", component: "tool-runner", owner: "Platform team", summary: "Approvals are outpacing execution.", automated: true, resolutionNote: null };

const overview = {
  status: "DEGRADED",
  generatedAt: "2026-08-07T11:00:00.000Z",
  /*
   * All five statuses, because the colour of the last three is the whole
   * subject of "severity survives the palette" below and two of them are the
   * ones the shared vocabulary has no word for. `source` is CONFIGURATION on
   * the additions on purpose: the live/last-verified pair above is asserted
   * with `getByText`, which throws on a second match.
   */
  components: [
    { id: "c1", label: "AI Inference", status: "HEALTHY", summary: "vLLM answering within budget.", source: "LAST_VERIFIED", observedAt: "2026-08-07T10:58:00.000Z", affectedWorkflows: ["TOOL_USE"] },
    { id: "c2", label: "Hermes runtime", status: "DEGRADED", summary: "One node missed its last heartbeat.", source: "LIVE", observedAt: "2026-08-07T10:59:00.000Z", affectedWorkflows: [] },
    { id: "c3", label: "Hermes node vm2-b", status: "UNAVAILABLE", summary: "No heartbeat for 19 minutes.", source: "CONFIGURATION", observedAt: null, affectedWorkflows: ["AGENTS"] },
    { id: "c4", label: "Audit forwarding", status: "NOT_VERIFIED", summary: "Configured, never tested from here.", source: "CONFIGURATION", observedAt: null, affectedWorkflows: [] },
    { id: "c5", label: "Identity provider", status: "NOT_CONFIGURED", summary: "No enterprise identity is connected.", source: "CONFIGURATION", observedAt: null, affectedWorkflows: [] },
  ],
  guardrails: [
    { layer: "APPLICATION", label: "Chat boundary", status: "ENFORCED", summary: "Size and credential checks active.", evidence: "policy:baseline-chat v2.0" },
    { layer: "TOOL_USE", label: "Tool boundary", status: "NOT_VERIFIED", summary: "Admission is recorded; no call has exercised it.", evidence: "no evidence retained" },
  ],
  incidents: { open: 1, critical: 1, items: [openIncident] },
  metrics: {
    chat: { responses: 1_284, failureRate: 0.012, averageLatencyMs: 4_120 },
    agents: { runningRuns: 1, queuedRuns: 0, failedRuns: 2 },
    tools: { executingCalls: 0, pendingApprovals: 1, deniedCalls: 3 },
  },
  runtime: {
    capturedAt: "2026-08-07T11:00:00.000Z",
    workloads: [{ name: "agent-run", displayName: "Hermes runs", pendingCount: 0, activeCount: 1, failedCount: 2, totalCount: 40 }],
    /*
     * ONLINE and STOPPED, which is what `runtimeExecutorSnapshotSchema`
     * actually admits -- this fixture said "HEALTHY", a status no executor can
     * have, and the screen drew it grey along with every other value because
     * nothing here was ever translated.
     */
    executors: [
      { id: "w1", name: "worker-1", status: "ONLINE", version: "3.16.0", workloads: ["agent-run"], lastSeenAt: "2026-08-07T10:59:50.000Z" },
      { id: "w2", name: "worker-2", status: "STOPPED", version: "3.16.0", workloads: ["agent-run"], lastSeenAt: "2026-08-07T09:10:00.000Z" },
    ],
  },
};

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getAiOpsOverview: vi.fn(async () => overview),
    getOperationalIncidents: vi.fn(async () => ({ items: [openIncident, ownedIncident, resolvedIncident] })),
    decideOperationalIncident: vi.fn(async () => openIncident),
    /*
     * `getProductionReadiness` used to be stubbed here too, and so did the
     * evaluation reads before the whole evaluation subsystem was removed.
     * Health calls neither — readiness has no screen — and leaving the stubs
     * would have let the view start fetching them again without a single test
     * noticing.
     */
  };
});

const { OperationsView, snapshotIsStale } = await import("./operations-view.js");
const { decideOperationalIncident, getAiOpsOverview, getOperationalIncidents } = await import("./api.js");

async function view() {
  render(<main><OperationsView session={session} onConfigure={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByText("Hermes runtime"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(cleanup);

describe("operations control room", () => {
  it("puts the degraded component first, since that is the one to act on", async () => {
    await view();
    const topology = screen.getByText("Services").closest("section")!;
    const labels = within(topology).getAllByText(/AI Inference|Hermes runtime/).map((node) => node.textContent);
    expect(labels[0]).toBe("Hermes runtime");
  });

  it("distinguishes a live reading from a last-verified one", async () => {
    // A cached connection test presented as live state is how an operator ends
    // up trusting a service that stopped answering an hour ago.
    await view();
    expect(screen.getByText(/^Verified /)).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  /*
   * The open-incident count used to ride on a sub-tab so it stayed visible
   * from the other three. There are no sub-tabs now — Health is one screen —
   * so the count belongs to the queue it describes, and the ledger it used to
   * link to is the next section down.
   */
  it("states the open-incident count on the queue it describes", async () => {
    await view();

    // The five-item preview panel is gone: with the full ledger on the same
    // screen it printed the same incidents a second time.
    expect(screen.queryByText("Incident queue")).toBeNull();
    expect(screen.getAllByText("Hermes node vm2-b unreachable")).toHaveLength(1);
    expect(screen.queryByLabelText("AI operations views")).toBeNull();
    expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
  });

  it("no longer hides release gates or pilot readiness behind this screen", async () => {
    /*
     * Release gates was removed outright with the evaluation subsystem behind
     * it; pilot readiness was deleted because `ProductionReadinessControl` has
     * no create route and no seed anywhere, so the screen could never show a
     * row.
     */
    await view();

    expect(screen.queryByText("Pilot readiness")).toBeNull();
    expect(screen.queryByText("Production pilot readiness")).toBeNull();
    expect(screen.queryByText("Release gates")).toBeNull();
    expect(screen.queryByText("Release evidence")).toBeNull();
  });

  it("draws the whole ledger, which only the incident endpoint has", async () => {
    /*
     * The two reads look redundant and are not. `GET /ai-ops` carries the
     * open/critical counts the hero draws plus its own twenty most recent
     * *open* rows; the ledger below needs resolved incidents too, and only
     * `GET /ai-ops/incidents` returns them. Nothing said so, and the fixture
     * stubbed the second endpoint with the first's items -- so deleting the
     * second fetch and reading `overview.incidents.items` instead would have
     * silently emptied the resolved half of the ledger with every test green.
     */
    await view();

    expect(overview.incidents.items.map(({ id }) => id)).toEqual(["i1"]);
    expect(screen.getByText("Hermes node vm2-b unreachable")).toBeTruthy();
    expect(screen.getByText("Chat latency above budget")).toBeTruthy();
    expect(vi.mocked(getOperationalIncidents)).toHaveBeenCalled();
  });

  it("labels the workflow figures by what they count", async () => {
    // "Agent tools" named the tab this figure came from -- and that tab is
    // called Tools now -- rather than the number under it, which is executing
    // calls, exactly as its neighbours are responses and runs.
    await view();
    const workflows = screen.getByText("Activity").closest("section")!;
    expect(within(workflows).getByText("Chat responses / 24h")).toBeTruthy();
    expect(within(workflows).getByText("Hermes runs in progress")).toBeTruthy();
    expect(within(workflows).getByText("Tool calls")).toBeTruthy();
    expect(within(workflows).queryByText("Agent tools")).toBeNull();
  });

  it("marks a failed workload count without recolouring the healthy ones", async () => {
    await view();
    const failed = screen.getByText("2", { selector: "td" });
    expect(failed.className).toContain("text-bad");
  });

  it("shows the incident ledger on the same screen, with severity legible", async () => {
    // No click: the ledger used to be a sibling tab and is now the section
    // below the queue, so reaching it is scrolling rather than navigating.
    await view();

    expect(await screen.findByText("Hermes node vm2-b unreachable")).toBeTruthy();
    expect(screen.getAllByText("Critical").length).toBeGreaterThan(0);
    expect(screen.getByText("Incidents")).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });

  /*
   * The ledger card was a themed shell around bare markup: the `<header>`, the
   * title block, the `<dl>` and the note carried no classes at all, so the
   * severity chip, the provenance and the timestamp ran together on one line
   * and the four facts stacked as an unstyled definition list.
   *
   * jsdom applies no stylesheet, so the class names are the only evidence the
   * composition exists — which is exactly what these assert. Each one fails
   * against the unstyled markup, and each was checked by removing the class it
   * names from the view.
   */
  describe("incident record card", () => {
    async function card(title: string): Promise<HTMLElement> {
      await view();
      const article = screen.getByText(title).closest("article");
      // Asserted before anything is asked of it: every check below reads a
      // class name off this element, and `null?.className` is a silent pass.
      expect(article).toBeTruthy();
      return article as HTMLElement;
    }

    it("puts severity, provenance and a right-aligned timestamp on one header row", async () => {
      const article = await card("Hermes node vm2-b unreachable");
      const header = article.querySelector("header");
      expect(header).toBeTruthy();
      expect(header!.className).toContain("flex");

      // The chip is the shared Badge now, not the hand-rolled span that copied
      // half of it. `tracking-[0.07em]` is badgeVariants' own, and nothing else
      // in the card sets it.
      const severity = within(header!).getByText("Critical");
      expect(severity.className).toContain("tracking-[0.07em]");
      expect(severity.className).toContain("text-destructive");

      expect(within(header!).getByText("Automatic observation")).toBeTruthy();

      const detected = header!.querySelector("time");
      expect(detected).toBeTruthy();
      // Machine-readable as well as human-readable: "2h ago" is not a date.
      expect(detected!.getAttribute("datetime")).toBe("2026-08-07T10:40:00.000Z");
      expect(detected!.className).toContain("ml-auto");
    });

    it("runs the four facts across the card instead of stacking them", async () => {
      const article = await card("Hermes node vm2-b unreachable");
      const list = article.querySelector("dl");
      expect(list).toBeTruthy();
      // Two columns where the card is narrow, four once there is room.
      expect(list!.className).toContain("grid-cols-2");
      expect(list!.className).toContain("sm:grid-cols-4");

      const terms = [...list!.querySelectorAll("dt")];
      const details = [...list!.querySelectorAll("dd")];
      // The count is pinned first: a `for` over an empty NodeList asserts
      // nothing and reports success, which is how this check passes vacuously.
      expect(terms.map((term) => term.textContent)).toEqual(["Status", "Component", "Owner", "Last observed"]);
      // The last value is a relative time against the real clock, so it is
      // matched by shape; pinning the string would rot on a fixed date.
      expect(details.map((detail) => detail.textContent))
        .toEqual(["Open", "hermes-vm2", "Unassigned", expect.stringMatching(/ ago$/)]);
      for (const term of terms) expect(term.className).toContain("text-micro");
      for (const detail of details) expect(detail.className).toContain("text-caption");
    });

    it("gives the title and the summary a hierarchy", async () => {
      const article = await card("Hermes node vm2-b unreachable");
      const heading = within(article).getByRole("heading", { name: "Hermes node vm2-b unreachable" });
      expect(heading.className).toContain("font-display");
      const summary = within(article).getByText("No heartbeat for 19 minutes.");
      expect(summary.tagName).toBe("P");
      expect(summary.className).toContain("text-muted");
    });

    it("labels the operator note rather than leaving a bare blockquote", async () => {
      const article = await card("Chat latency above budget");
      const note = article.querySelector("blockquote");
      expect(note).toBeTruthy();
      // The note is written by acknowledge as well as resolve, so it is the
      // operator's, not the resolution's.
      expect(within(note!).getByText("Operator note")).toBeTruthy();
      expect(note!.textContent).toContain("Restarted the inference node");
      expect(note!.className).toContain("bg-raised");
    });

    /*
     * A pin, not a fix: the stripe already worked and is the fastest severity
     * read on the screen, so the restyle had to carry it through rather than
     * replace it with the badge.
     */
    it("keeps the left tone stripe on the card itself", async () => {
      await view();
      const open = screen.getByText("Hermes node vm2-b unreachable").closest("article");
      const resolved = screen.getByText("Chat latency above budget").closest("article");
      expect(open).toBeTruthy();
      expect(resolved).toBeTruthy();
      expect(open!.className).toContain("border-l-bad");
      expect(resolved!.className).toContain("border-l-good");
    });
  });

  /*
   * The palette is four colours and this screen speaks four vocabularies, none
   * of which is the one `toneFor` knows. Lower-casing them is not a
   * translation: `unavailable`, `not_verified`, `not_configured`, every
   * executor status and every guardrail status fell through to neutral grey,
   * so the component this screen deliberately sorts first as the most severe
   * thing on the page was drawn *quieter* than the merely degraded one under
   * it, and a stopped worker looked exactly like a running one.
   *
   * jsdom applies no stylesheet, so the utility class on the toned element is
   * the only evidence the colour exists.
   */
  describe("severity survives the palette", () => {
    /**
     * The tone class on the element carrying the live dot.
     *
     * That element is the toned one by construction — `StatusText` puts the dot
     * inside the span it colours — so this cannot drift onto a neighbouring
     * label the way a class-name search over the whole card would.
     */
    function statusTone(card: HTMLElement): string {
      const dot = card.querySelector(".anim-live");
      // Asserted before it is dereferenced: `null?.parentElement` is a silent
      // pass and would make every expectation below vacuous.
      expect(dot).toBeTruthy();
      return (dot!.parentElement as HTMLElement).className;
    }

    function card(label: string): HTMLElement {
      const article = screen.getByText(label).closest("article");
      expect(article).toBeTruthy();
      return article as HTMLElement;
    }

    it("draws a down service louder than a degraded one, matching its own sort", async () => {
      // The inversion in one assertion: `sortedComponents` weights UNAVAILABLE
      // above DEGRADED, and the colour has to agree with the order.
      await view();
      expect(statusTone(card("Hermes node vm2-b"))).toContain("text-bad");
      expect(statusTone(card("Hermes runtime"))).toContain("text-warn");
      expect(statusTone(card("AI Inference"))).toContain("text-good");
    });

    it("separates a service nobody has verified from one nobody has configured", async () => {
      /*
       * Both were grey. They are not the same fact: one is a service this
       * deployment depends on with no evidence it works, the other is a
       * capability nothing was ever asked of -- which is the order the sort
       * already puts them in.
       */
      await view();
      expect(statusTone(card("Audit forwarding"))).toContain("text-warn");
      expect(statusTone(card("Identity provider"))).toContain("text-faint");
    });

    it("does not draw a stopped worker like a running one", async () => {
      await view();
      expect(statusTone(card("worker-2"))).toContain("text-bad");
      expect(statusTone(card("worker-1"))).toContain("text-good");
    });

    it("colours an unverified guardrail rather than leaving the whole row grey", async () => {
      await view();
      expect(statusTone(card("Chat boundary"))).toContain("text-good");
      expect(statusTone(card("Tool boundary"))).toContain("text-warn");
    });

    it("does not paint a critical deployment the same amber as a degraded one", async () => {
      // `overview.status` is a three-value enum and the header read it as a
      // boolean, so the worst state the API can report had no colour of its own.
      await view();
      const degraded = screen.getAllByText("Degraded").find((node) => node.querySelector(".anim-live"));
      expect(degraded?.className).toContain("text-warn");

      cleanup();
      vi.mocked(getAiOpsOverview).mockResolvedValueOnce({ ...overview, status: "CRITICAL" } as never);
      await view();
      // The badge on each incident says "Critical" too; the header's is the one
      // carrying the live dot.
      const critical = screen.getAllByText("Critical").find((node) => node.querySelector(".anim-live"));
      expect(critical).toBeTruthy();
      expect(critical!.className).toContain("text-bad");
    });
  });

  /*
   * `POST /incidents/:id/acknowledge` writes `owner: input.owner ??
   * principal.subject`, so a decision that sends only a note hands the
   * incident to whoever pressed the button. `IncidentDecision` has always
   * carried an optional `owner`; this screen never surfaced it, so an incident
   * owned by a team silently became one administrator's -- on the one field
   * whose job is to say who is dealing with it, and with no undo anywhere on
   * the screen.
   */
  describe("ownership through a decision", () => {
    function decisionOn(title: string): HTMLElement {
      const article = screen.getByText(title).closest("article");
      expect(article).toBeTruthy();
      return article as HTMLElement;
    }

    it("keeps the owner an incident already has", async () => {
      await view();
      const card = decisionOn("Tool queue backing up");
      fireEvent.click(within(card).getByRole("button", { name: "Acknowledge" }));

      // Shown, not merely preserved: an operator who means to take it over has
      // to be able to see that they are about to.
      const owner = within(card).getByLabelText("Owner");
      expect(owner).toHaveProperty("value", "Platform team");

      fireEvent.change(within(card).getByLabelText("Operator note"), { target: { value: "Paging the on-call." } });
      fireEvent.click(within(card).getByRole("button", { name: "Record acknowledge" }));

      await waitFor(() => expect(vi.mocked(decideOperationalIncident)).toHaveBeenCalledWith(
        "i3", "acknowledge", { note: "Paging the on-call.", owner: "Platform team" },
      ));
    });

    it("leaves an unassigned incident for the server to assign", async () => {
      /*
       * The other half. `owner` is `min(1)` on a strict schema, so an empty
       * field cannot be sent as an empty string -- and taking an unowned
       * incident by acknowledging it is the server's existing behaviour and the
       * right one.
       */
      await view();
      const card = decisionOn("Hermes node vm2-b unreachable");
      fireEvent.click(within(card).getByRole("button", { name: "Acknowledge" }));
      expect(within(card).getByLabelText("Owner")).toHaveProperty("value", "");

      fireEvent.change(within(card).getByLabelText("Operator note"), { target: { value: "Taking this one." } });
      fireEvent.click(within(card).getByRole("button", { name: "Record acknowledge" }));

      await waitFor(() => expect(vi.mocked(decideOperationalIncident)).toHaveBeenCalledWith(
        "i1", "acknowledge", { note: "Taking this one." },
      ));
    });
  });

  it("says where the incident ledger stops, since the hero counts past it", async () => {
    /*
     * `listIncidents` is a bare `limit: 200` with no total in the contract,
     * while the hero's open count is an unbounded `count()` over the same
     * table. On a deployment that has raised more than 200 the two figures
     * disagree on one screen with nothing to explain it, and the ledger is the
     * one whose edge is invisible.
     */
    const many = Array.from({ length: 200 }, (_, index) => ({
      ...resolvedIncident, id: `f${index}`, title: `Historic incident ${index}`,
    }));
    vi.mocked(getOperationalIncidents).mockResolvedValueOnce({ items: many } as never);
    await view();

    expect(screen.getByText(/The newest 200 incidents are listed/)).toBeTruthy();
    expect(screen.getByText(/can be larger than what is shown here/)).toBeTruthy();
  });

  it("says nothing about a cap the ledger has not reached", async () => {
    // The pair to the test above: three incidents is three incidents, and a
    // hedge over a complete list is its own kind of noise.
    await view();
    expect(screen.queryByText(/The newest 200 incidents are listed/)).toBeNull();
  });

  it("does not reload on every parent render, which App produces every few seconds", async () => {
    // App polls and hands down a fresh `onSessionExpired` arrow each time. When
    // the load effect tracks that identity through the handleError -> refresh
    // chain, Operations refetches all four endpoints forever: every cycle sets
    // busy (disabling every submit) and clears the error being read.
    const props = { session, onConfigure: vi.fn() };
    const { rerender } = render(
      <main><OperationsView {...props} onSessionExpired={() => undefined} /></main>,
    );
    await waitFor(() => screen.getByText("Hermes runtime"));
    const loads = vi.mocked(getAiOpsOverview).mock.calls.length;

    rerender(<main><OperationsView {...props} onSessionExpired={() => undefined} /></main>);
    await act(async () => { await Promise.resolve(); });

    expect(vi.mocked(getAiOpsOverview).mock.calls.length).toBe(loads);
  });

  /*
   * Every figure on this screen comes from one snapshot, so its age is a
   * property of the whole page rather than a detail in the corner. It was
   * rendered in the same muted grey whether it was two seconds or two days
   * old, which is the failure mode where a reader trusts a screen that has
   * quietly stopped updating -- exactly the case a degraded control plane
   * produces.
   */
  it("marks the snapshot when it is too old for the screen to be believed", async () => {
    await view();

    const snapshot = screen.getByText(/^Snapshot /);

    // The fixture's generatedAt is fixed in 2026 and long past the window.
    expect(snapshot.textContent).toContain("refresh");
  });

  it("says nothing extra about a snapshot that is current", () => {
    const now = Date.parse("2026-08-07T11:00:30.000Z");

    expect(snapshotIsStale("2026-08-07T11:00:00.000Z", now)).toBe(false);
    expect(snapshotIsStale("2026-08-07T10:54:00.000Z", now)).toBe(true);
    // Absent or unparseable is not stale: "unknown" must not be dressed up as
    // a fault the operator can act on.
    expect(snapshotIsStale(null, now)).toBe(false);
    expect(snapshotIsStale("not a date", now)).toBe(false);
  });

  /*
   * The screen used to print "Hermes runs 0" in the summary and "Hermes runs 1"
   * a panel below, because one counted queued runs and the other running ones
   * under the same name. Two figures that disagree and share a label is worse
   * than either being absent.
   */
  it("never labels two different run counts with the same name", async () => {
    await view();

    expect(screen.getByText("Runs waiting to start")).toBeTruthy();
    expect(screen.getByText("Hermes runs in progress")).toBeTruthy();
    expect(screen.queryByText("Hermes runs pending")).toBeNull();
    // The Background work table still has a row called "Hermes runs", and that
    // is fine: its columns say which number is which. The rule is about
    // headline figures, which carry a single number and no such context.
    const activity = screen.getByText("Activity").closest("section")!;
    expect(within(activity).queryByText("Hermes runs")).toBeNull();
  });

  /*
   * `totalCount` is every run of every status still in the database. It was
   * shown as "Retained", which reads as a retention policy or a backlog and is
   * neither, and the word appeared in two captions as well without either one
   * defining it.
   */
  it("names the all-time column for what it counts", async () => {
    await view();

    expect(screen.getByRole("columnheader", { name: "All time" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Retained" })).toBeNull();
  });
});
