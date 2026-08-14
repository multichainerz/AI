import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export type ActiveView =
  | "Overview"
  | "Deployment"
  | "Chat"
  | "Models"
  | "Prompts"
  | "Agents"
  | "Corpus"
  | "Integrations"
  | "Guardrails"
  | "Operations"
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

export const primaryNavigationGroups: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<PrimaryNavigationItem>;
}> = [
  {
    label: "Workspace",
    items: [
      { area: "Dashboard", icon: "overview", target: "Overview", description: "Activity, readiness and next actions" },
      { area: "Session", icon: "chat", target: "Chat", description: "Governed conversations" },
      { area: "Agents", icon: "agents", target: "Agents", description: "Profiles, runs and tools" },
    ],
  },
  {
    label: "Administration",
    items: [
      { area: "Operations", icon: "operations", target: "Operations", description: "Health, evidence and incidents" },
    ],
  },
];

/**
 * Settings is anchored separately at the bottom of the desktop rail. Keeping
 * it out of the primary groups makes that placement structural rather than a
 * visual reorder that can drift when navigation items are added later.
 */
export const settingsNavigationItem: PrimaryNavigationItem = {
  area: "Settings",
  icon: "settings",
  target: "Deployment",
  description: "Application setup, governance, and updates",
};

const sectionNavigation: Partial<Record<ProductArea, ReadonlyArray<SectionNavigationItem>>> = {
  Agents: [
    { label: "Profiles & runs", view: "Agents" },
    { label: "Hermes corpus", view: "Corpus" },
    { label: "Governed tools", view: "Integrations" },
  ],
  Operations: [
    { label: "Health & evidence", view: "Operations" },
    { label: "Audit trail", view: "Audit" },
  ],
  Settings: [
    { label: "Setup", view: "Deployment" },
    { label: "Models", view: "Models" },
    { label: "Prompts", view: "Prompts" },
    { label: "Guardrails", view: "Guardrails" },
  ],
};

const areaByView: Record<ActiveView, ProductArea> = {
  Overview: "Dashboard",
  Chat: "Session",
  Agents: "Agents",
  Corpus: "Agents",
  Integrations: "Agents",
  Deployment: "Settings",
  Models: "Settings",
  Prompts: "Settings",
  Guardrails: "Settings",
  Operations: "Operations",
  Audit: "Operations",
};

const pathByView: Record<ActiveView, string> = {
  Overview: "#dashboard",
  Chat: "#session",
  Agents: "#agents/profiles",
  Corpus: "#agents/corpus",
  Integrations: "#agents/tools",
  Deployment: "#settings/setup",
  Models: "#settings/models",
  Prompts: "#settings/prompts",
  Guardrails: "#settings/guardrails",
  Operations: "#operations",
  Audit: "#operations/audit",
};

export function productAreaForView(view: ActiveView): ProductArea {
  return areaByView[view];
}

export function pathForView(view: ActiveView): string {
  return pathByView[view];
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
    case "#agents/corpus":
    case "#corpus":
      return "Corpus";
    case "#agents/tools":
    case "#integrations":
      return "Integrations";
    case "#settings":
    case "#settings/setup":
    case "#platform":
    case "#platform/setup":
    case "#setup":
    case "#deployment":
      return "Deployment";
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
    case "#operations":
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
  const items = sectionNavigation[area];
  if (!items?.length) return null;

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
