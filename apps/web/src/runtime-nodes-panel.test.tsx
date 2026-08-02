import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RuntimeNodesPanel } from "./runtime-nodes-panel.js";

describe("RuntimeNodesPanel", () => {
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
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Enroll node<\/button>/);
  });

  it("unlocks invitation creation after AI Inference is healthy", () => {
    const html = renderToStaticMarkup(<RuntimeNodesPanel
      targetEnvironment="DEVELOPMENT"
      inferenceReady
      onConfigureInference={vi.fn()}
      onUnauthorized={vi.fn()}
    />);

    expect(html).toContain("No Hermes runtime node enrolled");
    expect(html).toContain("Enroll the first node");
    expect(html).not.toContain("AI Inference must be ready first");
  });
});
