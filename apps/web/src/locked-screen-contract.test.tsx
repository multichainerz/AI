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
 * is deliberately one table rather than four tests: the point is that the four
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
import { PromptsView } from "./prompts-view.js";

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
    name: "Prompts",
    render: ({ elevate, navigate }) => {
      render(<PromptsView
        session={signedOut}
        onOpenOperations={navigate}
        onOpenSettings={elevate}
        onSessionExpired={vi.fn()}
      />);
    },
  },
  {
    name: "Guardrails",
    render: ({ elevate, navigate }) => {
      render(<GuardrailsView
        session={signedOut}
        onConfigureInference={elevate}
        onOpenOperations={navigate}
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
        onOpenOperations={navigate}
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
    name: "Application",
    render: ({ elevate, navigate }) => {
      render(<ApplicationView
        session={signedOut}
        currentVersion="3.19.0"
        onConfigure={elevate}
        onOpenOperations={navigate}
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

    // Every one of the four makes the same promise, in the same words, so an
    // operator who moves between them is not relearning the rule each time.
    expect(screen.getByText(/Sign in as an administrator/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open platform settings" }));
    expect(elevate, "the locked screen's button does not reach sign-in").toHaveBeenCalled();
    // Navigating instead lands the operator on another locked screen.
    expect(navigate).not.toHaveBeenCalled();
  });
});
