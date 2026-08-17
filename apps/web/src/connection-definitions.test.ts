import { describe, expect, it } from "vitest";
import { connectionDefinitions, inferenceEndpointPresets } from "./connection-definitions.js";

describe("inference server connection definition", () => {
  it("keeps installer-managed Agentic System services out of manual connector setup", () => {
    expect(connectionDefinitions.map(({ kind }) => kind)).toEqual(["INFERENCE", "OIDC"]);
  });

  it("does not expose a manual inference configuration form", () => {
    const definition = connectionDefinitions.find(({ kind }) => kind === "INFERENCE");
    expect(definition?.name).toBe("AI Inference");
    expect(definition?.configurationFields).toEqual([]);
    expect(inferenceEndpointPresets.map(({ backend }) => backend)).toEqual([
      "VLLM",
      "LLAMA_CPP",
      "SGLANG",
      "OLLAMA",
      "TGI",
      "CUSTOM_OPENAI_COMPATIBLE",
    ]);
  });

  it("presents enterprise identity without claiming tenant isolation", () => {
    const definition = connectionDefinitions.find(({ kind }) => kind === "OIDC");
    expect(definition?.name).toBe("Enterprise Access");
    expect(definition?.role).toContain("role-based access");
    expect(definition?.name).not.toContain("Multitenancy");
  });
});
