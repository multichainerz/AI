/**
 * @vitest-environment jsdom
 *
 * Local sign-in has two stores. A person created under Settings → Access is
 * not a LocalAdministrator, and treating their 401 as an expired admin
 * session is what this file exists to stop.
 */
import type { EnterpriseSession, PlatformMeta } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrcaSynapseApiError } from "./api.js";

const api = vi.hoisted(() => ({
  getPlatformMeta: vi.fn(),
  getAdministratorSession: vi.fn(),
  getEnterpriseSession: vi.fn(),
  getConnections: vi.fn(),
  getConnectionMonitoring: vi.fn(),
  getChatMetrics: vi.fn(),
  getAgentMetrics: vi.fn(),
  getToolMetrics: vi.fn(),
  getAgentRuntime: vi.fn(),
  getAgentProfiles: vi.fn(),
  getHermesRuntimeNodes: vi.fn(),
  createLocalAdministratorSession: vi.fn(),
  createLocalPersonSession: vi.fn(),
  changeLocalPersonPassword: vi.fn(),
  revokeAdministratorSession: vi.fn(),
  revokeEnterpriseSession: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, ...api };
});

const { default: App } = await import("./app.js");

const enterpriseSession = {
  id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
  identityMode: "ENTERPRISE",
  user: {
    id: "fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
    displayName: "Ayu Rahman",
    email: "ayu@orcasynapse.example",
    divisionName: "Finance",
  },
  scopes: ["chat:use", "agents:use"],
  createdAt: "2026-08-16T00:00:00.000Z",
  idleExpiresAt: "2026-08-16T08:00:00.000Z",
  absoluteExpiresAt: "2026-08-16T12:00:00.000Z",
} as EnterpriseSession;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getPlatformMeta.mockResolvedValue({ bootstrapState: "READY", version: "8.8.7" } as PlatformMeta);
  api.getAdministratorSession.mockRejectedValue(new Error("no session"));
  api.getEnterpriseSession.mockRejectedValue(new Error("no enterprise session"));
  api.getConnections.mockResolvedValue({ items: [] });
  api.getConnectionMonitoring.mockResolvedValue({
    enabled: true, intervalSeconds: 300, reason: null, updatedAt: "2026-08-15T00:00:00.000Z", updatedBy: null,
  });
  api.getChatMetrics.mockRejectedValue(new Error("not an administrator"));
  api.getAgentMetrics.mockRejectedValue(new Error("not an administrator"));
  api.getToolMetrics.mockRejectedValue(new Error("not an administrator"));
  api.getAgentRuntime.mockRejectedValue(new Error("not an administrator"));
  api.getAgentProfiles.mockRejectedValue(new Error("not an administrator"));
  api.getHermesRuntimeNodes.mockRejectedValue(new Error("not an administrator"));
  api.revokeAdministratorSession.mockResolvedValue(undefined);
  api.revokeEnterpriseSession.mockResolvedValue(undefined);
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"), media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.location.hash = "";
});

afterEach(cleanup);

async function submitLocalSignIn(username: string, password: string) {
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("Username")).toBeTruthy(), { timeout: 3_000 });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  await user.click(screen.getByRole("button", { name: /Sign in/ }));
  return user;
}

describe("local person sign-in", () => {
  it("opens the workspace for a People account after the admin store refuses it", async () => {
    api.createLocalAdministratorSession.mockRejectedValue(
      new OrcaSynapseApiError(401, "The username or password is incorrect."),
    );
    api.createLocalPersonSession.mockResolvedValue(enterpriseSession);

    await submitLocalSignIn("ayu", "a-long-enough-password");

    await waitFor(() => expect(api.createLocalPersonSession).toHaveBeenCalledWith("ayu", "a-long-enough-password"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ayu Rahman" })).toBeTruthy());
    expect(screen.queryByText(/administrator session expired/i)).toBeNull();
    // The division bounding this person's view, said beside the account chip.
    expect(screen.getByTitle("Division: Finance").textContent).toBe("Finance");
  });

  it("hides the administration areas from a People account", async () => {
    api.createLocalAdministratorSession.mockRejectedValue(
      new OrcaSynapseApiError(401, "The username or password is incorrect."),
    );
    api.createLocalPersonSession.mockResolvedValue(enterpriseSession);

    await submitLocalSignIn("ayu", "a-long-enough-password");
    await waitFor(() => expect(screen.getByRole("button", { name: "Ayu Rahman" })).toBeTruthy());

    /*
     * The rail advertises only what this identity can open. The admin group
     * -- its fold control and every row behind it -- must not render for a
     * person: each of those pages answers them with a locked screen, so the
     * rows were four doors that do not open. The workspace rows staying in
     * the same render is what keeps the absences from passing vacuously.
     */
    expect(screen.getByRole("button", { name: /Session/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Files/ })).toBeTruthy();
    for (const hidden of ["Admin", "Agents", "Gateway", "Operations", "Settings"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${hidden}`) })).toBeNull();
    }
  });

  it("says the credentials are wrong instead of claiming the admin session expired", async () => {
    api.createLocalAdministratorSession.mockRejectedValue(
      new OrcaSynapseApiError(401, "The username or password is incorrect."),
    );
    api.createLocalPersonSession.mockRejectedValue(
      new OrcaSynapseApiError(401, "That username and password do not match an account."),
    );

    await submitLocalSignIn("ayu", "a-long-enough-password");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("do not match an account"));
    expect(screen.queryByText(/administrator session expired/i)).toBeNull();
    expect(screen.getByLabelText("Username")).toBeTruthy();
  });

  it("asks a new person to change the temporary password before opening the workspace", async () => {
    api.createLocalAdministratorSession.mockRejectedValue(
      new OrcaSynapseApiError(401, "The username or password is incorrect."),
    );
    api.createLocalPersonSession.mockResolvedValue({
      ...enterpriseSession,
      passwordChangeRequired: true,
    });

    await submitLocalSignIn("ayu", "a-long-enough-password");

    await waitFor(() => expect(screen.getByRole("form", { name: "Change temporary password" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Ayu Rahman" })).toBeNull();
  });

  it("opens the workspace after a locally created person replaces the temporary password", async () => {
    api.createLocalAdministratorSession.mockRejectedValue(
      new OrcaSynapseApiError(401, "The username or password is incorrect."),
    );
    api.createLocalPersonSession.mockResolvedValue({
      ...enterpriseSession,
      passwordChangeRequired: true,
    });
    api.changeLocalPersonPassword.mockResolvedValue(enterpriseSession);

    const user = await submitLocalSignIn("ayu", "a-long-enough-password");
    await waitFor(() => expect(screen.getByRole("form", { name: "Change temporary password" })).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^temporary password$/i), { target: { value: "a-long-enough-password" } });
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: "a-much-stronger-password" } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: "a-much-stronger-password" } });
    await user.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => expect(api.changeLocalPersonPassword).toHaveBeenCalledWith(
      "a-long-enough-password",
      "a-much-stronger-password",
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ayu Rahman" })).toBeTruthy());
  });

  it("restores a People session that still owes a password change onto the change form", async () => {
    api.getEnterpriseSession.mockResolvedValue({
      ...enterpriseSession,
      passwordChangeRequired: true,
    });

    render(<App />);

    await waitFor(() => expect(screen.getByRole("form", { name: "Change temporary password" })).toBeTruthy(), {
      timeout: 3_000,
    });
    expect(screen.queryByRole("button", { name: "Ayu Rahman" })).toBeNull();
  });

  it("restores a People session even when OIDC is not configured", async () => {
    api.getEnterpriseSession.mockResolvedValue(enterpriseSession);

    render(<App />);

    await waitFor(() => expect(api.getEnterpriseSession).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Ayu Rahman" })).toBeTruthy());
    expect(screen.queryByLabelText("Username")).toBeNull();
  });
});
