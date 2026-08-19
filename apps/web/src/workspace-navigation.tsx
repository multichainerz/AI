import type { ReactNode } from "react";
import {
  Activity,
  Boxes,
  Brain,
  HeartPulse,
  ListChecks,
  LockKeyhole,
  ScrollText,
  Server,
  Shield,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "./ui/cn.js";
import type { SetupStepKey } from "./setup-steps.js";

export type ActiveView =
  | "Overview"
  | "Deployment"
  | "Application"
  | "Chat"
  | "Files"
  | "Models"
  | "Usage"
  | "Agents"
  | "Skills"
  | "Memory"
  | "Integrations"
  | "Guardrails"
  | "People"
  | "Operations"
  | "Audit";

/*
 * What the areas are called on screen. The `ActiveView` tokens above are
 * internal routing names and deliberately did not follow: renaming those would
 * churn every view module, test fixture and CSS class for no reader's benefit.
 */
export type ProductArea = "Dashboard" | "Session" | "Files" | "Agents" | "Gateway" | "Settings" | "Operations";

export interface PrimaryNavigationItem {
  area: ProductArea;
  icon: string;
  target: ActiveView;
  description: string;
}

export interface SectionNavigationItem {
  label: string;
  view: ActiveView;
  /** Lucide key drawn beside the label in the header strip. */
  icon: string;
}

/**
 * Where in the rail a group's rows sit. `"bottom"` remains so a future group
 * can pin itself above the collapse control without a second renderer; nothing
 * uses it today. Settings is the last `"top"` row, immediately after Operations.
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
      /*
       * Directly after Session, because the first group is "use the product"
       * -- see activity, converse, run agents -- and Files is what conversing
       * produces. Putting agent output down among the governance areas would
       * file the deliverable under the machinery that made it.
       */
      { area: "Files", icon: "files", target: "Files", description: "Documents your agents produced" },
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
      { area: "Gateway", icon: "gateway", target: "Models", description: "Models, guardrails and usage for the governed inference path" },
      { area: "Operations", icon: "operations", target: "Operations", description: "Health, incidents and the audit trail" },
      { area: "Settings", icon: "settings", target: "Deployment", description: "Setup, access and system updates" },
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
    { label: "Profiles", view: "Agents", icon: "profiles" },
    { label: "Skills", view: "Skills", icon: "skills" },
    { label: "Memory", view: "Memory", icon: "memory" },
    { label: "Tools", view: "Integrations", icon: "tools" },
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
    { label: "Health", view: "Operations", icon: "health" },
    { label: "Audit trail", view: "Audit", icon: "audit" },
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
   * The governed-inference tabs moved out to Gateway. What is left is what
   * Settings has always actually been about: bringing the deployment up, and
   * keeping the machine it runs on current. Models and guardrails are
   * not setup steps -- they are the running configuration of the inference path,
   * and grouping them under the same roof as "install this" made Settings read
   * as a drawer rather than a place.
   */
  /*
   * Divisions and People were two tabs and are one. They were always one job --
   * who is in the organisation and how they are grouped -- and the split cost
   * an administrator real work rather than tidiness: the person form could not
   * name a division that did not exist yet, and going to make one unmounted the
   * form and threw the draft away. The screen holds both panels now, and
   * `#settings/divisions` is kept as an alias below.
   *
   * Not a tab with its own sub-navigation, which would have answered the letter
   * of this and none of it: divisions would still have been one click away from
   * the half-typed form, and the click would still have unmounted it. It would
   * also have revived the three-level navigation Operations was collapsed out
   * of at v5.1.0, two releases later, for tidiness.
   */
  Settings: [
    { label: "Setup", view: "Deployment", icon: "setup" },
    { label: "Access", view: "People", icon: "access" },
    { label: "System", view: "Application", icon: "system" },
  ],
  /*
   * Configure the route, state the policy, then read what it cost. Usage is
   * last because it is the only one of the three that changes nothing: Models
   * and Guardrails are settings an operator edits, and this is the evidence
   * they produced.
   *
   * It is in Gateway rather than Operations on purpose. Health answers "is
   * something degraded right now" and the audit trail answers "what happened";
   * neither is "what did the inference path consume", which is a property of
   * the path itself and belongs beside the routes that define it.
   */
  Gateway: [
    { label: "Models", view: "Models", icon: "models" },
    { label: "Guardrails", view: "Guardrails", icon: "guardrails" },
    { label: "Usage", view: "Usage", icon: "usage" },
  ],
};

const areaByView: Record<ActiveView, ProductArea> = {
  Overview: "Dashboard",
  Chat: "Session",
  Files: "Files",
  Agents: "Agents",
  Skills: "Agents",
  Memory: "Agents",
  Integrations: "Agents",
  Deployment: "Settings",
  People: "Settings",
  Application: "Settings",
  Models: "Gateway",
  Guardrails: "Gateway",
  Usage: "Gateway",
  Operations: "Operations",
  Audit: "Operations",
};

const pathByView: Record<ActiveView, string> = {
  Overview: "#dashboard",
  Chat: "#session",
  Files: "#files",
  Agents: "#agents/profiles",
  Skills: "#agents/skills",
  Memory: "#agents/memory",
  Integrations: "#agents/tools",
  Deployment: "#settings/setup",
  People: "#settings/access",
  Application: "#settings/system",
  Models: "#gateway/models",
  Guardrails: "#gateway/guardrails",
  Usage: "#gateway/usage",
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
    case "#files":
      return "Files";
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
     * The tab is "Access"; the routing token stays `People` and the hash
     * follows the label the way `Deployment` is `#settings/setup`.
     *
     * `#settings/people`, `#people`, `#settings/divisions` and `#divisions`
     * addressed earlier names of this screen -- People as its own tab, then
     * Divisions as a sibling that this page now contains outright -- so an
     * existing bookmark has a correct destination rather than falling through
     * to the Dashboard and dropping the operator out of the area.
     *
     * This is the strongest of the aliases in this switch, and the only
     * one where the old screen is not merely *absorbed*: `#agents/corpus` lands
     * on the tab that took most of a split screen, `#agents/runtime` and
     * `#operations/releases` on tabs that took what still exists of a deleted
     * one. Here the divisions panel is on the page the link opens.
     *
     * What is honestly lost is the scroll position: the link lands at the top
     * of the screen rather than at the divisions panel. `viewFromHash` matches
     * a whole hash and the only sub-addressing in the product is Setup's three
     * steps, which exist because a VM2 install takes twenty minutes and a
     * reload has to return to it. A scroll offset does not earn the same
     * machinery.
     */
    case "#settings/access":
    case "#access":
    case "#settings/people":
    case "#people":
    case "#settings/divisions":
    case "#divisions":
      return "People";
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
     *
     * (This block sat above the People cases until v8.9.0, describing the four
     * cases below it across an unrelated pair. Moved rather than rewritten --
     * it was always about System.)
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
    /*
     * Prompts was a Gateway tab whose activate/suspend recorded a decision
     * nothing at runtime reads. System text comes from the agent profile
     * (`soulMd` / `instructions`). Bookmarks land on Models, the remaining
     * sibling, rather than falling through to the Dashboard.
     */
    case "#gateway/prompts":
    case "#settings/prompts":
    case "#platform/prompts":
    case "#prompts":
      return "Models";
    case "#gateway/guardrails":
    case "#settings/guardrails":
    case "#platform/guardrails":
    case "#guardrails":
      return "Guardrails";
    /*
     * New at v8.9.0, so there is no retired spelling to keep alive -- only the
     * short alias every other view in this switch also carries, so a typed
     * `#usage` lands somewhere rather than falling through to the Dashboard.
     */
    case "#gateway/usage":
    case "#usage":
      return "Usage";
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

/**
 * Drawings for the section strip. Keys live on the navigation model the same
 * way area glyphs do, so a tab cannot ship a label without a mark, and the
 * header cannot invent a second map that drifts from this one.
 */
function SectionGlyph({ name }: { name: string }) {
  const glyphs: Record<string, ReactNode> = {
    profiles: <UserRound size={15} strokeWidth={1.8} />,
    skills: <Sparkles size={15} strokeWidth={1.8} />,
    memory: <Brain size={15} strokeWidth={1.8} />,
    tools: <Wrench size={15} strokeWidth={1.8} />,
    models: <Boxes size={15} strokeWidth={1.8} />,
    guardrails: <Shield size={15} strokeWidth={1.8} />,
    usage: <Activity size={15} strokeWidth={1.8} />,
    health: <HeartPulse size={15} strokeWidth={1.8} />,
    audit: <ScrollText size={15} strokeWidth={1.8} />,
    setup: <ListChecks size={15} strokeWidth={1.8} />,
    access: <LockKeyhole size={15} strokeWidth={1.8} />,
    system: <Server size={15} strokeWidth={1.8} />,
  };
  return glyphs[name] ?? null;
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
     * A second row of the sticky band, not a pill strip on the page.
     *
     * Nested in `.workspace-header` so it sticks with the title. The row
     * restores the page text ramp -- without that it would inherit the band's
     * white-on-violet remap and stay dark in both appearances.
     *
     * The negative inline margin lines it up with the band's edges -- the
     * *band's*, so it cancels `--workspace-band-inline` rather than the page's
     * content inset. Those were one token until the area title ended up in a
     * different place on Dashboard and Session than on every area that has a
     * strip; reading the page token here would put these tabs back out of line
     * with the title directly above them.
     */
    <div className="workspace-header__sections -mx-[var(--workspace-band-inline)] flex items-stretch justify-between gap-4 px-[var(--workspace-band-inline)]">
      <nav aria-label={`${area} sections`} className="flex min-w-0 items-stretch overflow-x-auto">
        {items.map((item) => {
          const current = item.view === activeView;
          return (
            <Button
              key={item.view}
              variant="ghost"
              size="sm"
              className={cn(
                "relative h-10 gap-2 rounded-none border-0 bg-transparent px-3.5 text-caption shadow-none",
                "hover:bg-soft hover:text-text focus-visible:ring-offset-0",
                current
                  ? "font-semibold text-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-text"
                  : "font-medium text-muted",
              )}
              aria-current={current ? "page" : undefined}
              onClick={() => onSelect(item.view)}
            >
              <span aria-hidden="true" className="flex shrink-0 empty:hidden">
                <SectionGlyph name={item.icon} />
              </span>
              {item.label}
            </Button>
          );
        })}
      </nav>
      {trailing}
    </div>
  );
}
