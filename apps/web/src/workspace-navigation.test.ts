import { describe, expect, it } from "vitest";
import { pathForView, productAreaForView, viewFromHash } from "./workspace-navigation.js";

describe("workspace navigation", () => {
  it("falls retired and unknown deep links back to the dashboard", () => {
    expect(viewFromHash("#removed-surface")).toBe("Overview");
    expect(viewFromHash("#integrations")).toBe("Integrations");
    expect(viewFromHash("#platform/guardrails")).toBe("Guardrails");
  });

  it("maps every internal screen to one product area", () => {
    expect(productAreaForView("Integrations")).toBe("Agents");
    expect(productAreaForView("Models")).toBe("Settings");
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

  it("moves Platform into Settings without breaking saved links", () => {
    expect(pathForView("Deployment")).toBe("#settings/setup");
    expect(pathForView("Models")).toBe("#settings/models");
    expect(viewFromHash("#settings/guardrails")).toBe("Guardrails");
    expect(viewFromHash("#platform/setup")).toBe("Deployment");
    expect(viewFromHash("#platform/models")).toBe("Models");
  });

  it("names the areas the way the product does", () => {
    // The `ActiveView` tokens deliberately did not follow the rename; these two
    // assertions are what stops someone "finishing the job" and churning every
    // view module, fixture and CSS class for no reader's benefit.
    expect(productAreaForView("Overview")).toBe("Dashboard");
    expect(productAreaForView("Chat")).toBe("Session");
  });

});
