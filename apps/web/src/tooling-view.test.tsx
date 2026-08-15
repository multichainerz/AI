/**
 * @vitest-environment jsdom
 *
 * Agent Tools, populated.
 *
 * The screen governs two different planes and the whole point of the rework is
 * that it says which is which: Hermes-native toolsets, which the runtime
 * executes itself and OrcaSynapse can only admit or refuse whole, and
 * OrcaSynapse-executed MCP tools, where every call passes through the gateway.
 * Almost every test here is about whether an operator can tell them apart and
 * find the thing blocking the change they want to make.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup to a file so the screen can be
 * looked at without a session, matching `governance-views.test.tsx`.
 */
import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type AgentProfile,
  type GatewayCredential,
  type GovernedTool,
  type HermesRuntimeCatalogue,
  type ToolGrant,
  type ToolMetrics,
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

const emptyMetrics: ToolMetrics = {
  generatedAt: "2026-08-07T00:00:00.000Z",
  activeTools: 0,
  activeGrants: 0,
  pendingApprovals: 0,
  executingCalls: 0,
  completedCalls: 0,
  deniedCalls: 0,
  failedCalls: 0,
};

const profiles = [
  {
    id: "1f0c1d55-1111-4111-8111-111111111111",
    slug: "support-analyst",
    activeVersion: 3,
    version: { id: "2f0c1d55-2222-4222-8222-222222222222", version: 3 },
    activeVersionConfiguration: null,
  },
] as unknown as AgentProfile[];

const api = vi.hoisted(() => ({
  getGovernedTools: vi.fn(),
  getToolGrants: vi.fn(),
  getAgentProfiles: vi.fn(),
  getGatewayCredentials: vi.fn(),
  getToolCalls: vi.fn(),
  getToolRuntime: vi.fn(),
  getToolMetrics: vi.fn(),
  getPendingToolApprovals: vi.fn(),
  getToolsetAdmissions: vi.fn(),
  getRuntimeCatalogue: vi.fn(),
  decideToolsetAdmission: vi.fn(),
  decideToolApproval: vi.fn(),
  setGovernedToolStatus: vi.fn(),
  updateToolRuntime: vi.fn(),
  upsertToolGrant: vi.fn(),
  issueGatewayCredential: vi.fn(),
  revokeGatewayCredential: vi.fn(),
}));

vi.mock("./api.js", async (load) => ({ ...(await load<typeof import("./api.js")>()), ...api }));

const { ToolingView } = await import("./tooling-view.js");

interface Setup {
  tools?: GovernedTool[];
  grants?: ToolGrant[];
  credentials?: GatewayCredential[];
  catalogue?: HermesRuntimeCatalogue | null;
  admissions?: Array<{ toolsetName: string; admitted: boolean; reason: string | null }>;
  metrics?: Partial<ToolMetrics>;
  gatewayEnabled?: boolean;
  approvals?: unknown[];
}

function setupApi(over: Setup = {}) {
  api.getGovernedTools.mockResolvedValue({ items: over.tools ?? [] });
  api.getToolGrants.mockResolvedValue({ items: over.grants ?? [] });
  api.getAgentProfiles.mockResolvedValue({ items: profiles });
  api.getGatewayCredentials.mockResolvedValue({ items: over.credentials ?? [] });
  api.getToolCalls.mockResolvedValue({ items: [] });
  api.getToolRuntime.mockResolvedValue({
    enabled: over.gatewayEnabled ?? false,
    reason: "Gateway controls reviewed for the isolated pilot.",
    approvalTtlMinutes: 15,
    updatedAt: "2026-08-07T00:00:00.000Z",
    updatedBy: null,
  });
  api.getToolMetrics.mockResolvedValue({ ...emptyMetrics, ...over.metrics });
  api.getPendingToolApprovals.mockResolvedValue({ items: over.approvals ?? [] });
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

const props = { session, onConfigure: vi.fn(), onSessionExpired: vi.fn() };

async function view(over: Setup = {}) {
  setupApi(over);
  render(<main><ToolingView {...props} /></main>);
  // The screen is driven entirely by an effect, so nothing below is meaningful
  // until the first load lands.
  await waitFor(() => screen.getByLabelText("Agent tooling summary"));
  const out = process.env.VIEW_PREVIEW_OUT;
  if (out) writeFileSync(out.replace("VIEW", "tooling"), document.body.innerHTML, "utf8");
}

const catalogue = (
  ...toolsets: Array<{ name: string; enabled: boolean; toolCount?: number }>
): HermesRuntimeCatalogue => ({
  toolsets: toolsets.map((toolset) => ({
    name: toolset.name,
    label: null,
    enabled: toolset.enabled,
    toolCount: toolset.toolCount ?? 1,
  })),
  skills: [],
  enabledToolsets: toolsets.filter((toolset) => toolset.enabled).length,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("the two governance planes", () => {
  it("gives each plane its own region and says who executes the call", async () => {
    /*
     * This is the product's actual governance story and the old screen never
     * stated it: an operator could not tell why one block offers per-tool
     * grants and the other only a whole-toolset yes/no.
     */
    await view();
    const native = screen.getByLabelText("Hermes-native toolsets");
    const gateway = screen.getByLabelText("OrcaSynapse MCP gateway");
    expect(within(native).getByText(/the runtime executes these itself/i)).toBeTruthy();
    expect(within(gateway).getByText(/OrcaSynapse executes these itself/i)).toBeTruthy();
  });

  it("does not claim MCP tools are running when none is installed", async () => {
    await view();
    const summary = screen.getByLabelText("Agent tooling summary");
    expect(within(summary).getByText(/No OrcaSynapse-executed MCP tool is installed/i)).toBeTruthy();
  });
});

describe("the gateway enable path", () => {
  it("states every prerequisite beside the button rather than at the foot of another card", async () => {
    /*
     * The blocking sentence used to live ~900px below the control it blocks,
     * and it named only one of the three prerequisites the API enforces.
     */
    await view();
    const gateway = screen.getByLabelText("OrcaSynapse MCP gateway");
    expect(within(gateway).getByText(/No governed tool is installed/i)).toBeTruthy();
    expect(within(gateway).getByText(/No agent revision is granted a tool/i)).toBeTruthy();
    expect(within(gateway).getByText(/No gateway credential has been issued/i)).toBeTruthy();
  });

  it("refuses to offer Enable while the API would reject it", async () => {
    await view();
    const gateway = screen.getByLabelText("OrcaSynapse MCP gateway");
    // Three of the four: the runtime answered and reported nothing enabled, so
    // the boundary check is the one prerequisite this fixture satisfies.
    expect(within(gateway).getByRole("button", { name: /Enable gateway/i }).hasAttribute("disabled")).toBe(true);
    expect(within(gateway).getByText("Enable is blocked by 3 unmet checks above.")).toBeTruthy();
  });

  it("counts the runtime boundary as a gateway prerequisite too", async () => {
    // Enabling the gateway re-runs assertAdmittedToolBoundary; an unreachable
    // runtime fails it, and the old screen never mentioned that at all.
    await view({ catalogue: null });
    const gateway = screen.getByLabelText("OrcaSynapse MCP gateway");
    expect(within(gateway).getByText(/could not read the runtime's toolsets/i)).toBeTruthy();
  });
});

describe("built-in memory", () => {
  it("is named as the baseline capability instead of reading as zero tools", async () => {
    // Invariant 7: native toolsets are default-deny *except* built-in memory.
    // "0 of 0 admitted" alone tells an operator the opposite.
    await view();
    const native = screen.getByLabelText("Hermes-native toolsets");
    expect(within(native).getByText(/Built-in memory is permitted on every run/i)).toBeTruthy();
    expect(within(native).getByText(/cannot be admitted or revoked here/i)).toBeTruthy();
  });

  it("is not reported as drift, because the boundary always permits it", async () => {
    /*
     * The old merge flagged an enabled `memory` toolset with no admission row
     * as drift and announced that every run was being refused. The Hermes
     * client adds "memory" to the permitted set unconditionally, so runs were
     * fine and the alarm was false.
     */
    await view({ catalogue: catalogue({ name: "memory", enabled: true }) });
    expect(screen.queryAllByText(/Every chat turn and agent run is refused/i)).toHaveLength(0);
    const summary = screen.getByLabelText("Agent tooling summary");
    expect(within(summary).getByText("Agents run with built-in memory only.")).toBeTruthy();
  });

  it("still reports drift for a toolset that is not the memory baseline", async () => {
    await view({ catalogue: catalogue({ name: "code_execution", enabled: true }) });
    // Stated twice on purpose: once in the summary, once at the point of
    // action. The blast radius is the whole product, not this screen.
    expect(screen.getAllByText(/Every chat turn and agent run is refused/i).length).toBe(2);
    // The row itself, not merely the sentence that names it.
    const native = screen.getByLabelText("Hermes-native toolsets");
    expect(within(native).getByText("code_execution")).toBeTruthy();
  });
});

describe("recording an admission the runtime has not reported", () => {
  it("offers the control the empty state promises", async () => {
    /*
     * With no catalogue the old screen listed no rows, so there was no button
     * to press — while its empty state said admissions could still be
     * recorded. PUT /toolsets/:name accepts any name, so this is a control the
     * API always supported and the screen dropped.
     */
    const user = userEvent.setup();
    await view();
    const native = screen.getByLabelText("Hermes-native toolsets");
    await user.type(within(native).getByLabelText(/Toolset name/i), "clarify");
    await user.type(within(native).getByLabelText(/admitted or refused/i), "Asks a question; touches no data.");
    await user.click(within(native).getByRole("button", { name: /Record admission/i }));
    await waitFor(() => expect(api.decideToolsetAdmission).toHaveBeenCalledWith(
      "clarify",
      true,
      "Asks a question; touches no data.",
    ));
  });
});

describe("the registry", () => {
  it("says why it is empty and that the console cannot fill it", async () => {
    // It used to render an empty div: a whole column of nothing, next to a very
    // tall form, explaining neither what belongs there nor how it gets there.
    await view();
    const registry = screen.getByLabelText("Tool registry");
    expect(within(registry).getByText(/arrive with an OrcaSynapse release/i)).toBeTruthy();
  });
});

describe("the summary", () => {
  it("reports the approval backlog the API already returns", async () => {
    // pendingApprovals was fetched on every poll and never rendered.
    await view({ metrics: { pendingApprovals: 2 } });
    const summary = screen.getByLabelText("Agent tooling summary");
    expect(within(summary).getByText("Awaiting approval")).toBeTruthy();
    expect(within(summary).getByText("2")).toBeTruthy();
  });
});

describe("access", () => {
  it("keeps a session pending a forced password change locked out", async () => {
    render(<ToolingView {...props} session={{ ...session, passwordChangeRequired: true }} />);
    expect(screen.getByRole("heading", { name: "Agent Tools" })).toBeTruthy();
    expect(api.getGovernedTools).not.toHaveBeenCalled();
  });

  it("draws the locked screen with no session", () => {
    render(<ToolingView {...props} session={null} />);
    expect(screen.getByRole("heading", { name: "Agent Tools" })).toBeTruthy();
    expect(api.getToolRuntime).not.toHaveBeenCalled();
  });
});

describe("the built container", () => {
  it("lets the ledger shrink instead of scrolling the whole page sideways", async () => {
    /*
     * The ledger's table sets `min-w-[720px]` and scrolls inside its own
     * container. Its Panel is a grid item, though, so it takes an automatic
     * minimum size from that 720px and overflows its track — which pushed the
     * document to 1043px inside a 753px viewport and made every panel on the
     * screen scroll horizontally, not just the table. jsdom computes no
     * layout, so the mechanism is what can be asserted here.
     */
    await view();
    expect(screen.getByLabelText("Tool-call ledger").className).toContain("min-w-0");
  });

  it("renders no inline style, which the CSP would refuse", async () => {
    await view({ catalogue: catalogue({ name: "code_execution", enabled: true }) });
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
