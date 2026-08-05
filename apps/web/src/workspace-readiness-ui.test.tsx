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
      onSessionExpired={vi.fn()}
    />);

    expect(html).toContain("Setup required");
    expect(html).toContain("Create Agent Profile");
    expect(html).not.toContain("Hermes route ready");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("keeps knowledge uploads available independently of the VM2 memory plane", () => {
    // Document knowledge is extracted and embedded locally since the pgvector
    // migration; the Supermemory connection backs Hermes agent memory only, so
    // its health must not gate uploads or appear in this workspace.
    const html = renderToStaticMarkup(<DocumentsView
      unlocked
      administrator
      oidcConfigured={false}
      onSignIn={vi.fn()}
      onConfigure={vi.fn()}
      onSessionExpired={vi.fn()}
    />);

    expect(html).toContain("Add source");
    expect(html).toContain("private vector index");
    expect(html).not.toContain("Supermemory");
    expect(html).not.toContain("Memory unavailable");
  });
});
