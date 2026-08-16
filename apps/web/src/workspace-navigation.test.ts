import { describe, expect, it } from "vitest";
import type { SetupStepKey } from "./setup-steps.js";
import {
  type ProductArea,
  pathForView,
  primaryNavigationGroups,
  primaryNavigationItems,
  productAreaForView,
  sectionNavigationFor,
  setupStepFromHash,
  viewFromHash,
} from "./workspace-navigation.js";

/**
 * Surfaces this product used to have and no longer does.
 *
 * A deleted screen leaves its name behind in the copy that describes it, and
 * that copy is the last place anyone looks: the rail's tooltips render nowhere
 * near the screens they name, so "Health, release gates and the audit trail"
 * outlived Release gates by a whole release with 409 tests green. Each entry
 * here was a real tab or area, and none of them may be named by navigation copy
 * again without this failing and someone deciding on purpose.
 */
const RETIRED_SURFACES = [
  "release gate",
  "evaluation",
  "benchmark",
  "pilot readiness",
  "evidence",
  "corpus",
  "runtime",
  "platform",
] as const;

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
      "Gateway",
      "Operations",
      "Settings",
    ]);
    expect(primaryNavigationItems("top").map((item) => item.area)).toEqual([
      "Dashboard",
      "Session",
      "Agents",
      "Gateway",
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

  it("says on the rail what each area actually contains", () => {
    /*
     * `toBeTruthy()` was the only assertion these descriptions ever had, and it
     * is true of every string anyone will ever write -- so Operations kept
     * advertising "Health, release gates and the audit trail" through the
     * release that deleted Release gates, and Settings described itself in
     * terms of an "Application setup" that is two different tabs. The rail's
     * tooltip is the one piece of navigation copy that renders nowhere near the
     * screen it describes, which is exactly why nothing caught either.
     *
     * Pinned three ways: the literal text, so changing it is a decision; the
     * tab labels, so an area cannot advertise less than it has; and the retired
     * vocabulary, so it cannot advertise more.
     */
    const described = Object.fromEntries(
      primaryNavigationGroups.flatMap((group) => group.items).map((item) => [item.area, item.description]),
    ) as Record<ProductArea, string>;

    expect(described).toEqual({
      Dashboard: "Activity, readiness and next actions",
      Session: "Governed conversations",
      Agents: "Profiles and runs, skills, memory and tools",
      Gateway: "Models, prompts and guardrails for the governed inference path",
      Operations: "Health, incidents and the audit trail",
      Settings: "Setup, divisions, people and system updates",
    });

    for (const [area, description] of Object.entries(described) as Array<[ProductArea, string]>) {
      // An area with a tab strip names every tab in it. Deleting a tab without
      // touching this copy leaves the rail promising a screen that is gone;
      // adding one without touching it leaves the rail hiding a screen that
      // exists.
      for (const tab of sectionNavigationFor(area)) {
        expect(description.toLowerCase(), `${area} does not mention its "${tab.label}" tab`)
          .toContain(tab.label.toLowerCase());
      }
      for (const retired of RETIRED_SURFACES) {
        expect(description.toLowerCase(), `${area} still advertises the retired "${retired}"`)
          .not.toContain(retired);
      }
    }

    // The tab labels themselves, for the same reason and against the same list.
    for (const area of Object.keys(described) as ProductArea[]) {
      for (const { label } of sectionNavigationFor(area)) {
        for (const retired of RETIRED_SURFACES) {
          expect(label.toLowerCase(), `${area} still has a "${label}" tab`).not.toContain(retired);
        }
      }
    }
  });

  it("falls retired and unknown deep links back to the dashboard", () => {
    expect(viewFromHash("#removed-surface")).toBe("Overview");
    expect(viewFromHash("#integrations")).toBe("Integrations");
    expect(viewFromHash("#platform/guardrails")).toBe("Guardrails");
  });

  it("maps every internal screen to one product area", () => {
    expect(productAreaForView("Integrations")).toBe("Agents");
    expect(productAreaForView("Models")).toBe("Gateway");
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
    expect(viewFromHash("#platform/setup")).toBe("Deployment");
    expect(viewFromHash("#platform/models")).toBe("Models");
  });

  it("moves the governed inference tabs into Gateway without stranding their old links", () => {
    // Generated paths follow the navigation, so the address bar cannot
    // contradict the rail.
    expect(pathForView("Models")).toBe("#gateway/models");
    expect(pathForView("Prompts")).toBe("#gateway/prompts");
    expect(pathForView("Guardrails")).toBe("#gateway/guardrails");

    // Two moves have now passed over these three screens. A bookmark from
    // either era still resolves -- the Platform spelling, the Settings
    // spelling, and the short alias.
    expect(viewFromHash("#settings/models")).toBe("Models");
    expect(viewFromHash("#platform/models")).toBe("Models");
    expect(viewFromHash("#settings/guardrails")).toBe("Guardrails");
    expect(viewFromHash("#guardrails")).toBe("Guardrails");

    // The bare area lands on its first tab, as `#settings` lands on Setup.
    expect(viewFromHash("#gateway")).toBe("Models");
  });

  it("names the areas the way the product does", () => {
    // The `ActiveView` tokens deliberately did not follow the rename; these two
    // assertions are what stops someone "finishing the job" and churning every
    // view module, fixture and CSS class for no reader's benefit.
    expect(productAreaForView("Overview")).toBe("Dashboard");
    expect(productAreaForView("Chat")).toBe("Session");
  });

  it("gives Agents four tabs, one job each", () => {
    /*
     * "Hermes corpus" named a storage mechanism rather than either of the two
     * unrelated things stored in it, so it became Skills and Memory. Runtime
     * went the other way: it was briefly a fifth tab holding the kill switch,
     * the run counters and the execution ledger, and that fragmented one
     * workflow -- define a Profile, watch what it does, decide whether it may
     * run -- across two screens whose only join was a cross-tab button. One
     * tab owns all three again.
     *
     * The assertion is the order and the labels, because the tab strip is the
     * only place this structure is visible.
     */
    expect(sectionNavigationFor("Agents")).toEqual([
      { label: "Profiles", view: "Agents" },
      { label: "Skills", view: "Skills" },
      { label: "Memory", view: "Memory" },
      { label: "Tools", view: "Integrations" },
    ]);
    expect(sectionNavigationFor("Dashboard")).toEqual([]);
  });

  it("keeps the retired Runtime address pointing at the tab that absorbed it", () => {
    /*
     * `#agents/runtime` addressed a screen that is now part of Profiles, and
     * every part of what it held moved there rather than being dropped. A
     * bookmark to it therefore has a correct destination, and letting it fall
     * through to the default would drop the operator out of the area entirely
     * -- the same reasoning `#agents/corpus` is kept alive by.
     */
    expect(pathForView("Agents")).toBe("#agents/profiles");
    expect(pathForView("Skills")).toBe("#agents/skills");
    expect(pathForView("Memory")).toBe("#agents/memory");
    expect(pathForView("Integrations")).toBe("#agents/tools");

    expect(viewFromHash("#agents/runtime")).toBe("Agents");
    expect(viewFromHash("#runtime")).toBe("Agents");
    expect(viewFromHash("#agents/profiles")).toBe("Agents");
    expect(viewFromHash("#agents/skills")).toBe("Skills");
    expect(viewFromHash("#agents/memory")).toBe("Memory");

    for (const view of ["Agents", "Skills", "Memory"] as const) {
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
      { label: "Divisions", view: "Divisions" },
      { label: "People", view: "People" },
      { label: "System", view: "Application" },
    ]);
    // What Settings is left holding is what it was always really about:
    // bringing the deployment up, and keeping the machine it runs on current.
    expect(sectionNavigationFor("Gateway")).toEqual([
      { label: "Models", view: "Models" },
      { label: "Prompts", view: "Prompts" },
      { label: "Guardrails", view: "Guardrails" },
    ]);
    // The hash follows the label and the routing token does not, the same way
    // `Deployment` is addressed as `#settings/setup` two lines above.
    expect(pathForView("Application")).toBe("#settings/system");
    expect(viewFromHash("#settings/system")).toBe("Application");
    expect(viewFromHash("#system")).toBe("Application");
    // Both spellings from when the tab was called Application still resolve.
    expect(viewFromHash("#settings/application")).toBe("Application");
    expect(viewFromHash("#application")).toBe("Application");
    expect(productAreaForView("Application")).toBe("Settings");
  });

  it("gives Operations two tabs after both evidence surfaces were removed", () => {
    /*
     * This area was one tab called "Health & evidence" holding four sub-tabs.
     * Release gates went with the evaluation subsystem it governed; Pilot
     * readiness was deleted rather than moved, because `ProductionReadinessControl`
     * has no create route and no seed anywhere in the repository, so the screen
     * could never show a row.
     *
     * Nothing pinned this list, so reviving either as a tab -- or renaming
     * "Audit trail" back to something the area no longer has -- was a change
     * every test agreed with. It is the same literal assertion Agents and
     * Settings already carry, for the same reason: a tab strip is the only
     * place this structure is visible.
     */
    expect(sectionNavigationFor("Operations")).toEqual([
      { label: "Health", view: "Operations" },
      { label: "Audit trail", view: "Audit" },
    ]);

    expect(pathForView("Operations")).toBe("#operations/health");
    expect(pathForView("Audit")).toBe("#operations/audit");
    for (const view of ["Operations", "Audit"] as const) {
      expect(productAreaForView(view)).toBe("Operations");
      expect(viewFromHash(pathForView(view))).toBe(view);
    }
  });

  it("lands every retired Operations bookmark on Health rather than the dashboard", () => {
    /*
     * `#operations` addressed the whole area when it was one screen with four
     * sub-tabs, and `#operations/releases`, `#operations/evaluations` and
     * `#releases` addressed the one that is gone. Health is the surface that
     * absorbed what Operations still does, so that is where an old link goes.
     *
     * These cases were added by the release that removed Release gates and
     * asserted by nothing: deleting all three left the suite green while every
     * saved link silently redirected out of the area to the Dashboard.
     */
    for (const hash of ["#operations", "#operations/health", "#health", "#operations/releases", "#operations/evaluations", "#releases"]) {
      expect(viewFromHash(hash), `${hash} no longer resolves to Health`).toBe("Operations");
    }
    expect(viewFromHash("#audit")).toBe("Audit");
  });

  it("keeps the address bar's own Memory link pointing at the tab that still has it", () => {
    /*
     * `#platform/memory` is the retired hash that mattered most and was the one
     * dropped. Up to v4.6.0 it was the address `pathForView` *generated* for
     * Memory -- the spelling that is in address bars and bookmarks -- while
     * `#memory`, which survived the move into Settings, was only ever the short
     * alias. Memory is still a screen, at `#agents/memory`, so falling the old
     * link through to the Dashboard dropped the operator out of the area for no
     * reason the other `#platform/...` hashes were spared.
     */
    expect(viewFromHash("#platform/memory")).toBe("Memory");
    expect(viewFromHash("#memory")).toBe("Memory");
    expect(viewFromHash("#agents/memory")).toBe("Memory");
    expect(pathForView("Memory")).toBe("#agents/memory");
    expect(productAreaForView("Memory")).toBe("Agents");

    // Every other Platform-era address that survived the rename, so the set
    // stays symmetrical rather than being one screen short again.
    expect(viewFromHash("#platform")).toBe("Deployment");
    expect(viewFromHash("#platform/setup")).toBe("Deployment");
    expect(viewFromHash("#platform/models")).toBe("Models");
    expect(viewFromHash("#platform/prompts")).toBe("Prompts");
    expect(viewFromHash("#platform/guardrails")).toBe("Guardrails");
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
