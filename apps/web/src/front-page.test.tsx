/**
 * @vitest-environment jsdom
 *
 * The front page is the only door into the product now, so what these cases
 * pin is the doorway itself: each of the four ways in reaches its handler
 * with what the operator typed, and the states that must not be offered —
 * SSO without OIDC, submission while trust is not READY — are absent rather
 * than merely disabled-looking.
 */
import { ORCASYNAPSE_VERSION, type AdministratorSession } from "@orcasynapse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrontPage } from "./front-page.js";
import { applyTheme } from "./theme.js";

const handlers = () => ({
  onLogin: vi.fn(async () => true),
  onStartRecovery: vi.fn(async () => true),
  onChangePassword: vi.fn(async () => true),
  onRecover: vi.fn(async () => true),
});

const base = {
  bootstrapState: "READY" as const,
  busy: false,
  error: null,
  oidcConfigured: false,
  session: null,
};

function changeSession(method: AdministratorSession["authenticationMethod"]): AdministratorSession {
  return {
    id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
    subject: "local:admin",
    role: "PLATFORM_ADMIN",
    scopes: ["sessions:manage"],
    createdAt: new Date().toISOString(),
    idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    authenticationMethod: method,
    passwordChangeRequired: true,
  };
}

afterEach(() => {
  cleanup();
  applyTheme("dark");
});

describe("signing in from the front page", () => {
  it("switches the persisted page backdrop between dark and light", async () => {
    const user = userEvent.setup();
    render(<FrontPage {...base} {...handlers()} />);
    const theme = screen.getByRole("switch", { name: "Light appearance" });

    expect(theme.getAttribute("aria-checked")).toBe("false");
    await user.click(theme);
    expect(theme.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("orcasynapse.theme")).toBe("light");
  });

  it("presents OrcaSynapse as a Hermes-native governed control plane", () => {
    const { container } = render(<FrontPage {...base} {...handlers()} />);

    expect(screen.getByRole("heading", { name: "Dynamic intelligence, orchestrated into action." })).toBeTruthy();
    expect(screen.getByText(/Hermes-native sessions, agent profiles, models, policy, and tools/i)).toBeTruthy();
    expect(container.textContent).not.toContain("OCR + RETRIEVAL");
    expect(container.textContent).not.toMatch(/Governed agentic workflows|Plan and reason|Use governed tools|Retain context|Act with oversight/);
  });

  /*
   * The hero carries no diagram at all now. Two have been drawn here and both
   * were removed — an orbit of abstractions around a "plan · reason" core, then
   * a literal two-machine deployment picture — so this asserts the absence
   * rather than the contents of a third. The page's job before sign-in is the
   * sign-in card; the architecture is documented where it can be read properly.
   */
  it("draws no architecture diagram in the hero", () => {
    const { container } = render(<FrontPage {...base} {...handlers()} />);

    expect(screen.queryByLabelText(/intent enters the OrcaSynapse control plane/i)).toBeNull();
    expect(container.querySelector("svg[viewBox='0 0 560 224']")).toBeNull();
    expect(container.textContent).not.toMatch(
      /INFRASTRUCTURE YOU CONTROL|CONTROL PLANE|Approved inference|Audit . Evidence|AGENTIC HARNESS|TOOLS \+ ACTIONS/,
    );
    // The heading and the sign-in card are what the page is for, and both stay.
    expect(container.textContent).toContain("Dynamic intelligence, orchestrated into action.");
    expect(screen.getByRole("region", { name: "Administrator access" })).toBeTruthy();
  });

  it("keeps the sign-in card compact and removes decorative framing copy", () => {
    render(<FrontPage {...base} {...handlers()} />);

    expect(screen.queryByText("Private agentic intelligence")).toBeNull();
    expect(screen.queryByText("Private intelligence. Governed execution. Your infrastructure.")).toBeNull();
    expect(screen.queryByText(/Identity, policy, and execution stay within/i)).toBeNull();

    const access = screen.getByRole("region", { name: "Administrator access" });
    expect(screen.queryByText("Administrator access")).toBeNull();
    expect(screen.queryByText("Enter the control plane")).toBeNull();
    expect(screen.queryByText(/Sign in to operate and govern/i)).toBeNull();
    expect(screen.getByText("Username")).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByLabelText("Username").classList.contains("focus-visible:outline-none")).toBe(true);
    expect(access.querySelector(".bg-gradient-to-r")).toBeNull();
  });

  it("carries the shared static synapse field behind the sign-in surface", () => {
    const { container } = render(<FrontPage {...base} {...handlers()} />);
    const page = container.querySelector(".front-page");
    const presentation = container.querySelector(".front-page__presentation");
    const field = container.querySelector("svg.dashboard-synapse--front-page");

    expect(page?.firstElementChild).toBe(field);
    expect(presentation?.contains(field)).toBe(false);
    expect(field).toBeTruthy();
    expect(field?.getAttribute("aria-hidden")).toBe("true");
    expect(field?.getAttribute("focusable")).toBe("false");
    expect(field?.querySelectorAll(".dashboard-synapse__node")).toHaveLength(43);
    expect(field?.querySelector("[class*='synapse__signal']")).toBeNull();
  });

  it("sends the typed credentials to the local sign-in handler", async () => {
    const user = userEvent.setup();
    const on = handlers();
    render(<FrontPage {...base} {...on} />);

    const username = screen.getByLabelText(/^username$/i);
    await user.clear(username);
    await user.type(username, "operations");
    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(on.onLogin).toHaveBeenCalledWith("operations", "a-long-enough-password");
    expect(on.onStartRecovery).not.toHaveBeenCalled();
  });

  it("shows the version and the handler's error where the operator is looking", () => {
    render(<FrontPage {...base} {...handlers()} error="Unable to sign in with the supplied local account." />);
    expect(screen.getByRole("alert").textContent).toContain("Unable to sign in");
    expect(screen.getByText(new RegExp(ORCASYNAPSE_VERSION))).toBeTruthy();
  });

  it("refuses to submit while installation trust is not READY", () => {
    render(<FrontPage {...base} {...handlers()} bootstrapState="LOCKED" />);
    expect(screen.getByText(/installation trust is locked/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the recovery path", () => {
  it("swaps to the Installation Key form and hands the key to its own handler", async () => {
    const user = userEvent.setup();
    const on = handlers();
    render(<FrontPage {...base} {...on} />);

    await user.click(screen.getByRole("button", { name: /use offline recovery key/i }));
    expect(screen.getByRole("form", { name: "Offline recovery" })).toBeTruthy();
    expect(screen.queryByText("Recovery access")).toBeNull();
    expect(screen.queryByText("Offline recovery")).toBeNull();
    expect(screen.queryByText(/Use the Installation Key from your vault/i)).toBeNull();
    await user.type(screen.getByLabelText(/installation key/i), "k".repeat(43));
    await user.click(screen.getByRole("button", { name: /continue recovery/i }));

    expect(on.onStartRecovery).toHaveBeenCalledWith("k".repeat(43));
    expect(on.onLogin).not.toHaveBeenCalled();
  });
});

describe("enterprise SSO", () => {
  it("is offered only when the deployment has OIDC configured", () => {
    const { unmount } = render(<FrontPage {...base} {...handlers()} />);
    expect(screen.queryByRole("button", { name: /enterprise sso/i })).toBeNull();
    unmount();

    render(<FrontPage {...base} {...handlers()} oidcConfigured />);
    expect(screen.getByRole("button", { name: /enterprise sso/i })).toBeTruthy();
  });
});

describe("the forced password change", () => {
  /*
   * Sign-in and recovery open straight onto their fields and carry their name
   * as the form's aria-label. This state used to be the one exception, leading
   * with an icon, a kicker, a heading and a paragraph — so the card visibly
   * changed shape between two steps of the same sign-in. It now matches, which
   * means the accessible name has to move to the label the other two use
   * rather than simply being dropped with the heading.
   */
  it("opens on its fields like sign-in and recovery, naming the form instead", () => {
    const { unmount } = render(<FrontPage {...base} {...handlers()} session={changeSession("LOCAL_PASSWORD")} />);

    expect(screen.getByRole("form", { name: "Change temporary password" })).toBeTruthy();
    expect(screen.queryByText("Credential update")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Change temporary password" })).toBeNull();
    expect(screen.queryByText(/Set a permanent password before entering the workspace/i)).toBeNull();
    unmount();

    render(<FrontPage {...base} {...handlers()} session={changeSession("INSTALLATION_KEY_RECOVERY")} />);

    expect(screen.getByRole("form", { name: "Reset local administrator" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Reset local administrator" })).toBeNull();
    expect(screen.queryByText(/The recovery key has been verified/i)).toBeNull();
  });

  it("changes a temporary password through the change handler", async () => {
    const user = userEvent.setup();
    const on = handlers();
    render(<FrontPage {...base} {...on} session={changeSession("LOCAL_PASSWORD")} />);

    await user.type(screen.getByLabelText(/^temporary password$/i), "the-temporary-one");
    await user.type(screen.getByLabelText(/^new password$/i), "the-permanent-one!");
    await user.type(screen.getByLabelText(/confirm new password/i), "the-permanent-one!");
    await user.click(screen.getByRole("button", { name: /change password/i }));

    expect(on.onChangePassword).toHaveBeenCalledWith("the-temporary-one", "the-permanent-one!");
    expect(on.onRecover).not.toHaveBeenCalled();
  });

  it("keeps mismatched passwords from ever reaching a handler", async () => {
    const user = userEvent.setup();
    const on = handlers();
    render(<FrontPage {...base} {...on} session={changeSession("LOCAL_PASSWORD")} />);

    await user.type(screen.getByLabelText(/^temporary password$/i), "the-temporary-one");
    await user.type(screen.getByLabelText(/^new password$/i), "the-permanent-one!");
    await user.type(screen.getByLabelText(/confirm new password/i), "a-different-one!!");

    expect(screen.getByText(/do not match/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /change password/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(on.onChangePassword).not.toHaveBeenCalled();
  });

  it("resets through the recovery handler when the session came from the Installation Key", async () => {
    const user = userEvent.setup();
    const on = handlers();
    render(<FrontPage {...base} {...on} session={changeSession("INSTALLATION_KEY_RECOVERY")} />);

    await user.type(screen.getByLabelText(/^new password$/i), "the-permanent-one!");
    await user.type(screen.getByLabelText(/confirm new password/i), "the-permanent-one!");
    await user.click(screen.getByRole("button", { name: /reset and sign in/i }));

    expect(on.onRecover).toHaveBeenCalledWith("admin", "the-permanent-one!");
    expect(on.onChangePassword).not.toHaveBeenCalled();
  });
});
