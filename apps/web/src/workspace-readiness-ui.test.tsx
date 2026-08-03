import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "./chat-view.js";
import { DocumentsView } from "./documents-view.js";

describe("workspace readiness UI", () => {
  it("does not claim Hermes is ready before the administrator completes the next required step", () => {
    const html = renderToStaticMarkup(<ChatView
      unlocked
      identityMode="ADMINISTRATOR_PREVIEW"
      displayName="System administrator"
      administratorReadiness={{
        ready: false,
        title: "Create an Agent Profile",
        detail: "Create and activate one Profile.",
        target: "Agents",
      }}
      oidcConfigured={false}
      onSignIn={vi.fn()}
      onConfigure={vi.fn()}
      onOpenAgents={vi.fn()}
      onOpenPlatform={vi.fn()}
      onUnauthorized={vi.fn()}
    />);

    expect(html).toContain("Setup required");
    expect(html).toContain("Create Agent Profile");
    expect(html).not.toContain("Hermes route ready");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("keeps knowledge metadata visible while preventing uploads to degraded Supermemory", () => {
    const html = renderToStaticMarkup(<DocumentsView
      unlocked
      administrator
      serviceReady={false}
      oidcConfigured={false}
      onSignIn={vi.fn()}
      onConfigure={vi.fn()}
      onUnauthorized={vi.fn()}
    />);

    expect(html).toContain("Supermemory needs attention");
    expect(html).toContain("Existing metadata remains visible");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Memory unavailable<\/button>/);
    expect(html).not.toContain("Direct Supermemory ingestion");
  });
});
