import { describe, expect, it } from "vitest";
import type { SetupStepKey } from "./setup-steps.js";
import {
  pathForView,
  primaryNavigationGroups,
  primaryNavigationItems,
  productAreaForView,
  sectionNavigationFor,
  setupStepFromHash,
  viewFromHash,
} from "./workspace-navigation.js";

describe("workspace navigation", () => {
  it("puts Settings last in the one primary navigation menu", () => {
    /*
     * Settings used to be excluded from these groups so the rail could anchor
     * it by hand at the bottom. That made its row a second, hand-maintained
     * copy of a nav row -- drawn twice in `app.tsx`, styled edge-to-edge, and
     * claiming the active-item ref alongside the copy it duplicated. "Last, at
     * the bottom" is a property of the menu now: the group says where it sits,
     * and one renderer draws every row in it.
     */
    expect(primaryNavigationGroups.flatMap((group) => group.items).map((item) => item.area)).toEqual([
      "Dashboard",
      "Session",
      "Agents",
      "Operations",
      "Settings",
    ]);
    expect(primaryNavigationItems("top").map((item) => item.area)).toEqual([
      "Dashboard",
      "Session",
      "Agents",
      "Operations",
    ]);
    expect(primaryNavigationItems("bottom").map((item) => item.area)).toEqual(["Settings"]);

    // Same row, same destination: the anchored button opened Setup, and so
    // does the menu entry that replaced it.
    expect(primaryNavigationItems("bottom")[0]?.target).toBe("Deployment");
    expect(productAreaForView("Deployment")).toBe("Settings");

    // Every entry the shared renderer receives has the two things a row draws:
    // a glyph and the tooltip that carries its description.
    for (const item of primaryNavigationItems("top").concat(primaryNavigationItems("bottom"))) {
      expect(item.icon).toBeTruthy();
      expect(item.description).toBeTruthy();
    }
  });

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

  it("gives Agents five tabs, one job each", () => {
    /*
     * Three tabs did two jobs each. "Profiles & runs" put an immutable
     * configuration list and a live execution ledger behind one label, and
     * "Hermes corpus" named a storage mechanism rather than either of the two
     * things stored in it. Splitting them is the point of this model; the
     * assertion is the order and the labels, because the tab strip is the only
     * place the split is visible.
     */
    expect(sectionNavigationFor("Agents")).toEqual([
      { label: "Profiles", view: "Agents" },
      { label: "Runtime", view: "Runtime" },
      { label: "Skills", view: "Skills" },
      { label: "Memory", view: "Memory" },
      { label: "Agent Tools", view: "Integrations" },
    ]);
    expect(sectionNavigationFor("Dashboard")).toEqual([]);
  });

  it("routes each half of a split tab to its own address", () => {
    expect(pathForView("Agents")).toBe("#agents/profiles");
    expect(pathForView("Runtime")).toBe("#agents/runtime");
    expect(pathForView("Skills")).toBe("#agents/skills");
    expect(pathForView("Memory")).toBe("#agents/memory");
    expect(pathForView("Integrations")).toBe("#agents/tools");

    expect(viewFromHash("#agents/runtime")).toBe("Runtime");
    expect(viewFromHash("#agents/skills")).toBe("Skills");
    expect(viewFromHash("#agents/memory")).toBe("Memory");

    for (const view of ["Runtime", "Skills", "Memory"] as const) {
      expect(productAreaForView(view)).toBe("Agents");
    }
  });

  it("gives every Setup step an address that round-trips", () => {
    /*
     * The step used to be `deploymentInitialTab` in `app.tsx` — a value the
     * address bar knew nothing about. Back from the nodes panel therefore left
     * Settings entirely, and reloading part-way through a twenty-minute VM2
     * install returned to the overview.
     *
     * Walked over the whole key set rather than the two anyone happened to
     * type: `viewFromHash` lists the step routes as literal cases and
     * `setupStepFromHash` parses them, so a fourth step added to one and not
     * the other has to fail here.
     */
    const keys: SetupStepKey[] = ["inference", "runtime", "profile"];
    for (const key of keys) {
      const path = pathForView("Deployment", key);
      expect(path).toBe(`#settings/setup/${key}`);
      expect(viewFromHash(path), `${path} does not resolve to Setup`).toBe("Deployment");
      expect(setupStepFromHash(path)).toBe(key);
    }

    // No step named is not an error; it is the overview.
    expect(pathForView("Deployment")).toBe("#settings/setup");
    expect(setupStepFromHash("#settings/setup")).toBeNull();
    expect(setupStepFromHash("#settings/setup/invented")).toBeNull();
    expect(setupStepFromHash("#dashboard")).toBeNull();
  });

  it("gives the update check its own tab rather than a slot inside setup", () => {
    expect(sectionNavigationFor("Settings")).toEqual([
      { label: "Setup", view: "Deployment" },
      { label: "Models", view: "Models" },
      { label: "Prompts", view: "Prompts" },
      { label: "Guardrails", view: "Guardrails" },
      { label: "Application", view: "Application" },
    ]);
    expect(pathForView("Application")).toBe("#settings/application");
    expect(viewFromHash("#settings/application")).toBe("Application");
    expect(viewFromHash("#application")).toBe("Application");
    expect(productAreaForView("Application")).toBe("Settings");
  });

  it("keeps a bookmarked corpus link pointing at a real screen", () => {
    /*
     * `#agents/corpus` and `#corpus` addressed one screen that no longer
     * exists. Falling through to Overview would be a silent redirect off the
     * area entirely; Skills is where the majority of that screen's content
     * went, so that is where the old link lands.
     */
    expect(viewFromHash("#agents/corpus")).toBe("Skills");
    expect(viewFromHash("#corpus")).toBe("Skills");
    expect(viewFromHash("#agents")).toBe("Agents");
    expect(viewFromHash("#agents/tools")).toBe("Integrations");
  });
});
