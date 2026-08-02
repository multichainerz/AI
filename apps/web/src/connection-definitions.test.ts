import { describe, expect, it } from "vitest";
import { connectionDefinitions, inferenceEndpointPresets } from "./connection-definitions.js";

describe("inference server connection definition", () => {
  it("offers concrete backends plus a future-compatible OpenAI endpoint", () => {
    const definition = connectionDefinitions.find(({ kind }) => kind === "INFERENCE");
    expect(definition?.name).toBe("AI Inference");

    const backend = definition?.configurationFields.find(({ name }) => name === "inferenceBackend");
    expect(backend?.defaultValue).toBe("CUSTOM_OPENAI_COMPATIBLE");
    expect(backend?.options?.map(({ value }) => value)).toEqual([
      "VLLM",
      "LLAMA_CPP",
      "SGLANG",
      "OLLAMA",
      "TGI",
      "CUSTOM_OPENAI_COMPATIBLE",
    ]);
    expect(inferenceEndpointPresets).toHaveLength(6);
    expect(inferenceEndpointPresets.find(({ backend: value }) => value === "LLAMA_CPP")).toMatchObject({
      defaultPort: 8080,
      endpointPlaceholder: "http://gpu-server.internal:8080",
    });
    expect(inferenceEndpointPresets.every(({ endpointOptions }) => endpointOptions.length > 0)).toBe(true);
  });

  it("presents enterprise identity without claiming tenant isolation", () => {
    const definition = connectionDefinitions.find(({ kind }) => kind === "OIDC");
    expect(definition?.name).toBe("Enterprise Access");
    expect(definition?.role).toContain("role-based access");
    expect(definition?.name).not.toContain("Multitenancy");
  });
});
