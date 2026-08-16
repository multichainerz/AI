import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { SetupStepKey } from "./setup-steps.js";

export type ActiveView =
  | "Overview"
  | "Deployment"
  | "Application"
  | "Chat"
  | "Models"
  | "Prompts"
  | "Agents"
  | "Skills"
  | "Memory"
  | "Integrations"
  | "Guardrails"
  | "Operations"
  | "Audit";

/*
 * What the areas are called on screen. The `ActiveView` tokens above are
 * internal routing names and deliberately did not follow: renaming those would
 * churn every view module, test fixture and CSS class for no reader's benefit.
 */
export type ProductArea = "Dashboard" | "Session" | "Agents" | "Gateway" | "Settings" | "Operations";

export interface PrimaryNavigationItem {
  area: ProductArea;
  icon: string;
  target: ActiveView;
  description: string;
}

export interface SectionNavigationItem {
  label: string;
  view: ActiveView;
}

/**
 * Where in the rail a group's rows sit. Settings is the only thing that has
 * ever wanted `"bottom"`, and it used to get there by being excluded from this
 * model entirely and hand-written into the rail's footer -- which cost a
 * duplicated row, a second set of styles, and a phone-only third copy to put
 * it back in the menu at dock widths. Placement is a property of the group
 * now, so the same renderer draws every row and only the position differs.
 */
export type NavigationPlacement = "top" | "bottom";

export const primaryNavigationGroups: ReadonlyArray<{
  label: string;
  placement: NavigationPlacement;
  items: ReadonlyArray<PrimaryNavigationItem>;
}> = [
  {
    label: "Workspace",
    placement: "top",
    items: [
      { area: "Dashboard", icon: "overview", target: "Overview", description: "Activity, readiness and next actions" },
      { area: "Session", icon: "chat", target: "Chat", description: "Governed conversations" },
      { area: "Agents", icon: "agents", target: "Agents", description: "Profiles and runs, skills, memory and tools" },
    ],
  },
  {
    label: "Administration",
    placement: "top",
    items: [
      /*
       * Ahead of Operations: you configure the governed inference path, then you
       * watch it. The description must literally contain every tab label in this
       * area -- workspace-navigation.test.ts asserts exactly that, which is what
       * stops a tooltip drifting away from the tabs it summarises.
       */
      { area: "Gateway", icon: "gateway", target: "Models", description: "Models, prompts and guardrails for the governed inference path" },
      { area: "Operations", icon: "operations", target: "Operations", description: "Health, incidents and the audit trail" },
    ],
  },
  {
    label: "System",
    placement: "bottom",
    items: [
      { area: "Settings", icon: "settings", target: "Deployment", description: "Setup and system updates" },
    ],
  },
];

/*
 * These descriptions are the rail's tooltips, and they are the one piece of
 * navigation copy nothing renders on the screen it describes -- so a tab that
 * goes away leaves its name here. "Health, release gates and the audit trail"
 * survived the commit that deleted Release gates by a whole release, because
 * the only assertion touching a description was `toBeTruthy()`, which passes
 * for every string ever written. `workspace-navigation.test.ts` pins the text
 * against the tab lists below instead.
 */

/**
 * The rail's rows for one placement, in menu order. The rail draws the `"top"`
 * groups as a single unlabelled run and the `"bottom"` group last, so this is
 * the seam where "which areas" stays data and "how far down" becomes layout.
 */
export function primaryNavigationItems(placement: NavigationPlacement): ReadonlyArray<PrimaryNavigationItem> {
  return primaryNavigationGroups.filter((group) => group.placement === placement).flatMap((group) => group.items);
}

const sectionNavigation: Partial<Record<ProductArea, ReadonlyArray<SectionNavigationItem>>> = {
  /*
   * Four tabs, one job each. The order is the operator's sequence -- define a
   * Profile and watch what it does, then govern what it knows and what it may
   * reach.
   *
   * "Hermes corpus" was named after the storage mechanism rather than either of
   * the two unrelated things stored in it, so it became Skills and Memory.
   * Runtime went the other way. It briefly held the kill switch, the run
   * counters and the execution ledger as a fifth tab, and that split one
   * workflow down the middle: the question "is this Profile working" was
   * answered on a different screen from the one that defines it, joined only by
   * a cross-tab button. Profiles owns all three again -- what an agent is, what
   * it is doing, and whether it may run at all.
   */
  Agents: [
    { label: "Profiles", view: "Agents" },
    { label: "Skills", view: "Skills" },
    { label: "Memory", view: "Memory" },
    { label: "Tools", view: "Integrations" },
  ],
  /*
   * Two tabs: is it broken *now*, and what happened *then*.
   *
   * This was one tab called "Health & evidence" holding four sub-tabs — the
   * only three-level navigation left in the product besides Setup. "Evidence"
   * was never a category; it is a word that meant something different in each
   * of those sub-tabs, so it named a tab whose contents an operator could not
   * predict.
   *
   * Both evidence surfaces are gone rather than renamed. Pilot readiness could
   * never show a row: `ProductionReadinessControl` has no create route and no
   * seed anywhere in the repo. Release gates governed an evaluation subsystem
   * that has since been removed outright, along with the activation gates that
   * depended on it. In both cases the tables outlived the screen.
   */
  Operations: [
    { label: "Health", view: "Operations" },
    { label: "Audit trail", view: "Audit" },
  ],
  /*
   * Setup is the bring-up sequence and nothing else. "System" is the tab the
   * update check moved to: checking for a release has no ordering relation to
   * connecting an inference server, and sitting between two setup steps was the
   * only thing that ever made it look like one.
   *
   * It was called "Application" until it also began reporting what the host
   * update agent is doing. "Application" named the software; the tab now covers
   * the deployment running it -- the release, the approved target, and the
   * upgrade as it happens on VM1 -- which is a machine, not an application.
   */
  /*
   * The three governed-inference tabs moved out to Gateway. What is left is what
   * Settings has always actually been about: bringing the deployment up, and
   * keeping the machine it runs on current. Models, prompts and guardrails are
   * not setup steps -- they are the running configuration of the inference path,
   * and grouping them under the same roof as "install this" made Settings read
   * as a drawer rather than a place.
   */
  Settings: [
    { label: "Setup", view: "Deployment" },
    { label: "System", view: "Application" },
  ],
  Gateway: [
    { label: "Models", view: "Models" },
    { label: "Prompts", view: "Prompts" },
    { label: "Guardrails", view: "Guardrails" },
  ],
};

const areaByView: Record<ActiveView, ProductArea> = {
  Overview: "Dashboard",
  Chat: "Session",
  Agents: "Agents",
  Skills: "Agents",
  Memory: "Agents",
  Integrations: "Agents",
  Deployment: "Settings",
  Application: "Settings",
  Models: "Gateway",
  Prompts: "Gateway",
  Guardrails: "Gateway",
  Operations: "Operations",
  Audit: "Operations",
};

const pathByView: Record<ActiveView, string> = {
  Overview: "#dashboard",
  Chat: "#session",
  Agents: "#agents/profiles",
  Skills: "#agents/skills",
  Memory: "#agents/memory",
  Integrations: "#agents/tools",
  Deployment: "#settings/setup",
  Application: "#settings/system",
  Models: "#gateway/models",
  Prompts: "#gateway/prompts",
  Guardrails: "#gateway/guardrails",
  Operations: "#operations/health",
  Audit: "#operations/audit",
};

export function productAreaForView(view: ActiveView): ProductArea {
  return areaByView[view];
}

/**
 * The tabs an area draws, as data rather than as markup. `WorkspaceContextBar`
 * is the only renderer, but the model it renders is what tests should be able
 * to state -- a tab strip is the one place the product's structure is visible,
 * and reading it back through jsdom to assert five labels would test the
 * Button component instead.
 */
export function sectionNavigationFor(area: ProductArea): ReadonlyArray<SectionNavigationItem> {
  return sectionNavigation[area] ?? [];
}

/**
 * The address for a view, and — for Setup only — for a step within it.
 *
 * Setup's sub-state used to live in `app.tsx` as `deploymentInitialTab`, a
 * component-level string the address bar knew nothing about: Back from the
 * nodes panel left Settings entirely, and a reload part-way through a
 * twenty-minute VM2 enrolment returned to the overview. A step is a place, so
 * it gets an address.
 */
export function pathForView(view: ActiveView, setupStep?: SetupStepKey | null): string {
  if (view === "Deployment" && setupStep) return `${pathByView.Deployment}/${setupStep}`;
  return pathByView[view];
}

/**
 * The Setup step a hash names, or null when it names none.
 *
 * `viewFromHash` answers "which screen"; this answers "where in it". Kept
 * beside its sibling so the two cannot disagree about what `#settings/setup/…`
 * means, and covered by a test that walks every key rather than the two anyone
 * happened to type.
 */
export function setupStepFromHash(hash: string): SetupStepKey | null {
  const step = /^#(?:settings|platform)\/setup\/([a-z-]+)$/.exec(hash.toLowerCase())?.[1];
  return step === "inference" || step === "runtime" || step === "profile" ? step : null;
}

export function viewFromHash(hash: string): ActiveView {
  switch (hash.toLowerCase()) {
    /*
     * Every view here already accepted more than one spelling, which is what
     * makes renaming a route cheap: the old hash stays a case rather than
     * becoming a dead link. `#home` needs no case at all -- an unknown hash
     * falls through to Overview, which is where it went before.
     */
    case "#session":
    case "#chat":
      return "Chat";
    case "#operations/audit":
    case "#audit":
      return "Audit";
    /*
     * `#agents/runtime` addressed a fifth tab that Profiles has absorbed
     * whole -- the kill switch, the run counters and the execution ledger all
     * live there now -- so the old address has a correct destination rather
     * than falling through to Overview and dropping the operator out of the
     * area. Same reasoning as `#agents/corpus` below.
     */
    case "#agents":
    case "#agents/profiles":
    case "#agents/runtime":
    case "#runtime":
      return "Agents";
    /*
     * `#agents/corpus` addressed one screen that is now two. Skills is where
     * the majority of it went -- the file tree, the mutation queue and the
     * revision history all describe skills far more often than the two memory
     * files -- so an existing bookmark lands there rather than falling through
     * to Overview, which would drop the operator out of the area entirely.
     */
    case "#agents/skills":
    case "#agents/corpus":
    case "#corpus":
    case "#skills":
      return "Skills";
    /*
     * `#platform/memory` is the one retired hash that was not carried over when
     * Platform became Settings at v4.9.0. It mattered more than its siblings,
     * not less: up to v4.6.0 it was the address `pathForView` *generated* for
     * Memory, so it is the spelling that is actually in address bars and
     * bookmarks, while `#memory` -- kept -- was only ever the short alias. The
     * screen still exists at `#agents/memory`, so the old link has a correct
     * destination rather than a silent fall-through to the Dashboard.
     */
    case "#agents/memory":
    case "#platform/memory":
    case "#memory":
      return "Memory";
    case "#agents/tools":
    case "#integrations":
      return "Integrations";
    case "#settings":
    case "#settings/setup":
    case "#platform":
    case "#platform/setup":
    case "#setup":
    case "#deployment":
    /*
     * The three steps are addressable, so a bookmark, a Back press, or a reload
     * during a twenty-minute VM2 install lands where it left. `setupStepFromHash`
     * decides which step; this only has to agree that all of them are Setup,
     * and `workspace-navigation.test.ts` walks every key to keep the two lists
     * from drifting apart.
     */
    case "#settings/setup/inference":
    case "#settings/setup/runtime":
    case "#settings/setup/profile":
      return "Deployment";
    /*
     * The tab is "System"; the routing token stays `Application` for the reason
     * given at the top of this file, and the hash follows the label the way
     * `Deployment` is addressed as `#settings/setup`.
     *
     * The two former spellings are kept rather than dropped. This screen went
     * from "the update check" to the place an operator watches an upgrade run,
     * so it is the one Settings tab somebody has reason to have bookmarked
     * mid-incident, and a retired hash that falls through would drop them on
     * the Dashboard at exactly the wrong moment.
     */
    case "#settings/system":
    case "#system":
    case "#settings/application":
    case "#application":
      return "Application";
    /*
     * `#gateway` bare lands on Models, the first tab, the same way `#settings`
     * lands on Deployment. `#settings/*` and `#platform/*` stay: two moves have
     * now passed over these screens and a bookmark from either era still works.
     */
    case "#gateway":
    case "#gateway/models":
    case "#settings/models":
    case "#platform/models":
    case "#models":
      return "Models";
    case "#gateway/prompts":
    case "#settings/prompts":
    case "#platform/prompts":
    case "#prompts":
      return "Prompts";
    case "#gateway/guardrails":
    case "#settings/guardrails":
    case "#platform/guardrails":
    case "#guardrails":
      return "Guardrails";
    /*
     * `#operations` was the whole area when it was one screen with four
     * sub-tabs, so a bookmark to it means "Health" now — that is where the
     * control room, the topology and the incidents went.
     */
    case "#operations":
    case "#operations/health":
    case "#health":
      return "Operations";
    /*
     * Release gates was removed with the evaluation subsystem. Its hashes stay
     * as cases rather than becoming dead links: an operator following an old
     * bookmark lands on Health, which is the surface that absorbed what
     * Operations still does, instead of falling through to the Dashboard.
     */
    case "#operations/releases":
    case "#operations/evaluations":
    case "#releases":
      return "Operations";
    default:
      return "Overview";
  }
}

interface WorkspaceContextBarProps {
  area: ProductArea;
  activeView: ActiveView;
  onSelect: (view: ActiveView) => void;
  trailing?: ReactNode;
}

export function WorkspaceContextBar({ area, activeView, onSelect, trailing }: WorkspaceContextBarProps) {
  const items = sectionNavigationFor(area);
  if (!items.length) return null;

  return (
    /*
     * Pill tabs on the workspace surface, per the design's tab treatment: the
     * selected pill takes the accent-soft fill, the rest are quiet until
     * hovered. The old bar carried its own dark background, which survived the
     * theme switch as a black slab on a white page.
     */
    <div className="mb-7 flex min-h-[44px] items-center justify-between gap-4">
      <nav aria-label={`${area} sections`} className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {items.map((item) => (
          <Button
            key={item.view}
            size="sm"
            variant={item.view === activeView ? "secondary" : "ghost"}
            className={
              item.view === activeView
                ? "h-8 whitespace-nowrap border-accent/30 bg-soft px-4 text-caption text-accent hover:bg-soft"
                : "h-8 whitespace-nowrap px-4 text-caption font-medium"
            }
            aria-current={item.view === activeView ? "page" : undefined}
            onClick={() => onSelect(item.view)}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      {trailing}
    </div>
  );
}
