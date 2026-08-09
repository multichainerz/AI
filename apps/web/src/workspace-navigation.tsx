import type { ReactNode } from "react";

export type ActiveView =
  | "Overview"
  | "Deployment"
  | "Chat"
  | "Models"
  | "Prompts"
  | "Memory"
  | "Agents"
  | "Documents"
  | "Integrations"
  | "Guardrails"
  | "Operations"
  | "Benchmarks"
  | "Audit";

/*
 * What the areas are called on screen. The `ActiveView` tokens above are
 * internal routing names and deliberately did not follow: renaming those would
 * churn every view module, test fixture and CSS class for no reader's benefit.
 */
export type ProductArea = "Dashboard" | "Session" | "Knowledge" | "Agents" | "Platform" | "Operations";

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
      { area: "Knowledge", icon: "documents", target: "Documents", description: "Documents and durable context" },
      { area: "Agents", icon: "agents", target: "Agents", description: "Profiles, runs and tools" },
    ],
  },
  {
    label: "Administration",
    items: [
      { area: "Platform", icon: "setup", target: "Deployment", description: "Setup and AI governance" },
      { area: "Operations", icon: "operations", target: "Operations", description: "Health, evidence and incidents" },
    ],
  },
];

const sectionNavigation: Partial<Record<ProductArea, ReadonlyArray<SectionNavigationItem>>> = {
  Agents: [
    { label: "Profiles & runs", view: "Agents" },
    { label: "Governed tools", view: "Integrations" },
  ],
  Operations: [
    { label: "Health & evidence", view: "Operations" },
    { label: "Benchmarks", view: "Benchmarks" },
    { label: "Audit trail", view: "Audit" },
  ],
  Platform: [
    { label: "Setup", view: "Deployment" },
    { label: "Models", view: "Models" },
    { label: "Prompts", view: "Prompts" },
    { label: "Memory", view: "Memory" },
    { label: "Guardrails", view: "Guardrails" },
  ],
};

const areaByView: Record<ActiveView, ProductArea> = {
  Overview: "Dashboard",
  Chat: "Session",
  Documents: "Knowledge",
  Agents: "Agents",
  Integrations: "Agents",
  Deployment: "Platform",
  Models: "Platform",
  Prompts: "Platform",
  Memory: "Platform",
  Guardrails: "Platform",
  Operations: "Operations",
  Benchmarks: "Operations",
  Audit: "Operations",
};

const pathByView: Record<ActiveView, string> = {
  Overview: "#dashboard",
  Chat: "#session",
  Documents: "#knowledge/documents",
  Agents: "#agents/profiles",
  Integrations: "#agents/tools",
  Deployment: "#platform/setup",
  Models: "#platform/models",
  Prompts: "#platform/prompts",
  Memory: "#platform/memory",
  Guardrails: "#platform/guardrails",
  Operations: "#operations",
  Benchmarks: "#operations/benchmarks",
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
    case "#knowledge":
    case "#knowledge/documents":
    case "#documents":
      return "Documents";
    case "#memory":
      return "Documents";
    case "#agents":
    case "#agents/profiles":
      return "Agents";
    case "#agents/tools":
    case "#integrations":
      return "Integrations";
    case "#platform":
    case "#platform/setup":
    case "#setup":
    case "#deployment":
      return "Deployment";
    case "#platform/models":
    case "#models":
      return "Models";
    case "#platform/prompts":
    case "#prompts":
      return "Prompts";
    case "#platform/memory":
      return "Memory";
    case "#platform/guardrails":
    case "#guardrails":
      return "Guardrails";
    case "#operations/benchmarks":
    case "#benchmarks":
      return "Benchmarks";
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
          <button
            key={item.view}
            type="button"
            className={
              item.view === activeView
                ? "whitespace-nowrap rounded-pill border border-accent/30 bg-soft px-4 py-2 text-caption font-semibold text-accent"
                : "whitespace-nowrap rounded-pill border border-transparent px-4 py-2 text-caption font-medium text-muted transition-colors hover:border-border-strong hover:text-text"
            }
            aria-current={item.view === activeView ? "page" : undefined}
            onClick={() => onSelect(item.view)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {trailing}
    </div>
  );
}
