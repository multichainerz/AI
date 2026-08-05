import { ADMIN_SCOPES, type AdministratorSession } from "@orcasynapse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { adminAccess } from "./admin-access.js";
import { GuardrailsView } from "./guardrails-view.js";
import { MemoryView } from "./memory-view.js";
import { ModelsView } from "./models-view.js";
import { PromptsView } from "./prompts-view.js";

const session: AdministratorSession = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "platform-admin",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-08-05T00:00:00.000Z",
  idleExpiresAt: "2026-08-05T01:00:00.000Z",
  absoluteExpiresAt: "2026-08-05T08:00:00.000Z",
};

const pendingPasswordChange: AdministratorSession = { ...session, passwordChangeRequired: true };

describe("adminAccess", () => {
  it("treats a session pending a forced password change as locked", () => {
    // requireAdmin on the API answers 403 PASSWORD_CHANGE_REQUIRED for this
    // session, so a view that called it "signed in" would render a full
    // workspace whose every request fails.
    const access = adminAccess(pendingPasswordChange);
    expect(access.unlocked).toBe(false);
    expect(access.scopes).toEqual([]);
    expect(access.can("memory:manage")).toBe(false);
  });

  it("grants exactly the session's scopes once the password is settled", () => {
    const access = adminAccess(session);
    expect(access.unlocked).toBe(true);
    expect(access.can("memory:manage")).toBe(true);
    expect(access.can("chat:use")).toBe(true);
  });

  it("locks everything when there is no session at all", () => {
    expect(adminAccess(null)).toMatchObject({ unlocked: false, scopes: [] });
  });
});

describe("platform governance views", () => {
  const views = [
    ["Memory", (s: AdministratorSession) => <MemoryView session={s} onOpenSettings={vi.fn()} onSessionExpired={vi.fn()} />],
    ["Models", (s: AdministratorSession) => <ModelsView session={s} connections={[]} onConfigureConnections={vi.fn()} onOpenOperations={vi.fn()} onSessionExpired={vi.fn()} />],
    ["Prompts", (s: AdministratorSession) => <PromptsView session={s} onOpenOperations={vi.fn()} onOpenSettings={vi.fn()} onSessionExpired={vi.fn()} />],
    ["Guardrails", (s: AdministratorSession) => <GuardrailsView session={s} onConfigureInference={vi.fn()} onOpenOperations={vi.fn()} onSessionExpired={vi.fn()} />],
  ] as const;

  for (const [name, render] of views) {
    it(`${name} shows its locked screen while a password change is pending`, () => {
      const html = renderToStaticMarkup(render(pendingPasswordChange));
      expect(html).toContain("Administrator session required");
    });

    it(`${name} presents the same shell as every other governance screen`, () => {
      // One area, one shape: a titled workspace and a lock panel with the same
      // recovery action, so Platform does not read as four unrelated screens.
      const html = renderToStaticMarkup(render(pendingPasswordChange));
      expect(html).toMatch(/class="[a-z]+-workspace"/);
      expect(html).toMatch(/class="[a-z]+-lock panel"/);
      expect(html).toContain("Open platform settings");
    });
  }
});
