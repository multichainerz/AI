import { describe, expect, it } from "vitest";
import { pathForView, productAreaForView, viewFromHash } from "./workspace-navigation.js";

describe("workspace navigation", () => {
  it("keeps old deep links valid while emitting the cohesive routes", () => {
    expect(viewFromHash("#documents")).toBe("Documents");
    expect(viewFromHash("#memory")).toBe("Documents");
    expect(viewFromHash("#integrations")).toBe("Integrations");
    expect(viewFromHash("#platform/guardrails")).toBe("Guardrails");
    expect(pathForView("Documents")).toBe("#knowledge/documents");
  });

  it("maps every internal screen to one product area", () => {
    expect(productAreaForView("Documents")).toBe("Knowledge");
    expect(productAreaForView("Integrations")).toBe("Agents");
    expect(productAreaForView("Models")).toBe("Platform");
  });

  it("files benchmarks beside the ledger they produce evidence for", () => {
    expect(productAreaForView("Benchmarks")).toBe("Operations");
    expect(pathForView("Benchmarks")).toBe("#operations/benchmarks");
    expect(viewFromHash("#operations/benchmarks")).toBe("Benchmarks");
    expect(viewFromHash("#benchmarks")).toBe("Benchmarks");
  });
});
