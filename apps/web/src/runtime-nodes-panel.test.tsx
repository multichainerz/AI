import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RuntimeNodesPanel, agenticNodeInstallCommand } from "./runtime-nodes-panel.js";

describe("RuntimeNodesPanel", () => {
  it("builds one canonical Agentic System command from origins with or without a trailing slash", () => {
    const expected = "curl -fsSL https://orcasynapse.internal/install/agentic-node.sh | sudo bash -s -- --connect https://orcasynapse.internal";
    expect(agenticNodeInstallCommand("https://orcasynapse.internal")).toBe(expected);
    expect(agenticNodeInstallCommand("https://orcasynapse.internal/")).toBe(expected);
    expect(expected).not.toContain("hermes-node.sh");
  });

  it("keeps VM2 enrollment and installer guidance hidden until AI Inference is ready", () => {
    const html = renderToStaticMarkup(<RuntimeNodesPanel
      targetEnvironment="DEVELOPMENT"
      inferenceReady={false}
      onConfigureInference={vi.fn()}
      onUnauthorized={vi.fn()}
    />);

    expect(html).toContain("AI Inference must be ready first");
    expect(html).toContain("Configure AI Inference");
    expect(html).not.toContain("Run one command on VM2");
    expect(html).not.toContain("Issue one-time invitation");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Generate installer<\/button>/);
  });

  it("unlocks invitation creation after AI Inference is healthy", () => {
    const html = renderToStaticMarkup(<RuntimeNodesPanel
      targetEnvironment="DEVELOPMENT"
      inferenceReady
      onConfigureInference={vi.fn()}
      onUnauthorized={vi.fn()}
    />);

    expect(html).toContain("Install the Agentic System on VM2");
    expect(html).toContain("Generate VM2 installer");
    expect(html).not.toContain("AI Inference must be ready first");
  });
});
