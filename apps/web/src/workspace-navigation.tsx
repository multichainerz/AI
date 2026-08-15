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
  | "Runtime"
  | "Skills"
  | "Memory"
  | "Integrations"
  | "Guardrails"
  | "Operations"
  | "Releases"
  | "Audit";

/*
 * What the areas are called on screen. The `ActiveView` tokens above are
 * internal routing names and deliberately did not follow: renaming those would
 * churn every view module, test fixture and CSS class for no reader's benefit.
 */
export type ProductArea = "Dashboard" | "Session" | "Agents" | "Settings" | "Operations";

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
      { area: "Agents", icon: "agents", target: "Agents", description: "Profiles, runtime, skills, memory and tools" },
    ],
  },
  {
    label: "Administration",
    placement: "top",
    items: [
      { area: "Operations", icon: "operations", target: "Operations", description: "Health, release gates and the audit trail" },
    ],
  },
  {
    label: "System",
    placement: "bottom",
    items: [
      { area: "Settings", icon: "settings", target: "Deployment", description: "Application setup, governance, and updates" },
    ],
  },
];

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
   * Five tabs, one job each.
   *
   * Three of these used to be two: "Profiles & runs" carried both the
   * immutable configuration list and the live execution ledger, and "Hermes
   * corpus" was named after the storage mechanism rather than either of the
   * two unrelated things stored in it. The order is the operator's sequence --
   * define a Profile, watch it run, then govern what it knows and what it may
   * reach.
   */
  Agents: [
    { label: "Profiles", view: "Agents" },
    { label: "Runtime", view: "Runtime" },
    { label: "Skills", view: "Skills" },
    { label: "Memory", view: "Memory" },
    { label: "Agent Tools", view: "Integrations" },
  ],
  /*
   * Three tabs, split on the question each one answers: is it broken *now*,
   * may this artifact be promoted *before* it ships, and what happened *then*.
   *
   * It was two tabs, one of which held four sub-tabs — the only three-level
   * navigation left in the product besides Setup. "Health & evidence" was the
   * symptom: "evidence" is not a category, it is a word that appears in all
   * three of these jobs meaning something different each time (evaluation
   * evidence, audit evidence, readiness evidence), so it named a tab an
   * operator could not predict the contents of. Worse, its two evidence
   * sub-tabs were scope-gated, so an operator without `evaluations:read`
   * read a tab name promising a screen they could never open.
   *
   * Pilot readiness is gone rather than moved. `ProductionReadinessControl`
   * has no create route and no seed anywhere in the repo — only SELECT and
   * UPDATE in production code — so that screen could never display a row.
   * The tables stay; the tab was a promise the backend cannot keep.
   */
  Operations: [
    { label: "Health", view: "Operations" },
    { label: "Release gates", view: "Releases" },
    { label: "Audit trail", view: "Audit" },
  ],
  /*
   * Setup is the bring-up sequence and nothing else. "Application" is the tab
   * the update check moved to: checking for a release has no ordering relation
   * to connecting an inference server, and sitting between two setup steps was
   * the only thing that ever made it look like one.
   */
  Settings: [
    { label: "Setup", view: "Deployment" },
    { label: "Models", view: "Models" },
    { label: "Prompts", view: "Prompts" },
    { label: "Guardrails", view: "Guardrails" },
    { label: "Application", view: "Application" },
  ],
};

const areaByView: Record<ActiveView, ProductArea> = {
  Overview: "Dashboard",
  Chat: "Session",
  Agents: "Agents",
  Runtime: "Agents",
  Skills: "Agents",
  Memory: "Agents",
  Integrations: "Agents",
  Deployment: "Settings",
  Application: "Settings",
  Models: "Settings",
  Prompts: "Settings",
  Guardrails: "Settings",
  Operations: "Operations",
  Releases: "Operations",
  Audit: "Operations",
};

const pathByView: Record<ActiveView, string> = {
  Overview: "#dashboard",
  Chat: "#session",
  Agents: "#agents/profiles",
  Runtime: "#agents/runtime",
  Skills: "#agents/skills",
  Memory: "#agents/memory",
  Integrations: "#agents/tools",
  Deployment: "#settings/setup",
  Application: "#settings/application",
  Models: "#settings/models",
  Prompts: "#settings/prompts",
  Guardrails: "#settings/guardrails",
  Operations: "#operations/health",
  Releases: "#operations/releases",
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
    case "#agents":
    case "#agents/profiles":
      return "Agents";
    case "#agents/runtime":
    case "#runtime":
      return "Runtime";
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
    case "#agents/memory":
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
    case "#settings/application":
    case "#application":
      return "Application";
    case "#settings/models":
    case "#platform/models":
    case "#models":
      return "Models";
    case "#settings/prompts":
    case "#platform/prompts":
    case "#prompts":
      return "Prompts";
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
    case "#operations/releases":
    case "#operations/evaluations":
    case "#releases":
      return "Releases";
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
