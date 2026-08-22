/**
 * @vitest-environment jsdom
 *
 * Four governance screens tell a signed-out operator the same thing — sign in
 * as an administrator — and the button underneath has to be the one that
 * offers it.
 *
 * Copy and wiring drifted apart independently three times during the design
 * system move, because each screen's own test covers its populated state and
 * nothing paired the promise with the control. This file is that pair, and it
 * is deliberately one table rather than four tests: the point is that the
 * screens agree with each other, which no per-screen test can see.
 *
 * `openConnectionSettings` in `app.tsx` is what makes the promise true — it
 * answers with the elevation dialog whenever the session is not unlocked — so
 * "the elevation callback fired" is the same statement as "the operator can
 * sign in from here".
 */
import type { AdministratorSession } from "@orcasynapse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationView } from "./application-view.js";
import { GuardrailsView } from "./guardrails-view.js";
import { ModelsView } from "./models-view.js";
import { PeopleView } from "./people-view.js";
import { UsageView } from "./usage-view.js";

afterEach(cleanup);

/** No session at all: the state every one of these screens locks against. */
const signedOut: AdministratorSession | null = null;

interface LockedCase {
  name: string;
  /**
   * Renders the view locked. `elevate` is the callback wired to
   * `openConnectionSettings`, which raises the sign-in dialog; `navigate` is
   * the in-app move the same screen offers elsewhere and must not be what the
   * locked screen's one button does.
   */
  render: (spies: { elevate: () => void; navigate: () => void }) => void;
}

const cases: LockedCase[] = [
  {
    name: "Guardrails",
    render: ({ elevate, navigate }) => {
      render(<GuardrailsView
        session={signedOut}
        onConfigureInference={elevate}
        onSessionExpired={vi.fn()}
      />);
    },
  },
  {
    name: "Models",
    render: ({ elevate, navigate }) => {
      render(<ModelsView
        session={signedOut}
        connections={[]}
        onConfigureConnections={elevate}
        onSessionExpired={vi.fn()}
      />);
    },
  },
  /*
   * Application is the newest of them, split out of Setup when the update check
   * left the bring-up path. A screen added later is exactly the one that drifts
   * from the shared promise, so it joins the table on the day it arrives rather
   * than after someone notices it says something different.
   */
  {
    name: "System",
    render: ({ elevate, navigate }) => {
      render(<ApplicationView
        session={signedOut}
        currentVersion="3.19.0"
        onConfigure={elevate}
      />);
    },
  },
  /*
   * People, joining late and making the point above about screens added later.
   * Divisions arrived at v6.8.0 and People at v7.3.0, each with this exact
   * promise and this exact button, and neither joined this table -- so the
   * comment two entries up described a discipline the file was not keeping.
   * The two are one screen from v8.9.0, which is one row, and it is the row
   * that should have been two since v6.8.0.
   *
   * `navigate` has nowhere to go on this screen: it takes one callback, and it
   * is the elevation one. Passing the spy anyway keeps every case in the table
   * the same shape, and the assertion that it was *not* called is then a real
   * statement about this screen rather than a vacuous one -- if somebody wires
   * a second destination in later, it is already covered.
   */
  {
    name: "Access",
    render: ({ elevate }) => {
      render(<PeopleView
        session={signedOut}
        onOpenSettings={elevate}
        onSessionExpired={vi.fn()}
      />);
    },
  },
  /*
   * Usage, the third Gateway tab, joining on the day it arrives -- which is the
   * discipline the comment four entries up asks for and that Divisions and
   * People did not keep for three releases.
   *
   * `navigate` has nowhere to go here for the same reason it has nowhere to go
   * on Access: the screen takes one callback and it is the elevation one.
   */
  {
    name: "Usage",
    render: ({ elevate }) => {
      render(<UsageView
        session={signedOut}
        onConfigure={elevate}
        onSessionExpired={vi.fn()}
      />);
    },
  },
];

describe("locked governance screens", () => {
  it.each(cases)("$name offers the sign-in it asks for", async ({ render: renderLocked }) => {
    const elevate = vi.fn();
    const navigate = vi.fn();
    const user = userEvent.setup();
    renderLocked({ elevate, navigate });

    // Every one of them makes the same promise, in the same words, so an
    // operator who moves between them is not relearning the rule each time.
    // Deliberately not "the four": that count was wrong the moment a fifth was
    // added, and a number in a comment is the thing nothing checks.
    expect(screen.getByText(/Sign in as an administrator/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(elevate, "the locked screen's button does not reach sign-in").toHaveBeenCalled();
    // Navigating instead lands the operator on another locked screen.
    expect(navigate).not.toHaveBeenCalled();
  });
});
