/**
 * @vitest-environment jsdom
 *
 * Prompts and Guardrails, populated. Both release an artefact into the chat
 * path and both fail closed when a previously-active one is suspended, so the
 * cases below are about whether the screen says which of those three states it
 * is in.
 *
 * As with `models-view.test.tsx`, `VIEW_PREVIEW_OUT` writes the rendered markup
 * to a file so the screen can be looked at without a session.
 */
import { ADMIN_SCOPES, type AdministratorSession, type GuardrailPolicy, type PromptTemplate } from "@orcasynapse/contracts";
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

const shared = {
  createdBy: session.id,
  updatedBy: session.id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  firstActivatedAt: "2026-08-02T00:00:00.000Z",
  activationEvaluationId: "6d5af930-66fb-4741-a9e2-1665c3730546",
  revision: 4,
};

const prompts = [
  {
    ...shared,
    id: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b",
    slug: "chat-system",
    displayName: "Governed chat instruction",
    description: "Owned by the platform team; reviewed each release.",
    purpose: "CHAT_SYSTEM",
    version: "4.2",
    content: "You are a careful OrcaSynapse analyst.\nBe precise, evidence-led, and candid about uncertainty.",
    contentChecksum: "9f2c4a1b7e5d3086f4a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0",
    status: "ACTIVE",
  },
] as unknown as PromptTemplate[];

const policies = [
  {
    ...shared,
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    slug: "baseline-chat",
    displayName: "Baseline chat boundary",
    description: "Size ceilings plus the two OrcaSynapse-native detectors.",
    version: "2.0",
    maxInputCharacters: 16_000,
    maxOutputCharacters: 120_000,
    blockControlCharacters: true,
    blockCredentialPatterns: true,
    status: "ACTIVE",
  },
] as unknown as GuardrailPolicy[];

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getPromptTemplates: vi.fn(async () => ({ items: prompts })),
    getGuardrailPolicies: vi.fn(async () => ({ items: policies })),
  };
});

const { PromptsView } = await import("./prompts-view.js");
const { GuardrailsView } = await import("./guardrails-view.js");

const dump = (name: string) => {
  const out = process.env.VIEW_PREVIEW_OUT;
  if (out) writeFileSync(out.replace("VIEW", name), document.body.innerHTML, "utf8");
};

async function promptsView() {
  render(<main><PromptsView session={session} onOpenOperations={vi.fn()} onOpenSettings={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByRole("heading", { name: "Governed chat instruction" }));
  dump("prompts");
}

async function guardrailsView() {
  render(<main><GuardrailsView session={session} onConfigureInference={vi.fn()} onOpenOperations={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByRole("heading", { name: "Baseline chat boundary" }));
  dump("guardrails");
}

afterEach(cleanup);

describe("prompts", () => {
  it("names the exact release bound to chat, not merely that one exists", async () => {
    await promptsView();
    expect(screen.getByText("Governed chat instruction v4.2 is bound to chat.")).toBeTruthy();
  });

  it("shows the instruction verbatim, because that is the artefact under review", async () => {
    await promptsView();
    expect(screen.getByText(/Be precise, evidence-led, and candid/)).toBeTruthy();
    // The checksum is what audit retains in place of the body.
    expect(screen.getAllByText(/9f2c4a1b7e5d3086…/).length).toBeGreaterThan(0);
  });

  it("reports the evidence gate as passed only when an evaluation is promoted", async () => {
    await promptsView();
    const summary = screen.getByLabelText("Prompt governance summary");
    expect(within(summary).getByText("Passed")).toBeTruthy();
  });
});

describe("guardrails", () => {
  it("names the policy enforcing chat and the checks it turns on", async () => {
    await guardrailsView();
    expect(screen.getByText("Baseline chat boundary v2.0 is enforcing chat.")).toBeTruthy();
    expect(screen.getByText("control chars")).toBeTruthy();
    expect(screen.getByText("credentials")).toBeTruthy();
  });

  it("counts only the detectors actually switched on", async () => {
    await guardrailsView();
    const summary = screen.getByLabelText("Guardrail policy summary");
    expect(within(summary).getByText("Active checks")).toBeTruthy();
    expect(within(summary).getByText("2")).toBeTruthy();
  });

  it("offers Suspend on the active policy, which is the fail-closed decision", async () => {
    await guardrailsView();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("both", () => {
  it("render no inline style, which the CSP would refuse in the built container", async () => {
    await promptsView();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
    cleanup();
    await guardrailsView();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
