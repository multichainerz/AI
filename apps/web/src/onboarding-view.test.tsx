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
  onOpenOperations: vi.fn(),
  onRuntimeNodesChange: vi.fn(),
  onSignIn: vi.fn(),
  onUnauthorized: vi.fn(),
};

const runtimeState = {
  agentRuntime: null,
  profiles: [],
  runtimeNodes: [],
};

describe("OnboardingView", () => {
  it("uses the installer-provisioned local account as the routine pre-session gate", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[]}
      unlocked={false}
      oidcConfigured={false}
      {...runtimeState}
      {...callbacks}
    />);

    expect(html).toContain("Sign in to this OrcaSynapse installation");
    expect(html).toContain("for recovery only");
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
      {...runtimeState}
      {...callbacks}
    />);

    expect(html).toContain("Three layers. One usable AI workspace.");
    expect(html).toContain("AI Inference");
    expect(html).toContain("Agentic System");
    expect(html).toContain("Enterprise Access");
    expect(html).toContain("Open Knowledge");
    expect(html).toContain("Installation recovery");
    expect(html).not.toContain("Guided journey");
  });

  it("keeps workspace launch actions disabled until their required services are healthy", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[]}
      unlocked
      oidcConfigured={false}
      {...runtimeState}
      {...callbacks}
    />);

    expect(html).toContain("Set up inference first");
    expect(html).toContain("Enroll Agentic System first");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Enroll Agentic System first<\/button>/);
  });

  it("opens Agentic System configuration on the VM2 installer rather than connector fields", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[connection("INFERENCE", "http://vllm.internal:8000")]}
      unlocked
      oidcConfigured={false}
      initialTab="nodes"
      {...runtimeState}
      {...callbacks}
    />);

    expect(html).toContain("Agentic System");
    expect(html).toContain("Generate VM2 installer");
    expect(html).not.toContain("Connect Hermes");
    expect(html).not.toContain("Operational settings");
  });

  it("can enter advanced Hermes readiness directly from another workspace", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[
        connection("INFERENCE", "http://vllm.internal:8000"),
        connection("HERMES", "http://hermes.internal:8642"),
        connection("SUPERMEMORY", "http://supermemory.internal:6767"),
      ]}
      unlocked
      oidcConfigured={false}
      initialTab="readiness"
      {...runtimeState}
      {...callbacks}
    />);

    expect(html).toContain("Three layers. One usable AI workspace.");
  });

  it("offers the architecture decision the topology gate depends on", () => {
    // Validation's system-topology stage passes only when a rationale exists,
    // and this control is the only thing that can write one.
    const html = renderToStaticMarkup(<OnboardingView
      connections={[connection("INFERENCE", "http://vllm.internal:8000")]}
      unlocked
      oidcConfigured={false}
      {...runtimeState}
      {...callbacks}
    />);

    expect(html).toContain("Architecture decision");
    expect(html).toContain("Topology and target environment");
    expect(html).toContain("Validation cannot pass the system stage until this decision exists");
  });

  it("offers an activation control that states what still blocks it", () => {
    const html = renderToStaticMarkup(<OnboardingView
      connections={[connection("INFERENCE", "http://vllm.internal:8000")]}
      unlocked
      oidcConfigured={false}
      {...runtimeState}
      {...callbacks}
    />);

    expect(html).toContain("Activation");
    expect(html).toContain("Activate installation");
    // Without a loaded snapshot the control must not present itself as ready.
    expect(html).toContain("disabled");
  });
});
