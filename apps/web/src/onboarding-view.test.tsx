import type { ServiceConnectionSummary, ServiceKind } from "@aihub/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OnboardingView } from "./onboarding-view.js";

function connection(kind: ServiceKind, baseUrl: string): ServiceConnectionSummary {
  return {
    kind,
    baseUrl,
    enabled: true,
    status: "HEALTHY",
  } as ServiceConnectionSummary;
}

const callbacks = {
  onConfigure: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onSignIn: vi.fn(),
  onUnauthorized: vi.fn(),
};

describe("OnboardingView", () => {
  it("keeps the Installation Key as the only pre-session gate", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[]}
      unlocked={false}
      oidcConfigured={false}
      {...callbacks}
    />);

    expect(html).toContain("Unlock this AIHub installation");
    expect(html).not.toContain("Development quick start");
  });

  it("opens on the lean development path once the installation is claimed", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[
        connection("VLLM", "http://vllm.internal:8000"),
        connection("SUPERMEMORY", "http://supermemory.internal:6767"),
      ]}
      unlocked
      oidcConfigured={false}
      {...callbacks}
    />);

    expect(html).toContain("Development quick start");
    expect(html).toContain("Start chatting");
    expect(html).toContain("Open documents");
    expect(html).toContain("Isolated agent runtime for the full AIHub experience");
    expect(html).toContain("Enroll runtime");
    expect(html).toContain("The on-prem model endpoint used by AIHub and Hermes");
    expect(html).not.toContain("Guided journey");
  });

  it("keeps workspace launch actions disabled until their required services are healthy", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[]}
      unlocked
      oidcConfigured={false}
      {...callbacks}
    />);

    expect(html).toContain("Connect vLLM first");
    expect(html).toContain("Connect Supermemory first");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect vLLM first<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect Supermemory first<\/button>/);
  });
});
