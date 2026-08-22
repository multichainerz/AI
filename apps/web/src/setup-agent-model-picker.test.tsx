/**
 * @vitest-environment jsdom
 */
import type { ModelDeployment, ModelObservation, ServiceConnectionSummary } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
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

const { SetupAgentModelPicker } = await import("./setup-agent-model-picker.js");

const connection = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  displayName: "OpenRouter",
  kind: "INFERENCE",
  enabled: true,
  status: "HEALTHY",
  baseUrl: "https://openrouter.ai/api/v1",
} as ServiceConnectionSummary;

const free = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  connectionId: connection.id,
  alias: "nvidia/nemotron-3-nano:free",
  displayName: "Nemotron Nano (free)",
  observedContextWindowTokens: 131_072,
  observedMaxOutputTokens: 8_192,
  inputModalities: ["text"],
  ownedBy: "nvidia",
  lastSeenAt: "2026-08-22T00:00:00.000Z",
  missingFromUpstream: false,
  admittedWorkloads: [],
} as ModelObservation;

const paid = { ...free, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", alias: "anthropic/claude-sonnet-4", displayName: "Claude" };

const draftRoute = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  slug: "nvidia-nemotron-3-nano-free",
  modelAlias: free.alias,
  workload: "AGENT",
  status: "DRAFT",
  isDefault: false,
  revision: 1,
  connection: { id: connection.id },
} as ModelDeployment;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.refreshConnectionModels.mockResolvedValue({
    items: [paid, free],
    connectionId: connection.id,
    refreshedAt: "2026-08-22T00:00:00.000Z",
    upserted: 2,
    vanished: 0,
    backfill: null,
  });
  api.getModelDeployments.mockResolvedValue({ items: [] });
  api.createModelDeployment.mockResolvedValue(draftRoute);
  api.changeModelDeploymentState.mockResolvedValue({ ...draftRoute, status: "ACTIVE", isDefault: true });
});

afterEach(cleanup);

describe("SetupAgentModelPicker", () => {
  it("lists OpenRouter :free variants and admits the pick as the default AGENT", async () => {
    const onReady = vi.fn();
    render(<SetupAgentModelPicker connection={connection} onReady={onReady} onSessionExpired={vi.fn()} />);

    const select = await screen.findByLabelText("Free OpenRouter model");
    await waitFor(() => expect(select).toHaveProperty("disabled", false));
    expect(select.textContent).toContain("nvidia/nemotron-3-nano:free");
    expect(select.textContent).not.toContain("claude-sonnet-4");
    expect(select.textContent).not.toContain("openrouter/free");

    fireEvent.change(select, { target: { value: free.alias } });
    fireEvent.click(screen.getByRole("button", { name: "Use as default Agent" }));

    await waitFor(() => expect(api.createModelDeployment).toHaveBeenCalled());
    expect(api.createModelDeployment).toHaveBeenCalledWith(expect.objectContaining({
      slug: "nvidia-nemotron-3-nano-free",
      modelAlias: "nvidia/nemotron-3-nano:free",
      workload: "AGENT",
      connectionId: connection.id,
      version: "observed",
    }));
    expect(api.changeModelDeploymentState).toHaveBeenCalledWith(
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "activate",
      expect.objectContaining({ makeDefault: true, reason: "Setup default agent model" }),
    );
    expect(onReady).toHaveBeenCalled();
  });

  it("activates an existing AGENT route of the same alias instead of creating a second", async () => {
    api.getModelDeployments.mockResolvedValue({ items: [draftRoute] });
    render(<SetupAgentModelPicker connection={connection} onReady={vi.fn()} onSessionExpired={vi.fn()} />);

    const select = await screen.findByLabelText("Free OpenRouter model");
    await waitFor(() => expect(select).toHaveProperty("disabled", false));
    fireEvent.change(select, { target: { value: free.alias } });
    fireEvent.click(screen.getByRole("button", { name: "Use as default Agent" }));

    await waitFor(() => expect(api.changeModelDeploymentState).toHaveBeenCalled());
    expect(api.createModelDeployment).not.toHaveBeenCalled();
  });

  it("lists the local catalogue when the endpoint is not OpenRouter", async () => {
    const local = { ...free, alias: "hermes-agent", displayName: "Hermes" };
    api.refreshConnectionModels.mockResolvedValue({
      items: [local, { ...free, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", alias: "text-embedding-3-small" }],
      connectionId: connection.id,
      refreshedAt: "2026-08-22T00:00:00.000Z",
      upserted: 2,
      vanished: 0,
      backfill: null,
    });
    render(
      <SetupAgentModelPicker
        connection={{ ...connection, baseUrl: "http://gpu.internal:8000" }}
        onReady={vi.fn()}
        onSessionExpired={vi.fn()}
      />,
    );

    const select = await screen.findByLabelText("Served model");
    await waitFor(() => expect(select.textContent).toContain("hermes-agent"));
    expect(select.textContent).not.toContain("text-embedding-3-small");
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    render(<SetupAgentModelPicker connection={connection} onReady={vi.fn()} onSessionExpired={vi.fn()} />);
    expect(await screen.findByRole("region", { name: "Default agent model" })).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
