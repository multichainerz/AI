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
  "prompts",
] as const;

describe("workspace navigation", () => {
  it("puts Settings last in the one primary navigation menu", () => {
    /*
     * Settings used to sit in a `"bottom"` group so an auto margin could pin
     * it to the foot of the rail, which left a gap above it and made it look
     * like a second menu. It is the last row of the same list as Operations.
     */
    expect(primaryNavigationGroups.flatMap((group) => group.items).map((item) => item.area)).toEqual([
      "Dashboard",
      "Session",
      // Directly after Session: Files is what conversing produces, so it
      // lives in the "use the product" group, not among the governance areas.
      "Files",
      "Agents",
      "Gateway",
      "Operations",
      "Settings",
    ]);
    expect(primaryNavigationItems("top").map((item) => item.area)).toEqual([
      "Dashboard",
      "Session",
      "Files",
      "Agents",
      "Gateway",
      "Operations",
      "Settings",
    ]);
    expect(primaryNavigationItems("bottom")).toEqual([]);

    expect(primaryNavigationItems("top").at(-1)?.target).toBe("Deployment");
    expect(productAreaForView("Deployment")).toBe("Settings");

    for (const item of primaryNavigationItems("top")) {
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
      Files: "Documents your agents produced",
      Agents: "Profiles, skills, memory and tools",
      Gateway: "Models, guardrails and usage for the governed inference path",
      Operations: "Health, agent runs and the audit trail",
      Settings: "Setup, access and system updates",
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
    expect(pathForView("Guardrails")).toBe("#gateway/guardrails");

    // Two moves have now passed over these screens. A bookmark from either
    // era still resolves -- the Platform spelling, the Settings spelling, and
    // the short alias. Prompts hashes land on Models: that tab is gone, and
    // falling through to the Dashboard would drop the operator out of Gateway.
    expect(viewFromHash("#settings/models")).toBe("Models");
    expect(viewFromHash("#platform/models")).toBe("Models");
    expect(viewFromHash("#gateway/prompts")).toBe("Models");
    expect(viewFromHash("#settings/prompts")).toBe("Models");
    expect(viewFromHash("#prompts")).toBe("Models");
    expect(viewFromHash("#settings/guardrails")).toBe("Guardrails");
    expect(viewFromHash("#guardrails")).toBe("Guardrails");

    // The bare area lands on its first tab, as `#settings` lands on Setup.
    expect(viewFromHash("#gateway")).toBe("Models");
  });

  it("addresses the usage tab and keeps it inside Gateway", () => {
    /*
     * Added at v8.9.0, so there is no retired spelling to preserve -- what this
     * pins is that the generated path, the router and the area map agree. The
     * three are edited in three separate places in one file, and the failure
     * mode of getting one wrong is a tab that draws but whose address bar
     * disagrees with it, or a bookmark that silently lands on the Dashboard.
     */
    expect(pathForView("Usage")).toBe("#gateway/usage");
    expect(viewFromHash("#gateway/usage")).toBe("Usage");
    expect(viewFromHash("#usage")).toBe("Usage");
    expect(productAreaForView("Usage")).toBe("Gateway");
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
     * the run counters and the execution ledger. Profiles kept the switch;
     * the ledger and run inspection live under Operations → Agent runs.
     *
     * The assertion is the order and the labels, because the tab strip is the
     * only place this structure is visible.
     */
    expect(sectionNavigationFor("Agents")).toEqual([
      { label: "Profiles", view: "Agents", icon: "profiles" },
      { label: "Skills", view: "Skills", icon: "skills" },
      { label: "Memory", view: "Memory", icon: "memory" },
      { label: "Tools", view: "Integrations", icon: "tools" },
    ]);
    expect(sectionNavigationFor("Dashboard")).toEqual([]);
  });

  it("gives every section tab an icon key", () => {
    for (const area of ["Agents", "Gateway", "Operations", "Settings"] as const) {
      const tabs = sectionNavigationFor(area);
      expect(tabs.length, `${area} has no tabs`).toBeGreaterThan(0);
      for (const tab of tabs) {
        expect(tab.icon, `${area}/${tab.label} has no icon`).toMatch(/^[a-z]+$/);
      }
    }
  });

  it("keeps the retired Runtime address pointing at the tab that absorbed the ledger", () => {
    /*
     * `#agents/runtime` addressed a screen that first folded into Profiles and
     * then split: the kill switch stayed on Profiles, the execution ledger
     * moved to Operations → Agent runs. A bookmark to it therefore has a
     * correct destination, and letting it fall through to the default would
     * drop the operator out of reporting entirely -- the same reasoning
     * `#agents/corpus` is kept alive by.
     */
    expect(pathForView("Agents")).toBe("#agents/profiles");
    expect(pathForView("Skills")).toBe("#agents/skills");
    expect(pathForView("Memory")).toBe("#agents/memory");
    expect(pathForView("Integrations")).toBe("#agents/tools");
    expect(pathForView("AgentRuns")).toBe("#operations/runs");

    expect(viewFromHash("#agents/runtime")).toBe("AgentRuns");
    expect(viewFromHash("#runtime")).toBe("AgentRuns");
    expect(viewFromHash("#operations/runs")).toBe("AgentRuns");
    expect(viewFromHash("#operations/agent-runs")).toBe("AgentRuns");
    expect(viewFromHash("#runs")).toBe("AgentRuns");
    expect(viewFromHash("#agent-runs")).toBe("AgentRuns");
    expect(viewFromHash("#agents/profiles")).toBe("Agents");
    expect(viewFromHash("#agents/skills")).toBe("Skills");
    expect(viewFromHash("#agents/memory")).toBe("Memory");

    for (const view of ["Agents", "Skills", "Memory"] as const) {
      expect(productAreaForView(view)).toBe("Agents");
    }
    expect(productAreaForView("AgentRuns")).toBe("Operations");
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
      { label: "Setup", view: "Deployment", icon: "setup" },
      { label: "Access", view: "People", icon: "access" },
      { label: "System", view: "Application", icon: "system" },
    ]);
    // What Settings is left holding is what it was always really about:
    // bringing the deployment up, and keeping the machine it runs on current.
    expect(sectionNavigationFor("Gateway")).toEqual([
      { label: "Models", view: "Models", icon: "models" },
      { label: "Guardrails", view: "Guardrails", icon: "guardrails" },
      { label: "Usage", view: "Usage", icon: "usage" },
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

  it("gives Operations three tabs after both evidence surfaces were removed", () => {
    /*
     * This area was one tab called "Health & evidence" holding four sub-tabs.
     * Release gates went with the evaluation subsystem it governed; Pilot
     * readiness was deleted rather than moved, because `ProductionReadinessControl`
     * has no create route and no seed anywhere in the repository, so the screen
     * could never show a row. Agent runs is the reporting surface that used to
     * sit on Profiles beside the kill switch.
     *
     * Nothing pinned this list, so reviving either retired tab -- or renaming
     * "Audit trail" back to something the area no longer has -- was a change
     * every test agreed with. It is the same literal assertion Agents and
     * Settings already carry, for the same reason: a tab strip is the only
     * place this structure is visible.
     */
    expect(sectionNavigationFor("Operations")).toEqual([
      { label: "Health", view: "Operations", icon: "health" },
      { label: "Agent runs", view: "AgentRuns", icon: "runs" },
      { label: "Audit trail", view: "Audit", icon: "audit" },
    ]);

    expect(pathForView("Operations")).toBe("#operations/health");
    expect(pathForView("AgentRuns")).toBe("#operations/runs");
    expect(pathForView("Audit")).toBe("#operations/audit");
    for (const view of ["Operations", "AgentRuns", "Audit"] as const) {
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
    expect(viewFromHash("#platform/prompts")).toBe("Models");
    expect(viewFromHash("#platform/guardrails")).toBe("Guardrails");
  });

  it("keeps a bookmarked divisions link pointing at the screen that holds divisions", () => {
    /*
     * Divisions was a Settings tab of its own until v8.9.0, when it and People
     * became one screen -- the same job, split across two tabs that already
     * read each other's data. Both of its addresses stay as cases rather than
     * becoming dead links.
     *
     * This is the assertion whose absence is the failure mode. Deleting the two
     * `#…divisions` cases compiles, and every other test in this file passes,
     * while every saved link silently redirects to the Dashboard -- exactly
     * what happened to the Release gates hashes, which were added by the
     * release that removed them and asserted by nothing for two releases after.
     */
    expect(viewFromHash("#settings/divisions")).toBe("People");
    expect(viewFromHash("#divisions")).toBe("People");

    // The hash follows the label the way Setup and System already do; the
    // routing token stays `People`. Old People and Divisions spellings stay
    // as aliases so a bookmark cannot silently redirect to the Dashboard.
    expect(pathForView("People")).toBe("#settings/access");
    expect(viewFromHash("#settings/access")).toBe("People");
    expect(viewFromHash("#access")).toBe("People");
    expect(viewFromHash("#settings/people")).toBe("People");
    expect(viewFromHash("#people")).toBe("People");
    expect(productAreaForView("People")).toBe("Settings");
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
