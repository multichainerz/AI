/**
 * @vitest-environment jsdom
 *
 * Most cases here render to static markup, which never runs an effect. The
 * recovery-owner case has to: the defect it holds down only exists once the
 * snapshot effect has run more than once.
 */
import type { OnboardingSnapshot, ServiceConnectionSummary, ServiceKind } from "@orcasynapse/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const snapshot = vi.hoisted(() => ({
  generatedAt: "2026-08-07T00:00:00.000Z",
  installation: {},
  architecture: { topologyMode: "COMPACT", targetEnvironment: "DEVELOPMENT", reason: null, revision: 1 },
  recovery: { recoveryOwner: "Platform owner", revision: 3 },
  journey: { status: "IN_PROGRESS", activatedEnvironment: null, revision: 2 },
  components: [],
  steps: [],
  evidence: [],
  gate: { ready: false, blockers: [], warnings: [] },
} as unknown as OnboardingSnapshot));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, getOnboardingSnapshot: vi.fn(async () => snapshot) };
});

const { OnboardingView } = await import("./onboarding-view.js");

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
  onSessionExpired: vi.fn(),
};

const runtimeState = {
  agentRuntime: null,
  profiles: [],
  runtimeNodes: [],
};

afterEach(cleanup);

describe("OnboardingView", () => {
  it("keeps the recovery owner an operator is typing when the parent re-renders", async () => {
    // App polls and passes a fresh `onSessionExpired` arrow every few seconds.
    // With that identity in the snapshot effect's dependencies the effect
    // re-runs and writes the stored owner back over the field, so a name being
    // typed into the recovery kit form vanishes mid-entry. The sibling effect
    // above it already carries an eslint-disable for exactly this.
    const user = userEvent.setup();
    const props = {
      connections: [connection("INFERENCE", "http://vllm.internal:8000")],
      unlocked: true,
      oidcConfigured: false,
      ...runtimeState,
      ...callbacks,
    };
    const { rerender } = render(<OnboardingView {...props} onSessionExpired={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Installation recovery" }));
    const owner = await screen.findByLabelText("Recovery owner");
    await user.clear(owner);
    await user.type(owner, "Infrastructure recovery team");

    rerender(<OnboardingView {...props} onSessionExpired={() => undefined} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect((owner as HTMLInputElement).value).toBe("Infrastructure recovery team");
  });

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
    expect(html).toContain("Finish the Agentic System");
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

    // Chat runs on VM2, so it stays gated on the inference route that feeds it.
    expect(html).toContain("Set up inference first");
    expect(html).toContain("Governed Chat");
    expect(html).not.toContain("Enroll Agentic System first");
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
