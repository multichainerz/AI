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

  it("renames the two areas without stranding their old links", () => {
    /*
     * Home became Dashboard and Chat became Session. The routes followed, which
     * is what keeps the address bar from contradicting the navigation -- but a
     * rename that drops the old hash turns every existing bookmark into a
     * silent redirect to Overview, which for `#chat` would mean landing on the
     * wrong screen with no error.
     */
    expect(pathForView("Overview")).toBe("#dashboard");
    expect(pathForView("Chat")).toBe("#session");
    expect(viewFromHash("#session")).toBe("Chat");
    expect(viewFromHash("#chat")).toBe("Chat");
    // `#home` has no case of its own and never did: an unknown hash falls
    // through to Overview, which is exactly where it used to go.
    expect(viewFromHash("#home")).toBe("Overview");
    expect(viewFromHash("#dashboard")).toBe("Overview");
  });

  it("names the areas the way the product does", () => {
    // The `ActiveView` tokens deliberately did not follow the rename; these two
    // assertions are what stops someone "finishing the job" and churning every
    // view module, fixture and CSS class for no reader's benefit.
    expect(productAreaForView("Overview")).toBe("Dashboard");
    expect(productAreaForView("Chat")).toBe("Session");
  });

  it("files benchmarks beside the ledger they produce evidence for", () => {
    expect(productAreaForView("Benchmarks")).toBe("Operations");
    expect(pathForView("Benchmarks")).toBe("#operations/benchmarks");
    expect(viewFromHash("#operations/benchmarks")).toBe("Benchmarks");
    expect(viewFromHash("#benchmarks")).toBe("Benchmarks");
  });
});
