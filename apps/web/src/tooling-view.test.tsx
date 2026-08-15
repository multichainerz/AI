/**
 * @vitest-environment jsdom
 *
 * Tools.
 *
 * The screen answers two questions and nothing else: what tools do my agents
 * have, and how do I turn one on or off. Everything below is about whether
 * those two survive the states this deployment actually produces — an
 * unreachable runtime, an empty catalogue, and drift — and about the surfaces
 * that were removed staying removed.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup to a file so the screen can be
 * looked at without a session, matching `governance-views.test.tsx`.
 */
import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type GovernedTool,
  type HermesRuntimeCatalogue,
} from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const readOnly: AdministratorSession = {
  ...session,
  role: "AUDITOR",
  scopes: ["tools:read"],
};

const governedTool = {
  id: "5a9b0c1d-2e3f-4a5b-8c9d-0e1f2a3b4c5d",
  slug: "read_corpus",
  displayName: "Read corpus",
  description: "Reads an approved corpus document.",
  risk: "READ_ONLY",
  status: "ACTIVE",
  handlerKey: "corpus.read",
  inputSchema: {},
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
} as GovernedTool;

const api = vi.hoisted(() => ({
  getGovernedTools: vi.fn(),
  getToolsetAdmissions: vi.fn(),
  getRuntimeCatalogue: vi.fn(),
  decideToolsetAdmission: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { ToolingView } = await import("./tooling-view.js");

interface Setup {
  tools?: GovernedTool[];
  catalogue?: HermesRuntimeCatalogue | null;
  admissions?: Array<{ toolsetName: string; admitted: boolean; reason: string | null }>;
  session?: AdministratorSession;
}

function setupApi(over: Setup = {}) {
  api.getGovernedTools.mockResolvedValue({ items: over.tools ?? [] });
  api.getToolsetAdmissions.mockResolvedValue({
    items: (over.admissions ?? []).map((entry) => ({
      ...entry,
      admittedBy: session.id,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    })),
  });
  api.getRuntimeCatalogue.mockImplementation(async () => {
    if (over.catalogue === null) throw new Error("unreachable");
    return over.catalogue ?? { toolsets: [], skills: [], enabledToolsets: 0 };
  });
  api.decideToolsetAdmission.mockResolvedValue(undefined);
}

const props = { onConfigure: vi.fn(), onSessionExpired: vi.fn() };

async function view(over: Setup = {}) {
  setupApi(over);
  render(<main><ToolingView {...props} session={over.session ?? session} /></main>);
  /*
   * `data-loaded` rather than the panel's mere presence. The panel renders
   * synchronously, so waiting on it would let every assertion below run against
   * pre-load defaults — the exact vacuous pass the sibling suites warn about.
   */
  await waitFor(() => expect(screen.getByLabelText("Runtime tools").dataset.loaded).toBe("true"));
  const out = process.env.VIEW_PREVIEW_OUT;
  if (out) writeFileSync(out.replace("VIEW", "tooling"), document.body.innerHTML, "utf8");
}

const catalogue = (
  ...toolsets: Array<{ name: string; enabled: boolean; toolCount?: number; label?: string }>
): HermesRuntimeCatalogue => ({
  toolsets: toolsets.map((toolset) => ({
    name: toolset.name,
    label: toolset.label ?? null,
    enabled: toolset.enabled,
    toolCount: toolset.toolCount ?? 1,
  })),
  skills: [],
  enabledToolsets: toolsets.filter((toolset) => toolset.enabled).length,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("browsing what exists", () => {
  it("lists every tool the runtime reports, and how many calls each one holds", async () => {
    await view({ catalogue: catalogue(
      { name: "code_execution", enabled: false, toolCount: 4 },
      { name: "web_search", enabled: true, toolCount: 2, label: "Web search" },
    ), admissions: [{ toolsetName: "web_search", admitted: true, reason: "Reviewed with the data owner." }] });

    const code = screen.getByLabelText("code_execution");
    expect(within(code).getByText("4 tools")).toBeTruthy();
    const web = screen.getByLabelText("web_search");
    expect(within(web).getByText("Web search")).toBeTruthy();
    expect(within(web).getByText("2 tools")).toBeTruthy();
    // The decision already on record, at the row it belongs to — not in a
    // shared box at the top of the screen.
    expect(within(web).getByText(/Reviewed with the data owner/)).toBeTruthy();
  });

  it("shows built-in memory as always allowed rather than as a zero", async () => {
    // `HermesClient.assertAdmittedToolBoundaryFor` adds `memory` to the
    // permitted set unconditionally, so a screen that draws it as off — or
    // omits it and reports "0 allowed" — states the opposite of the boundary.
    await view();
    const memory = screen.getByLabelText("memory");
    expect(within(memory).getByText(/Always allowed/i)).toBeTruthy();
    expect(within(memory).getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("says the runtime is unreachable instead of presenting an empty list as fact", async () => {
    await view({ catalogue: null });
    expect(await screen.findByText(/could not reach the runtime/i)).toBeTruthy();
  });

  it("explains an empty catalogue rather than leaving a bare gap", async () => {
    await view();
    const list = screen.getByLabelText("Runtime tools");
    expect(within(list).getByText(/reports no tools beyond built-in memory/i)).toBeTruthy();
  });

  it("does not claim an empty runtime before the runtime has answered", async () => {
    /*
     * First paint holds no catalogue and no decisions, which is indistinguishable
     * from a runtime that answered and offers nothing — the same conflation the
     * unreachable case guards, only for the width of a fetch. Stating it as fact
     * there means the screen's first frame is a claim it has not checked.
     */
    setupApi();
    let answer: (value: HermesRuntimeCatalogue) => void = () => {};
    api.getRuntimeCatalogue.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    render(<main><ToolingView {...props} session={session} /></main>);
    await waitFor(() => expect(api.getRuntimeCatalogue).toHaveBeenCalled());

    const list = screen.getByLabelText("Runtime tools");
    // The list is on screen, so the absence below is a judgement about its copy.
    expect(within(list).getByLabelText("memory")).toBeTruthy();
    expect(within(list).queryByText(/reports no tools beyond built-in memory/i)).toBeNull();
    expect(screen.getByText(/asking the runtime which tools it offers/i)).toBeTruthy();

    answer({ toolsets: [], skills: [], enabledToolsets: 0 });
    expect(await screen.findByText(/reports no tools beyond built-in memory/i)).toBeTruthy();
  });
});

describe("the toggle", () => {
  it("turns a tool on with one switch and a reason", async () => {
    const user = userEvent.setup();
    await view({ catalogue: catalogue({ name: "code_execution", enabled: false }) });

    const row = screen.getByLabelText("code_execution");
    await user.click(within(row).getByRole("switch"));
    await user.type(within(row).getByLabelText(/why/i), "Reviewed with the data owner.");
    await user.click(within(row).getByRole("button", { name: /^Allow$/ }));

    await waitFor(() => expect(api.decideToolsetAdmission).toHaveBeenCalledWith(
      "code_execution",
      true,
      "Reviewed with the data owner.",
    ));
  });

  it("turns an allowed tool off the same way", async () => {
    const user = userEvent.setup();
    await view({
      catalogue: catalogue({ name: "web_search", enabled: true }),
      admissions: [{ toolsetName: "web_search", admitted: true, reason: "Reviewed." }],
    });

    const row = screen.getByLabelText("web_search");
    expect(within(row).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    await user.click(within(row).getByRole("switch"));
    await user.type(within(row).getByLabelText(/why/i), "Withdrawn pending review.");
    await user.click(within(row).getByRole("button", { name: /^Block$/ }));

    await waitFor(() => expect(api.decideToolsetAdmission).toHaveBeenCalledWith(
      "web_search",
      false,
      "Withdrawn pending review.",
    ));
  });

  it("will not record a decision without a reason", async () => {
    // The reason is a governance requirement the API enforces with a 400. It is
    // asked for at the moment of the decision so it reads as the decision
    // rather than as a form to fill in before any control works.
    const user = userEvent.setup();
    await view({ catalogue: catalogue({ name: "code_execution", enabled: false }) });

    const row = screen.getByLabelText("code_execution");
    await user.click(within(row).getByRole("switch"));
    const confirm = within(row).getByRole("button", { name: /^Allow$/ });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.type(within(row).getByLabelText(/why/i), "Reviewed with the data owner.");
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("offers no decision on built-in memory, which the boundary always permits", async () => {
    // A control that cannot change the outcome is worse than no control.
    const user = userEvent.setup();
    await view({ catalogue: catalogue({ name: "memory", enabled: true }) });

    const memory = screen.getByLabelText("memory");
    const toggle = within(memory).getByRole("switch");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    await user.click(toggle);
    expect(within(memory).queryByLabelText(/why/i)).toBeNull();
  });

  it("lets a read-only administrator browse but not decide", async () => {
    await view({
      catalogue: catalogue({ name: "code_execution", enabled: false }),
      session: readOnly,
    });
    const row = screen.getByLabelText("code_execution");
    // Present, so the negative below is about the control rather than about a
    // row that never rendered.
    expect(within(row).getByText("1 tool")).toBeTruthy();
    expect(within(row).getByRole("switch").hasAttribute("disabled")).toBe(true);
  });
});

describe("runtime drift", () => {
  it("names the tools that are blocking every run", async () => {
    await view({ catalogue: catalogue({ name: "code_execution", enabled: true }) });
    expect(screen.getByText(/Agent runs and chat are blocked/i)).toBeTruthy();
    const row = screen.getByLabelText("code_execution");
    expect(within(row).getByText(/on at the runtime but not allowed here/i)).toBeTruthy();
  });

  it("does not count built-in memory as drift", async () => {
    /*
     * An earlier build flagged an enabled `memory` toolset with no admission
     * row as drift and announced every run was being refused. The Hermes client
     * permits `memory` unconditionally, so runs were fine and the alarm false.
     */
    await view({ catalogue: catalogue({ name: "memory", enabled: true }) });
    // The row is on screen, so the absence below is a judgement about it.
    expect(screen.getByLabelText("memory")).toBeTruthy();
    expect(screen.queryByText(/Agent runs and chat are blocked/i)).toBeNull();
    expect(screen.getByText(/built-in memory only/i)).toBeTruthy();
  });
});

describe("the removed MCP plane", () => {
  it("draws no gateway, grant, credential or ledger surface", async () => {
    /*
     * Nothing seeds `GovernedTool`, there is no create route, and
     * `DrizzleToolingManager.executeHandler` throws for every handler key. Half
     * this screen used to govern a subsystem that has never run and cannot run.
     */
    await view();
    // Assert the screen rendered before asserting what it lacks.
    expect(screen.getByLabelText("Runtime tools")).toBeTruthy();
    expect(screen.queryByText(/gateway/i)).toBeNull();
    expect(screen.queryByText(/exact-version grant/i)).toBeNull();
    expect(screen.queryByText(/credential/i)).toBeNull();
    expect(screen.queryByText(/ledger/i)).toBeNull();
  });

  it("still says so if a release ever registers an MCP tool", async () => {
    // The one tripwire kept: `GovernedTool` is the first link in that plane's
    // chain, so a non-empty registry is the only way it can come back to life.
    await view({ tools: [governedTool] });
    expect(await screen.findByText(/1 OrcaSynapse-executed MCP tool is registered/i)).toBeTruthy();
    expect(screen.getByText(/cannot execute them/i)).toBeTruthy();
  });
});

describe("a tool the runtime has not reported", () => {
  it("takes a name and a reason", async () => {
    // `PUT /toolsets/:name` accepts any name, so a decision can be staged
    // before the runtime offers the tool. Demoted behind a disclosure: it is
    // not the thing an administrator came here to do.
    const user = userEvent.setup();
    await view();
    const list = screen.getByLabelText("Runtime tools");
    await user.type(within(list).getByLabelText(/tool name/i), "clarify");
    await user.type(within(list).getByLabelText(/why/i), "Asks a question; touches no data.");
    await user.click(within(list).getByRole("button", { name: /Record decision/i }));

    await waitFor(() => expect(api.decideToolsetAdmission).toHaveBeenCalledWith(
      "clarify",
      true,
      "Asks a question; touches no data.",
    ));
  });
});

describe("access", () => {
  it("keeps a session pending a forced password change locked out", async () => {
    setupApi();
    render(<ToolingView {...props} session={{ ...session, passwordChangeRequired: true }} />);
    expect(screen.getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(api.getToolsetAdmissions).not.toHaveBeenCalled();
  });

  it("draws the locked screen with no session", () => {
    setupApi();
    render(<ToolingView {...props} session={null} />);
    expect(screen.getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(api.getRuntimeCatalogue).not.toHaveBeenCalled();
  });
});

describe("the built markup", () => {
  it("renders no inline style, which the CSP would refuse", async () => {
    await view({ catalogue: catalogue({ name: "code_execution", enabled: true }) });
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
