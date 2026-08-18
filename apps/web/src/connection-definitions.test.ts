import { describe, expect, it } from "vitest";
import { connectionDefinitions, inferenceEndpointPresets } from "./connection-definitions.js";

describe("inference server connection definition", () => {
  it("keeps installer-managed Agentic System services out of manual connector setup", () => {
    expect(connectionDefinitions.map(({ kind }) => kind)).toEqual(["INFERENCE"]);
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

  it("offers no OIDC form, because federated sign-in was removed", () => {
    /*
     * Inverted rather than deleted, and for the reason `front-page.test.tsx`
     * inverted its SSO-button case: this is where a reintroduced form would
     * appear by accident. The federated login path is gone, so a screen that
     * still collected an issuer, a client secret and a `platformAdminGroups`
     * list -- under help text promising its members "the complete OrcaSynapse
     * administrator scope set" -- was inviting an operator to configure an
     * access route that could never grant anyone anything.
     */
    expect(connectionDefinitions.find(({ kind }) => kind === "OIDC")).toBeUndefined();
  });
});
