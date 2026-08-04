import type { AdministratorSession, AdminScope } from "@orcasynapse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuditView } from "./audit-view.js";

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, getAuditEvents: vi.fn(async () => ({ items: [], nextCursor: null })) };
});

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
    // No filter form is offered for a role that cannot query.
    expect(markup).not.toContain("audit-filters");
  });

  it("renders the query surface for a reader", () => {
    const markup = renderToStaticMarkup(
      <AuditView session={session(["audit:read"] as AdminScope[])} onSessionExpired={vi.fn()} />,
    );

    expect(markup).toContain("Audit trail");
    expect(markup).toContain("audit-filters");
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
});
