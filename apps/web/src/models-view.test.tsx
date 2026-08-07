/**
 * @vitest-environment jsdom
 *
 * Models, populated. Like `chat-transcript.test.tsx`, this is both a test and
 * the only way to *see* the screen: every governance view renders only its
 * locked state without a session, so a screenshot of the running app proves
 * nothing about the catalogue. Set `VIEW_PREVIEW_OUT` to a path and it writes
 * the rendered markup there; pair that with the stylesheet from
 * `pnpm --filter @orcasynapse/web build` and it opens in a browser.
 */
import { ADMIN_SCOPES, type AdministratorSession, type ModelDeployment, type ServiceConnectionSummary } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

const connections = [
  { id: "conn-1", displayName: "Primary vLLM", kind: "INFERENCE", enabled: true, status: "HEALTHY" },
] as unknown as ServiceConnectionSummary[];

const model = (over: Partial<ModelDeployment>): ModelDeployment => ({
  id: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b",
  slug: "laguna-hermes",
  displayName: "Laguna Hermes",
  modelAlias: "hermes-agent",
  workload: "AGENT",
  connection: { id: "conn-1", displayName: "Primary vLLM", kind: "INFERENCE", status: "HEALTHY" },
  activationEvaluationId: "6d5af930-66fb-4741-a9e2-1665c3730546",
  version: "2.1-nvfp4",
  license: "Approved: internal-use",
  contextWindowTokens: 131_072,
  maxOutputTokens: 8_192,
  maxConcurrentRequests: 2,
  status: "ACTIVE",
  isDefault: true,
  revision: 3,
  firstActivatedAt: "2026-08-01T00:00:00.000Z",
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  ...over,
} as ModelDeployment);

const models = [
  model({}),
  model({
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    slug: "chat-frontline",
    displayName: "Chat frontline",
    modelAlias: "qwen3.6-27b",
    workload: "CHAT",
    version: "3.6-awq",
    status: "DRAFT",
    isDefault: false,
    revision: 1,
    firstActivatedAt: null,
    activationEvaluationId: null,
    license: null,
  }),
];

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, getModelDeployments: vi.fn(async () => ({ items: models })) };
});

const { ModelsView } = await import("./models-view.js");

async function view() {
  render(
    <main>
      <ModelsView
        session={session}
        connections={connections}
        onConfigureConnections={vi.fn()}
        onOpenOperations={vi.fn()}
        onSessionExpired={vi.fn()}
      />
    </main>,
  );
  await waitFor(() => screen.getByText("Laguna Hermes"));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(cleanup);

describe("models catalogue", () => {
  it("counts the catalogue by the things an operator decides about", async () => {
    await view();
    const summary = screen.getByLabelText("Model catalogue summary");

    // Two routes, one active, one default, two workloads.
    expect(within(summary).getByText("Catalogue routes")).toBeTruthy();
    expect(within(summary).getAllByText("2")).not.toHaveLength(0);
  });

  it("distinguishes a route that is serving from one that is not", async () => {
    await view();

    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("draft")).toBeTruthy();
    // The default carries a mark, because "which one answers by default" is not
    // derivable from anything else on the card.
    expect(screen.getByText("Default")).toBeTruthy();
  });

  it("shows the immutable version, which is what evaluation evidence is pinned to", async () => {
    await view();
    expect(screen.getByText("2.1-nvfp4")).toBeTruthy();
    expect(screen.getByText("3.6-awq")).toBeTruthy();
    // The draft has no promoted evidence, and the card has to say so — that is
    // the single thing standing between it and serving traffic.
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("Promoted")).toBeTruthy();
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await view();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
