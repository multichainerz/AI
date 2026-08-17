/**
 * @vitest-environment jsdom
 *
 * People and divisions, on the one screen that holds both.
 *
 * This file exists because the merge that produced that screen was performed on
 * two view modules that had never had a test between them, and a merge is
 * precisely the operation that drops a control without anything going red. What
 * is asserted here is therefore not "the screen renders" but the specific
 * things a careless rewrite would lose: the once-only password sentence, the
 * reset control that is *absent* rather than disabled for a federated person,
 * the suspended division that may be reactivated but not assigned to, and the
 * draft that survives creating a division mid-form.
 *
 * The first test is the one that could not have been written by looking at the
 * screen. People reads on `sessions:manage` and divisions on `agents:read`, and
 * two of the four admin roles hold the second without the first -- so there is
 * a real session for which half this screen is refused and the other half is
 * fine. A PLATFORM_ADMIN session, which is the only one a developer ever signs
 * in with, holds both and never produces it.
 */
import { ADMIN_SCOPES } from "@orcasynapse/contracts";
import type { AdminScope, AdministratorSession, Division, Person } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const api = vi.hoisted(() => ({
  getPeople: vi.fn(),
  getDivisions: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  resetPersonPassword: vi.fn(),
  createDivision: vi.fn(),
  updateDivision: vi.fn(),
  deleteDivision: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { PeopleView } = await import("./people-view.js");
/* Real: the mock factory spreads the real module, so this is the same class the
   view narrows against when it decides a 403 is a refusal and a 401 is a dead
   session. A hand-rolled stand-in would pass `instanceof` nowhere. */
const { OrcaSynapseApiError } = await import("./api.js");

const finance: Division = {
  id: "d1", slug: "finance", displayName: "Finance", description: "Ledger and payroll.",
  status: "ACTIVE", profileCount: 2, userCount: 1, revision: 4,
  createdBy: null, updatedBy: null,
  createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-07T09:00:00.000Z",
};

/** Suspended: still listed so it can be reactivated, never offered as a home. */
const legacy: Division = {
  ...finance, id: "d2", slug: "legacy", displayName: "Legacy", description: "Being wound down.",
  status: "SUSPENDED", profileCount: 0, userCount: 1, revision: 2,
};

const people: Person[] = [
  {
    id: "p1", displayName: "Ana Ruiz", email: null, divisionId: "d1", enabled: true,
    lastLoginAt: "2026-08-07T08:00:00.000Z", credential: "LOCAL", username: "ana",
    passwordChangeRequired: false, lockedUntil: null,
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-07T09:00:00.000Z",
  },
  {
    // Federated: this product holds no password for them, so no reset control.
    id: "p2", displayName: "Sam Okafor", email: null, divisionId: null, enabled: true,
    lastLoginAt: null, credential: "FEDERATED", username: null,
    passwordChangeRequired: false, lockedUntil: null,
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-07T09:00:00.000Z",
  },
  {
    // Left behind in a division that was suspended underneath them.
    id: "p3", displayName: "Priya Nair", email: null, divisionId: "d2", enabled: false,
    lastLoginAt: null, credential: "LOCAL", username: "priya",
    passwordChangeRequired: true, lockedUntil: null,
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-07T09:00:00.000Z",
  },
];

function sessionWith(role: AdministratorSession["role"], scopes: AdminScope[]): AdministratorSession {
  return {
    id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "admin", role, scopes,
    createdAt: "2026-08-07T00:00:00.000Z",
    idleExpiresAt: "2026-08-07T00:15:00.000Z", absoluteExpiresAt: "2026-08-07T08:00:00.000Z",
  };
}

/*
 * The people/divisions slice of `ROLE_SCOPES` in
 * `apps/api/src/auth/admin-session.ts`, copied rather than derived: these tests
 * are about what this screen does with a session the API has already decided
 * about, so the two files disagreeing is the thing worth catching.
 *
 * OPERATIONS_ADMIN is the interesting one and AUDITOR is the same shape --
 * `agents:read` without `sessions:manage`, and without `agents:manage` either,
 * so it may read both lists and manage neither.
 */
const platform = sessionWith("PLATFORM_ADMIN", [...ADMIN_SCOPES]);
const operations = sessionWith("OPERATIONS_ADMIN", ["agents:read", "agents:control", "operations:read"]);

interface Props {
  session: AdministratorSession | null;
  onOpenSettings: () => void;
  onSessionExpired: () => void;
}

function view(over: Partial<Props> = {}): Props {
  const props: Props = {
    session: platform, onOpenSettings: vi.fn(), onSessionExpired: vi.fn(), ...over,
  };
  render(<main><PeopleView {...props} /></main>);
  return props;
}

/** The person form, addressed by the one control that is only ever inside it. */
function personForm(): HTMLElement {
  return screen.getByRole("button", { name: /Create person/ }).closest("form") as HTMLElement;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/**
 * Writes the rendered markup so the populated screen can be looked at without a
 * session, the same way `agents-view.test.tsx` and five others do it. Called
 * from the one test that has both panels populated *and* the person form open,
 * which is the state this consolidation actually changed.
 */
function preview(): void {
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getPeople.mockResolvedValue({ items: people });
  api.getDivisions.mockResolvedValue({ items: [finance, legacy] });
});

describe("people and divisions on one screen", () => {
  it("draws the divisions panel for a role that may not see people", async () => {
    /*
     * The whole reason the loader is `Promise.allSettled`.
     *
     * OPERATIONS_ADMIN and AUDITOR hold `agents:read` and not `sessions:manage`
     * (`apps/api/src/auth/admin-session.ts`), so `GET /admin/people` answers 403
     * and `GET /admin/divisions` answers normally. Before the merge those were
     * two screens and failed independently. One `Promise.all` in the merged
     * loader turns a 403 on one request into a blank screen for both, and no
     * administrator session a developer holds can produce it.
     *
     * Mutating the loader back to `Promise.all` -- with the original
     * try/catch around it, which is what a refactor would actually write -- has
     * to fail this test on the first assertion.
     */
    api.getPeople.mockRejectedValue(new OrcaSynapseApiError(403, "Administrator scope sessions:manage is required."));
    const props = view({ session: operations });

    // The panel that is allowed, drawn from real data rather than an empty
    // shell: both divisions, their descriptions, and their counts.
    expect(await screen.findByText("Finance")).toBeTruthy();
    expect(screen.getByText("Legacy")).toBeTruthy();
    expect(screen.getByText("Ledger and payroll.")).toBeTruthy();

    // The panel that is refused says so as a fact about the role, and does not
    // invite a reload that will refuse again.
    expect(screen.getByText(/Your administrator role cannot see people/)).toBeTruthy();
    expect(screen.queryByText(/People could not be loaded/)).toBeNull();
    // Nor does it claim the deployment has nobody in it.
    expect(screen.queryByText("Nobody yet")).toBeNull();
    expect(screen.queryByText("Ana Ruiz")).toBeNull();

    // A refusal is not an expired session.
    expect(props.onSessionExpired).not.toHaveBeenCalled();

    /*
     * The two people metrics read as unknown rather than as zero. Zero is a
     * statement about the deployment; this is a statement about the request,
     * and an operations administrator reading "People 0" would be reading a
     * number nobody computed.
     */
    expect(screen.getAllByText("—")).toHaveLength(2);

    // Read, not manage: no `agents:manage`, so no division write controls, and
    // no `sessions:manage`, so no Add person.
    expect(screen.queryByRole("button", { name: "New division" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
  });

  it("colours the state of an account and of a division", async () => {
    /*
     * `toneFor` is case-sensitive and its vocabulary is lower case, so
     * `toneFor("HEALTHY")` and `toneFor("DEGRADED")` both answered neutral:
     * every row on this screen carried the same grey whatever it said, and the
     * only remaining signal for a disabled account was the 40% opacity on the
     * row -- which is a dimming, not a state, and is exactly what a suspended
     * division uses too.
     *
     * jsdom applies no stylesheet, so the utility class is the only evidence
     * the colour exists.
     */
    view();

    const person = (await screen.findByText("Ana Ruiz")).closest("article");
    const disabled = screen.getByText("Priya Nair").closest("article");
    // Asserted before anything is read off them: `null?.className` passes
    // silently and would make every expectation below vacuous.
    expect(person).toBeTruthy();
    expect(disabled).toBeTruthy();
    expect(within(person!).getByText("Active").className).toContain("text-good");
    expect(within(disabled!).getByText("Disabled").className).toContain("text-warn");

    const suspended = screen.getByText("Legacy").closest("li");
    expect(suspended).toBeTruthy();
    expect(within(suspended!).getByText("Suspended").className).toContain("text-warn");
  });

  it("separates a refusal from a request that simply failed", async () => {
    /*
     * The pair to the test above, and what stops the refusal copy becoming the
     * screen's only error message. A network failure or a 500 is a thing that
     * went wrong and may not go wrong next time; telling that operator their
     * role is insufficient sends them to the wrong person for a fix.
     */
    api.getPeople.mockRejectedValue(new Error("Failed to fetch"));
    view();

    expect(await screen.findByText("Failed to fetch")).toBeTruthy();
    expect(screen.queryByText(/Your administrator role cannot see people/)).toBeNull();
    expect(screen.getByText("Finance")).toBeTruthy();
  });

  it("hands the session back when either request says the session is gone", async () => {
    // A 401 is not a per-panel fact, so it is answered before either panel's
    // outcome is written rather than being drawn as two refusal notices.
    api.getDivisions.mockRejectedValue(new OrcaSynapseApiError(401, "Session expired."));
    const props = view();

    await waitFor(() => expect(props.onSessionExpired).toHaveBeenCalled());
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it("asks for people and divisions once each", async () => {
    // Two screens became one screen, not one screen making two screens' worth
    // of requests.
    view();
    await screen.findByText("Ana Ruiz");
    expect(api.getPeople).toHaveBeenCalledTimes(1);
    expect(api.getDivisions).toHaveBeenCalledTimes(1);
    // The wider question, asked once. The people form narrows it to the active
    // divisions itself rather than spending a second round trip on the answer.
    expect(api.getDivisions).toHaveBeenCalledWith(true);
  });

  it("shows a new password once and says that is what it is doing", async () => {
    const user = userEvent.setup();
    api.createPerson.mockResolvedValue({ ...people[0]!, displayName: "Ravi Shah" });
    view();
    await screen.findByText("Ana Ruiz");

    await user.click(screen.getByRole("button", { name: "Add person" }));
    expect(screen.getByText("At least 12 characters. Shown once, here.")).toBeTruthy();

    fireEvent.change(within(personForm()).getByLabelText(/^Name/), { target: { value: "Ravi Shah" } });
    fireEvent.change(within(personForm()).getByLabelText(/^Username/), { target: { value: "ravi" } });
    fireEvent.change(within(personForm()).getByLabelText(/^Temporary password/), { target: { value: "correct-horse-battery" } });
    await user.click(screen.getByRole("button", { name: /Create person/ }));

    expect(await screen.findByText(/this is the only time it is shown/)).toBeTruthy();
    expect(api.createPerson).toHaveBeenCalledWith({
      displayName: "Ravi Shah", username: "ravi", password: "correct-horse-battery",
    });
  });

  it("has no password to reset for a federated person", async () => {
    view();
    await screen.findByText("Ana Ruiz");

    const local = screen.getByText("Ana Ruiz").closest("article") as HTMLElement;
    const federated = screen.getByText("Sam Okafor").closest("article") as HTMLElement;

    expect(within(local).getByRole("button", { name: "Reset password" })).toBeTruthy();
    // Absent, not disabled. A disabled control says "not now"; there is no
    // password here to reset, ever.
    expect(within(federated).queryByRole("button", { name: "Reset password" })).toBeNull();
    expect(within(federated).getByText("Signs in through your identity provider")).toBeTruthy();
  });

  it("offers only active divisions as somewhere to put a person", async () => {
    /*
     * The two merged screens asked the API different questions -- People asked
     * for active divisions, Divisions asked for all of them -- because a
     * suspended division must be listed so it can be reactivated and must not
     * be offered as a home. One request now answers both, narrowed on screen.
     *
     * Both selects are asserted, and the second one is here because the first
     * version of this test only covered the row controls: mutating the person
     * form to draw from the unfiltered list survived, which is exactly the
     * narrowing this screen took on when it stopped making two requests.
     */
    const user = userEvent.setup();
    view();
    await screen.findByText("Ana Ruiz");

    await user.click(screen.getByRole("button", { name: "Add person" }));
    const placing = within(personForm()).getByLabelText(/^Division/);
    expect(within(placing).getByText("Finance")).toBeTruthy();
    expect(within(placing).getByText("No division")).toBeTruthy();
    expect(within(placing).queryByText(/Legacy/)).toBeNull();

    const suspended = screen.getByText("Priya Nair").closest("article") as HTMLElement;
    const select = within(suspended).getByLabelText("Division for Priya Nair") as HTMLSelectElement;

    // Their own suspended division is present and selected, and named as
    // suspended. Without it the select would fall back to its first option and
    // report "No division" for somebody who is in one -- a contradiction the
    // divisions panel three inches below would then disprove.
    expect(select.value).toBe("d2");
    expect(within(select).getByText("Legacy (suspended)")).toBeTruthy();

    // Nobody else is offered it.
    const unassigned = screen.getByText("Sam Okafor").closest("article") as HTMLElement;
    const theirs = within(unassigned).getByLabelText("Division for Sam Okafor") as HTMLSelectElement;
    expect(theirs.value).toBe("");
    expect(within(theirs).getByText("Finance")).toBeTruthy();
    expect(within(theirs).queryByText(/Legacy/)).toBeNull();

    // Both panels populated and the person form open: the state the merge
    // created, and the one worth looking at.
    preview();
  });

  it("creates a division from inside the person form without losing the draft", async () => {
    /*
     * The increment this consolidation was worth doing for.
     *
     * On a fresh deployment there are no divisions and the first person is
     * created before any of them, so this is not an edge case -- it is the
     * first thing an administrator does. Before this control the only way to
     * make the division was to leave the tab, and `app.tsx` renders through a
     * closed lookup, so leaving unmounted the form and discarded the name, the
     * username and the temporary password with it.
     *
     * Driven rather than reasoned about: the assertion is that the same typed
     * characters reach `createPerson`, with the division that did not exist
     * when they were typed.
     */
    const user = userEvent.setup();
    let divisionList: Division[] = [];
    api.getPeople.mockResolvedValue({ items: [] });
    api.getDivisions.mockImplementation(async () => ({ items: divisionList }));
    api.createDivision.mockImplementation(async () => { divisionList = [finance]; return finance; });
    api.createPerson.mockResolvedValue({ ...people[0]!, displayName: "Ravi Shah" });
    view();
    await screen.findByText("No divisions yet");

    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(within(personForm()).getByLabelText(/^Name/), "Ravi Shah");
    await user.type(within(personForm()).getByLabelText(/^Username/), "ravi");
    await user.type(within(personForm()).getByLabelText(/^Temporary password/), "correct-horse-battery");

    await user.click(within(personForm()).getByRole("button", { name: "New division" }));
    await user.type(within(dialog()).getByLabelText(/^Name/), "Finance");
    // The identifier follows the name until somebody edits it, the same way
    // every other create form in the product behaves.
    expect((within(dialog()).getByLabelText(/^Identifier/) as HTMLInputElement).value).toBe("finance");
    await user.click(within(dialog()).getByRole("button", { name: "Create division" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.createDivision).toHaveBeenCalledWith({ slug: "finance", displayName: "Finance" });

    // Not a character lost, and the new division selected in the form that
    // needed it.
    expect((within(personForm()).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Ravi Shah");
    expect((within(personForm()).getByLabelText(/^Username/) as HTMLInputElement).value).toBe("ravi");
    expect((within(personForm()).getByLabelText(/^Temporary password/) as HTMLInputElement).value)
      .toBe("correct-horse-battery");
    expect((within(personForm()).getByLabelText(/^Division/) as HTMLSelectElement).value).toBe("d1");

    await user.click(screen.getByRole("button", { name: /Create person/ }));
    await waitFor(() => expect(api.createPerson).toHaveBeenCalledWith({
      displayName: "Ravi Shah", username: "ravi", password: "correct-horse-battery", divisionId: "d1",
    }));
  });

  it("leaves the person draft untouched when the division create fails", async () => {
    /*
     * The failure path is the point. A division that fails to create must cost
     * the administrator nothing -- above all the temporary password, which is
     * shown once and cannot be recovered by reloading the screen.
     *
     * So the error is reported inside the dialog, on the draft that failed,
     * rather than through the page-level error the person form shares with the
     * row controls.
     */
    const user = userEvent.setup();
    api.getPeople.mockResolvedValue({ items: [] });
    api.getDivisions.mockResolvedValue({ items: [] });
    api.createDivision.mockRejectedValue(new OrcaSynapseApiError(409, "A division with that identifier already exists."));
    view();
    await screen.findByText("No divisions yet");

    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(within(personForm()).getByLabelText(/^Name/), "Ravi Shah");
    await user.type(within(personForm()).getByLabelText(/^Temporary password/), "correct-horse-battery");

    await user.click(within(personForm()).getByRole("button", { name: "New division" }));
    await user.type(within(dialog()).getByLabelText(/^Name/), "Finance");
    await user.click(within(dialog()).getByRole("button", { name: "Create division" }));

    // The dialog stays open, holding what was typed into it, and says why.
    expect(await within(dialog()).findByText("A division with that identifier already exists.")).toBeTruthy();
    expect((within(dialog()).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Finance");

    // And the form underneath is exactly as it was.
    expect((within(personForm()).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Ravi Shah");
    expect((within(personForm()).getByLabelText(/^Temporary password/) as HTMLInputElement).value)
      .toBe("correct-horse-battery");
  });

  it("refuses to delete a division that still holds work, and names what is in the way", async () => {
    const user = userEvent.setup();
    view();
    // By heading, not by text: "Finance" is also an option in three person
    // rows' division selects, which is the merge working as intended.
    const row = (await screen.findByRole("heading", { name: "Finance" })).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    expect(screen.getByText(/This division still holds work/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(api.deleteDivision).not.toHaveBeenCalled();
  });

  it("suspends a division against the revision it was read at", async () => {
    // Every division mutation carries `expectedRevision`, so a change made from
    // another session is a conflict rather than a silent overwrite.
    const user = userEvent.setup();
    api.updateDivision.mockResolvedValue(finance);
    view();
    // By heading, not by text: "Finance" is also an option in three person
    // rows' division selects, which is the merge working as intended.
    const row = (await screen.findByRole("heading", { name: "Finance" })).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Suspend" }));

    await waitFor(() => expect(api.updateDivision)
      .toHaveBeenCalledWith("d1", { status: "SUSPENDED", expectedRevision: 4 }));
  });
});
