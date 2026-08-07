/**
 * @vitest-environment jsdom
 *
 * Knowledge and the audit trail, populated. Both make a claim about what is
 * *not* kept — Knowledge that no source bytes are retained, Audit that no entry
 * can be edited — and both have a failure state that must not read like a
 * healthy one.
 *
 * `VIEW_PREVIEW_OUT` writes the rendered markup so either can be looked at
 * without a session; see `chat-transcript.test.tsx`.
 */
import { ADMIN_SCOPES, type AdministratorSession, type AuditEvent, type DocumentSummary } from "@orcasynapse/contracts";
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

const documents = [
  { id: "doc-ready", fileName: "runbook.pdf", classification: "INTERNAL", status: "READY", sizeBytes: 482_133, retentionUntil: "2027-08-01T00:00:00.000Z", failureCode: null, failureMessage: null },
  { id: "doc-failed", fileName: "scan.pdf", classification: "CONFIDENTIAL", status: "FAILED", sizeBytes: 1_204_992, retentionUntil: "2027-08-01T00:00:00.000Z", failureCode: "NO_EXTRACTABLE_TEXT", failureMessage: "This PDF carries no text layer; OrcaSynapse performs no OCR." },
] as unknown as DocumentSummary[];

const events = [
  { id: "e1", action: "model.activated", actorType: "USER", actorId: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", resourceType: "ModelDeployment", resourceId: "3e5f7a91-2c4d-4e6f-8a0b-1c2d3e4f5a6b", outcome: "SUCCESS", occurredAt: "2026-08-07T10:00:00.000Z", correlationId: null, sourceIp: "10.0.0.4", metadata: { reason: "Evaluation promoted." } },
  { id: "e2", action: "administrator.session_created", actorType: "SYSTEM", actorId: null, resourceType: "AdministratorSession", resourceId: null, outcome: "FAILURE", occurredAt: "2026-08-07T09:30:00.000Z", correlationId: null, sourceIp: null, metadata: { error: "PASSWORD_CHANGE_REQUIRED" } },
] as unknown as AuditEvent[];

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getDocuments: vi.fn(async () => ({ items: documents })),
    getDocument: vi.fn(async () => documents[1]),
    getDocumentMetrics: vi.fn(async () => ({ total: 2, processing: 0, ready: 1 })),
    getAuditEvents: vi.fn(async () => ({ items: events, nextCursor: null })),
    getAuditForwarding: vi.fn(async () => ({
      status: "BEHIND",
      summary: "1,204 events are waiting to reach the SIEM.",
      pendingCount: 1_204,
      deliveredCount: 88_301,
      lastForwardedAt: "2026-08-07T08:00:00.000Z",
      lastError: null,
    })),
  };
});

const { DocumentsView } = await import("./documents-view.js");
const { AuditView } = await import("./audit-view.js");

const dump = (name: string) => {
  const out = process.env.VIEW_PREVIEW_OUT;
  if (out) writeFileSync(out.replace("VIEW", name), document.body.innerHTML, "utf8");
};

async function knowledge() {
  render(<main><DocumentsView unlocked administrator oidcConfigured onSignIn={vi.fn()} onConfigure={vi.fn()} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByText("runbook.pdf"));
  dump("knowledge");
}

async function audit() {
  render(<main><AuditView session={session} onSessionExpired={vi.fn()} /></main>);
  await waitFor(() => screen.getByText("model.activated"));
  dump("audit");
}

afterEach(cleanup);

describe("knowledge", () => {
  it("states the zero it is claiming, not a blank", async () => {
    // "No source bytes retained" is the product's promise about the original
    // file; rendered as an empty cell it would read as missing data.
    await knowledge();
    const summary = screen.getByLabelText("Knowledge summary");
    expect(within(summary).getByText("Source bytes retained")).toBeTruthy();
    expect(within(summary).getByText("0 B")).toBeTruthy();
  });

  it("warns about the missing OCR before an upload, not after it fails", async () => {
    // The warning lives in the upload panel, which is where someone is about to
    // hand over a scanned PDF -- not in a failure message afterwards.
    const user = userEvent.setup();
    await knowledge();
    await user.click(screen.getByRole("button", { name: "Add source" }));
    expect(screen.getByText(/There is no OCR/)).toBeTruthy();
  });

  it("distinguishes an indexed source from one that failed extraction", async () => {
    await knowledge();
    // "Ready" also names a summary figure, so scope to the list.
    const list = screen.getByLabelText("Knowledge source list");
    expect(within(list).getByText("Ready")).toBeTruthy();
    expect(within(list).getByText("Failed")).toBeTruthy();
  });
});

describe("audit trail", () => {
  it("says the trail is behind rather than presenting it as delivered", async () => {
    // A trail silently lagging the SIEM is the single thing this panel exists
    // to surface.
    await audit();
    expect(screen.getByText("Forwarding is behind")).toBeTruthy();
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.getByText("88,301")).toBeTruthy();
  });

  it("tones a failed action differently from a successful one", async () => {
    await audit();
    expect(screen.getByText("success")).toBeTruthy();
    expect(screen.getByText("failure")).toBeTruthy();
  });

  it("keeps saying the trail cannot be edited", async () => {
    await audit();
    expect(screen.getByText(/append-only/)).toBeTruthy();
  });
});

describe("both", () => {
  it("render no inline style, which the CSP would refuse in the built container", async () => {
    await knowledge();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
    cleanup();
    await audit();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
