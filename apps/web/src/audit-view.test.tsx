/** @vitest-environment jsdom */
import {
  auditEventQuerySchema,
  type AdministratorSession,
  type AdminScope,
  type AuditEvent,
  type AuditEventQuery,
} from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditView } from "./audit-view.js";

const queried = vi.fn(async (_query: AuditEventQuery): Promise<{ items: AuditEvent[]; nextCursor: null }> => ({
  items: [],
  nextCursor: null,
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getAuditEvents: (...args: unknown[]) => queried(...args as [AuditEventQuery]),
    // Never settles: the forwarding banner is not what these tests are about,
    // and a resolution landing outside `act` is only noise.
    getAuditForwarding: vi.fn(() => new Promise<never>(() => {})),
  };
});

afterEach(() => { cleanup(); queried.mockClear(); });

function session(scopes: AdminScope[]): AdministratorSession {
  return {
    id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
    subject: "local-admin:auditor",
    role: "AUDITOR",
    scopes,
    createdAt: "2026-08-01T00:00:00.000Z",
    idleExpiresAt: "2026-08-01T08:00:00.000Z",
    absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
    authenticationMethod: "LOCAL_PASSWORD",
    passwordChangeRequired: false,
  } as AdministratorSession;
}

describe("AuditView", () => {
  it("refuses to render the trail without the audit:read scope", () => {
    const markup = renderToStaticMarkup(
      <AuditView session={session(["operations:read"] as AdminScope[])} onSessionExpired={vi.fn()} />,
    );

    expect(markup).toContain("does not carry the audit:read scope");
    // No filter form is offered for a role that cannot query. Asserted on a
    // control the operator would use rather than on a class name, so this
    // cannot quietly become a tautology when the styling changes.
    expect(markup).not.toContain("Resource type");
    expect(markup).not.toMatch(/<form/);
  });

  it("renders the query surface for a reader", () => {
    const markup = renderToStaticMarkup(
      <AuditView session={session(["audit:read"] as AdminScope[])} onSessionExpired={vi.fn()} />,
    );

    expect(markup).toContain("Audit trail");
    expect(markup).toMatch(/<form/);
    // Every indexed dimension the API filters on is offered.
    for (const label of ["Action", "Actor type", "Resource type", "Resource ID", "Outcome"]) {
      expect(markup).toContain(label);
    }
  });

  it("states that the trail cannot be edited", () => {
    const markup = renderToStaticMarkup(
      <AuditView session={session(["audit:read"] as AdminScope[])} onSessionExpired={vi.fn()} />,
    );

    // The append-only guarantee is the point of the trail; say it where it is read.
    expect(markup).toContain("append-only");
  });

  it("fills the remaining viewport and puts the trail in the rows", async () => {
    queried.mockResolvedValue({
      items: [{
        id: "171fc11b-a8c6-49d7-b6aa-019d35888acb",
        occurredAt: "2026-08-17T00:00:00.000Z",
        actorType: "USER" as const,
        actorId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
        action: "administrator.session_created",
        resourceType: "AdministratorSession",
        resourceId: "94ee04dc-a8c6-49d7-b6aa-019d35888acb",
        outcome: "SUCCESS",
        correlationId: null,
        sourceIp: "10.0.0.4",
        metadata: { method: "LOCAL_PASSWORD" },
      }],
      nextCursor: null,
    });
    render(<AuditView session={session(["audit:read"] as AdminScope[])} onSessionExpired={vi.fn()} />);
    expect(await screen.findByText("session created")).toBeTruthy();
    expect(screen.getByText("administrator.session_created")).toBeTruthy();
    expect(screen.getByText("10.0.0.4")).toBeTruthy();
    expect(screen.getByText("method: LOCAL_PASSWORD")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
    const workspace = document.querySelector(".audit-workspace");
    expect(workspace?.className).toMatch(/\bh-full\b/);
    expect(workspace?.className).toMatch(/\bmin-h-0\b/);
  });

  it("sends a pasted identifier the query contract still matches on", async () => {
    // A pasted id often carries trailing whitespace, and the filters are exact
    // matches — but `auditEventQuerySchema` is what the API parses the request
    // with, and it trims before matching. Asserted through that schema rather
    // than against a literal, so this stays true of what the API actually does:
    // if the contract ever stopped trimming, this view would have to.
    const identifier = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
    render(<AuditView session={session(["audit:read"] as AdminScope[])} onSessionExpired={vi.fn()} />);
    await waitFor(() => expect(queried).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Resource ID/), { target: { value: `${identifier} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(queried).toHaveBeenCalledTimes(2));

    expect(auditEventQuerySchema.parse(queried.mock.calls[1]![0]))
      .toMatchObject({ resourceId: identifier });
  });
});
