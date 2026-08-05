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
  | "Audit";

export type ProductArea = "Home" | "Chat" | "Knowledge" | "Agents" | "Platform" | "Operations";

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
      { area: "Home", icon: "overview", target: "Overview", description: "Readiness and next actions" },
      { area: "Chat", icon: "chat", target: "Chat", description: "Governed conversations" },
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
  Overview: "Home",
  Chat: "Chat",
  Documents: "Knowledge",
  Agents: "Agents",
  Integrations: "Agents",
  Deployment: "Platform",
  Models: "Platform",
  Prompts: "Platform",
  Memory: "Platform",
  Guardrails: "Platform",
  Operations: "Operations",
  Audit: "Operations",
};

const pathByView: Record<ActiveView, string> = {
  Overview: "#home",
  Chat: "#chat",
  Documents: "#knowledge/documents",
  Agents: "#agents/profiles",
  Integrations: "#agents/tools",
  Deployment: "#platform/setup",
  Models: "#platform/models",
  Prompts: "#platform/prompts",
  Memory: "#platform/memory",
  Guardrails: "#platform/guardrails",
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
    <div className="workspace-context-bar">
      <div>
        <span>{area}</span>
        <nav aria-label={`${area} sections`}>
          {items.map((item) => (
            <button
              key={item.view}
              type="button"
              className={item.view === activeView ? "active" : undefined}
              aria-current={item.view === activeView ? "page" : undefined}
              onClick={() => onSelect(item.view)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      {trailing}
    </div>
  );
}
