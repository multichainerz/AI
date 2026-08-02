import type { ServiceConnectionSummary, ServiceKind } from "@orcasynapse/contracts";
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
  it("uses the installer-provisioned local account as the routine pre-session gate", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[]}
      unlocked={false}
      oidcConfigured={false}
      {...callbacks}
    />);

    expect(html).toContain("Sign in to this OrcaSynapse installation");
    expect(html).toContain("account recovery only");
    expect(html).not.toContain("Development quick start");
  });

  it("opens on the lean development path once the installation is claimed", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[
        connection("INFERENCE", "http://vllm.internal:8000"),
        connection("SUPERMEMORY", "http://supermemory.internal:6767"),
      ]}
      unlocked
      oidcConfigured={false}
      {...callbacks}
    />);

    expect(html).toContain("Development quick start");
    expect(html).toContain("Start chatting");
    expect(html).toContain("Open documents");
    expect(html).toContain("AI Inference, Agentic System, Enterprise Access");
    expect(html).toContain("Hermes execution with durable Supermemory");
    expect(html).toContain("tenant data isolation remains a planned phase");
    expect(html).toContain("Enroll runtime");
    expect(html).toContain("Enterprise model serving for Chat and governed agents");
    expect(html).not.toContain("Guided journey");
  });

  it("keeps workspace launch actions disabled until their required services are healthy", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[]}
      unlocked
      oidcConfigured={false}
      {...callbacks}
    />);

    expect(html).toContain("Set up AI Inference first");
    expect(html).toContain("Enroll Agentic System first");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Set up AI Inference first<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Enroll Agentic System first<\/button>/);
  });
});
