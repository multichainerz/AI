import type {
  AdministratorSession,
  ConfigurationRevisionList,
  ConnectionMonitoringControl,
  ConnectionTestResult,
  PlatformMeta,
  ServiceConnectionSummary,
  ServiceKind,
  EnterpriseSession,
  OidcStatus,
  ChatMetrics,
} from "@aihub/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AIHubApiError,
  createAdministratorSession,
  createConnection,
  getAdministratorSession,
  getEnterpriseSession,
  getOidcStatus,
  getChatMetrics,
  getConfigurationRevisions,
  getConnectionMonitoring,
  getConnections,
  getPlatformMeta,
  revokeAdministratorSession,
  revokeEnterpriseSession,
  rollbackConfiguration,
  testConnection,
  updateConnection,
  updateConnectionMonitoring,
} from "./api.js";
import { ConnectionDrawer, type ConnectionDraft } from "./connection-drawer.js";
import { connectionDefinitions } from "./connection-definitions.js";
import { OperationsView } from "./operations-view.js";
import { ChatView } from "./chat-view.js";
import { DocumentsView } from "./documents-view.js";
import { MemoryView } from "./memory-view.js";
import { AgentsView } from "./agents-view.js";
import { ToolingView } from "./tooling-view.js";
import { ModelsView } from "./models-view.js";
import { GuardrailsView } from "./guardrails-view.js";
import { PromptsView } from "./prompts-view.js";

type ActiveView = "Overview" | "Chat" | "Models" | "Prompts" | "Agents" | "Documents" | "Memory" | "Integrations" | "Guardrails" | "Operations";

const navigation: ReadonlyArray<{
  label: string;
  icon: string;
  available: boolean;
}> = [
  { label: "Overview", icon: "overview", available: true },
  { label: "Chat", icon: "chat", available: true },
  { label: "Models", icon: "models", available: true },
  { label: "Prompts", icon: "prompts", available: true },
  { label: "Agents", icon: "agents", available: true },
  { label: "Documents", icon: "documents", available: true },
  { label: "Memory", icon: "memory", available: true },
  { label: "Integrations", icon: "integrations", available: true },
  { label: "Guardrails", icon: "guardrails", available: true },
  { label: "Operations", icon: "operations", available: true },
];

function Glyph({ name }: { name: string }) {
  const glyphs: Record<string, ReactNode> = {
    overview: <><path d="M4 13h6V4H4v9Z"/><path d="M14 20h6v-9h-6v9Z"/><path d="M4 20h6v-3H4v3Z"/><path d="M14 7h6V4h-6v3Z"/></>,
    chat: <path d="M21 12a8 8 0 0 1-8 8H7l-4 2 1.4-4.2A8 8 0 1 1 21 12Z"/>,
    models: <><path d="m12 2 8 4.5-8 4.5-8-4.5L12 2Z"/><path d="m4 11 8 4.5 8-4.5"/><path d="m4 15.5 8 4.5 8-4.5"/></>,
    prompts: <><path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    agents: <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M9 12h.01M15 12h.01M9 16h6M12 7V3M9 3h6"/></>,
    documents: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
    memory: <><path d="M9.5 4A3.5 3.5 0 0 0 6 7.5c0 .5.1 1 .3 1.4A4 4 0 0 0 7 16.8V18a3 3 0 0 0 5 2.2V5.8A3 3 0 0 0 9.5 4Z"/><path d="M14.5 4A3.5 3.5 0 0 1 18 7.5c0 .5-.1 1-.3 1.4a4 4 0 0 1-.7 7.9V18a3 3 0 0 1-5 2.2V5.8A3 3 0 0 1 14.5 4Z"/></>,
    integrations: <><path d="M8 12h8M12 8v8"/><circle cx="12" cy="12" r="9"/></>,
    guardrails: <path d="M12 2 20 5v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5l8-3Z"/>,
    operations: <><path d="M4 18v-5M9 18V8M14 18v-3M19 18V5"/><path d="M3 21h18"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };

  return <svg viewBox="0 0 24 24" aria-hidden="true">{glyphs[name]}</svg>;
}

function connectionState(connection: ServiceConnectionSummary | undefined) {
  if (!connection) return { label: "Not configured", tone: "unconfigured" };
  if (!connection.enabled) return { label: "Saved, disabled", tone: "disabled" };
  return {
    label: connection.status.replaceAll("_", " ").toLowerCase(),
    tone: connection.status.toLowerCase(),
  };
}

function monitoringCadence(seconds: number): string {
  if (seconds < 60) return `Checked every ${seconds} sec`;
  if (seconds < 3_600) return `Checked every ${Math.round(seconds / 60)} min`;
  return `Checked every ${Math.round(seconds / 3_600)} hr`;
}

function App() {
  const [platform, setPlatform] = useState<PlatformMeta | null>(null);
  const [apiAvailable, setApiAvailable] = useState(true);
  const [adminSession, setAdminSession] = useState<AdministratorSession | null>(null);
  const [enterpriseSession, setEnterpriseSession] = useState<EnterpriseSession | null>(null);
  const [oidcStatus, setOidcStatus] = useState<OidcStatus | null>(null);
  const [chatMetrics, setChatMetrics] = useState<ChatMetrics | null>(null);
  const [managedConnections, setManagedConnections] = useState<ServiceConnectionSummary[]>([]);
  const [connectionMonitoring, setConnectionMonitoring] = useState<ConnectionMonitoringControl | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerKind, setDrawerKind] = useState<ServiceKind>("LITELLM");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ConnectionTestResult | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>(() => {
    const hash = window.location.hash.toLowerCase();
    return hash === "#chat"
      ? "Chat"
      : hash === "#models"
        ? "Models"
        : hash === "#prompts"
          ? "Prompts"
        : hash === "#agents"
          ? "Agents"
          : hash === "#documents"
            ? "Documents"
            : hash === "#memory"
              ? "Memory"
              : hash === "#integrations"
                ? "Integrations"
                : hash === "#guardrails"
                  ? "Guardrails"
                  : hash === "#operations"
                    ? "Operations"
                    : "Overview";
  });
  const [revisionHistory, setRevisionHistory] = useState<ConfigurationRevisionList | null>(null);
  const [revisionConnectionId, setRevisionConnectionId] = useState<string | null>(null);
  const sessionGeneration = useRef(0);
  const activeNavigationItem = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeNavigationItem.current?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
  }, [activeView]);

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    const refreshPlatform = async () => {
      try {
        setPlatform(await getPlatformMeta(controller.signal));
        setApiAvailable(true);
      } catch {
        if (!controller.signal.aborted) setApiAvailable(false);
      } finally {
        if (!controller.signal.aborted) refreshTimer = window.setTimeout(refreshPlatform, 5_000);
      }
    };
    void refreshPlatform();
    return () => {
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const generation = sessionGeneration.current;
    const restoreSession = async () => {
      void getOidcStatus()
        .then((status) => active && setOidcStatus(status))
        .catch(() => active && setOidcStatus(null));
      void getEnterpriseSession()
        .then((session) => {
          if (active && sessionGeneration.current === generation) setEnterpriseSession(session);
        })
        .catch(() => {
          if (active && sessionGeneration.current === generation) setEnterpriseSession(null);
        });
      try {
        const session = await getAdministratorSession();
        if (!active || sessionGeneration.current !== generation) return;
        setAdminSession(session);
        try {
          const connections = await getConnections();
          if (active && sessionGeneration.current === generation) {
            setManagedConnections(connections.items);
            void getConnectionMonitoring().then((control) => {
              if (active && sessionGeneration.current === generation) setConnectionMonitoring(control);
            }).catch(() => undefined);
            void getChatMetrics().then((metrics) => {
              if (active && sessionGeneration.current === generation) setChatMetrics(metrics);
            }).catch(() => undefined);
          }
        } catch (error) {
          if (active && sessionGeneration.current === generation) {
            if (error instanceof AIHubApiError && error.status === 401) {
              setAdminSession(null);
            } else {
              setSettingsError("The administrator session is active, but connections could not be loaded.");
            }
          }
        }
      } catch {
        if (active && sessionGeneration.current === generation) setAdminSession(null);
      }
    };
    void restoreSession();
    return () => { active = false; };
  }, []);

  const bootstrapState = platform?.bootstrapState ?? (apiAvailable ? "REQUIRED" : "LOCKED");
  const unlocked = adminSession !== null;
  const chatUnlocked = enterpriseSession !== null || unlocked;
  const documentsUnlocked = unlocked || enterpriseSession?.scopes.includes("documents:use") === true;
  const agentsUnlocked = unlocked || enterpriseSession?.scopes.includes("agents:use") === true;
  const enabledConnections = managedConnections.filter(({ enabled }) => enabled).length;
  const healthyConnections = managedConnections.filter(({ status }) => status === "HEALTHY").length;

  const openConnectionSettings = (kind: ServiceKind = "LITELLM") => {
    setDrawerKind(kind);
    setSettingsError(null);
    setDiagnostic(null);
    setDrawerOpen(true);
  };

  const handleAdminError = (error: unknown, fallback: string): string => {
    if (error instanceof AIHubApiError && error.status === 401) {
      sessionGeneration.current += 1;
      setAdminSession(null);
    }
    return error instanceof Error ? error.message : fallback;
  };

  const unlockSettings = async (token: string) => {
    const generation = ++sessionGeneration.current;
    let createdSession = false;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const session = await createAdministratorSession(token);
      createdSession = true;
      const response = await getConnections();
      if (sessionGeneration.current !== generation) return false;
      setAdminSession(session);
      setManagedConnections(response.items);
      void getConnectionMonitoring().then(setConnectionMonitoring).catch(() => setConnectionMonitoring(null));
      void getChatMetrics().then(setChatMetrics).catch(() => setChatMetrics(null));
      if (activeView === "Operations") setDrawerOpen(false);
      return true;
    } catch (error) {
      if (createdSession) await revokeAdministratorSession().catch(() => undefined);
      if (sessionGeneration.current === generation) {
        setAdminSession(null);
        setSettingsError(handleAdminError(error, "Unable to unlock settings."));
      }
      return false;
    } finally {
      setSettingsBusy(false);
    }
  };

  const saveConnection = async (draft: ConnectionDraft) => {
    if (!adminSession) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      if (draft.existingId) {
        const secrets = Object.keys(draft.secrets).length > 0 ? draft.secrets : undefined;
        await updateConnection(draft.existingId, {
          displayName: draft.displayName,
          environment: draft.environment,
          baseUrl: draft.baseUrl,
          enabled: draft.enabled,
          configuration: draft.configuration,
          ...(secrets ? { secrets } : {}),
        });
      } else {
        await createConnection(draft);
      }
      setManagedConnections((await getConnections()).items);
      setRevisionHistory(null);
      setRevisionConnectionId(null);
    } catch (error) {
      setSettingsError(handleAdminError(error, "Unable to save the connection."));
    } finally {
      setSettingsBusy(false);
    }
  };

  const runConnectionTest = async (id: string) => {
    if (!adminSession) return;
    setSettingsBusy(true);
    setSettingsError(null);
    setDiagnostic(null);
    try {
      setDiagnostic(await testConnection(id));
      setManagedConnections((await getConnections()).items);
    } catch (error) {
      setSettingsError(handleAdminError(error, "Unable to test the connection."));
    } finally {
      setSettingsBusy(false);
    }
  };

  const saveConnectionMonitoring = async (input: { enabled: boolean; intervalSeconds: number; reason: string }) => {
    if (!adminSession) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      setConnectionMonitoring(await updateConnectionMonitoring(input));
    } catch (error) {
      setSettingsError(handleAdminError(error, "Unable to update scheduled monitoring."));
    } finally {
      setSettingsBusy(false);
    }
  };

  const selectView = (view: ActiveView) => {
    setActiveView(view);
    window.history.replaceState(
      null,
      "",
      view === "Overview" ? window.location.pathname : `#${view.toLowerCase()}`,
    );
  };

  const loadRevisions = async (connectionId: string) => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      setRevisionConnectionId(connectionId);
      setRevisionHistory(await getConfigurationRevisions(connectionId));
    } catch (error) {
      setSettingsError(handleAdminError(error, "Unable to load revision history."));
    } finally {
      setSettingsBusy(false);
    }
  };

  const restoreRevision = async (
    connectionId: string,
    targetRevision: number,
    expectedActiveRevision: number,
  ) => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      await rollbackConfiguration(connectionId, targetRevision, expectedActiveRevision);
      setManagedConnections((await getConnections()).items);
      setRevisionHistory(await getConfigurationRevisions(connectionId));
    } catch (error) {
      setSettingsError(handleAdminError(error, "Unable to restore the selected revision."));
    } finally {
      setSettingsBusy(false);
    }
  };

  const signOut = async () => {
    sessionGeneration.current += 1;
    setAdminSession(null);
    setEnterpriseSession(null);
    setChatMetrics(null);
    setManagedConnections([]);
    setConnectionMonitoring(null);
    setRevisionHistory(null);
    setRevisionConnectionId(null);
    await Promise.allSettled([
      revokeAdministratorSession(),
      revokeEnterpriseSession(),
    ]);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="AIHub navigation">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div><strong>MPM AIHub</strong><span>Operations console</span></div>
        </div>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Primary navigation">
          {navigation.map(({ label, icon, available }) => (
            <button
              className={label === activeView ? "nav-item active" : "nav-item"}
              disabled={!available}
              key={label}
              ref={label === activeView ? activeNavigationItem : undefined}
              type="button"
              title={available ? label : `${label} is planned for a later phase`}
              onClick={() => available && selectView(label as ActiveView)}
            >
              <Glyph name={icon} />
              <span>{label}</span>
              {!available && <small>Planned</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item settings-nav" type="button" onClick={() => openConnectionSettings()}>
            <Glyph name="settings"/><span>Settings</span>
          </button>
          <div className="operator">
            <div className="avatar">{adminSession ? "SA" : enterpriseSession ? enterpriseSession.user.displayName.slice(0, 2).toUpperCase() : "SA"}</div>
            <div>
              <strong>{adminSession ? "System administrator" : enterpriseSession?.user.displayName ?? "Not signed in"}</strong>
              <span>{adminSession ? adminSession.role.replaceAll("_", " ").toLowerCase() : enterpriseSession ? "Enterprise user" : "No active session"}</span>
            </div>
            {(adminSession || enterpriseSession) && <button type="button" onClick={() => void signOut()}>Sign out</button>}
          </div>
        </div>
      </aside>

      <main className={activeView === "Chat" ? "chat-page" : undefined}>
        <div className="mobile-brand"><span className="brand-mark">M</span><strong>MPM AIHub</strong></div>
        {activeView === "Chat" ? (
          <ChatView
            unlocked={chatUnlocked}
            identityMode={adminSession ? "ADMINISTRATOR_PREVIEW" : enterpriseSession ? "ENTERPRISE" : null}
            displayName={adminSession ? "System administrator" : enterpriseSession?.user.displayName ?? null}
            oidcConfigured={oidcStatus?.configured === true}
            onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23chat")}
            onConfigure={() => openConnectionSettings("OIDC")}
            onUnauthorized={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
              setEnterpriseSession(null);
            }}
          />
        ) : activeView === "Models" ? (
          <ModelsView
            session={adminSession}
            connections={managedConnections}
            onConfigureConnections={() => openConnectionSettings("LITELLM")}
            onOpenOperations={() => selectView("Operations")}
            onSessionExpired={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
            }}
          />
        ) : activeView === "Prompts" ? (
          <PromptsView
            session={adminSession}
            onOpenOperations={() => selectView("Operations")}
            onOpenSettings={() => openConnectionSettings("LITELLM")}
            onSessionExpired={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
            }}
          />
        ) : activeView === "Agents" ? (
          <AgentsView
            unlocked={agentsUnlocked}
            administrator={adminSession !== null}
            oidcConfigured={oidcStatus?.configured === true}
            onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23agents")}
            onConfigure={() => openConnectionSettings("HERMES")}
            onUnauthorized={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
              setEnterpriseSession(null);
            }}
          />
        ) : activeView === "Documents" ? (
          <DocumentsView
            unlocked={documentsUnlocked}
            administrator={adminSession !== null}
            oidcConfigured={oidcStatus?.configured === true}
            onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23documents")}
            onConfigure={() => openConnectionSettings("SEAWEEDFS")}
            onUnauthorized={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
              setEnterpriseSession(null);
            }}
          />
        ) : activeView === "Memory" ? (
          <MemoryView
            unlocked={unlocked}
            onConfigure={() => openConnectionSettings("SUPERMEMORY")}
            onUnauthorized={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
            }}
          />
        ) : activeView === "Integrations" ? (
          <ToolingView
            unlocked={unlocked}
            scopes={adminSession?.scopes ?? []}
            onConfigure={() => openConnectionSettings("MCP")}
            onUnauthorized={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
            }}
          />
        ) : activeView === "Guardrails" ? (
          <GuardrailsView
            session={adminSession}
            onConfigureLiteLLM={() => openConnectionSettings("LITELLM")}
            onOpenOperations={() => selectView("Operations")}
            onSessionExpired={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
            }}
          />
        ) : activeView === "Operations" ? (
          <OperationsView
            unlocked={unlocked}
            scopes={adminSession?.scopes ?? []}
            onConfigure={() => openConnectionSettings()}
            onUnauthorized={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
            }}
          />
        ) : (
          <>
            <header className="topbar">
              <div className="page-heading">
                <p className="page-kicker">Control plane</p>
                <h1>Platform overview</h1>
                <p>Configure and supervise the services that power MPM's on-premise AI platform.</p>
              </div>
              <div className="topbar-actions">
                <span className={`status-chip ${apiAvailable ? "online" : "offline"}`}><i />{apiAvailable ? "API available" : "API unavailable"}</span>
                <button className="primary-button" type="button" onClick={() => openConnectionSettings()}>Manage platform</button>
              </div>
            </header>

            <section className={`setup-banner ${bootstrapState.toLowerCase()}`}>
              <div className="banner-icon"><Glyph name="guardrails" /></div>
              <div>
                <strong>{bootstrapState === "READY" ? "Configuration vault ready" : bootstrapState === "REQUIRED" ? "Installation bootstrap required" : "Configuration vault locked"}</strong>
                <p>{bootstrapState === "READY" ? "Unlock an administrator session to manage encrypted endpoints and credentials." : "Complete the protected database, master-key, and administrator-token bootstrap before configuring services."}</p>
              </div>
              <button type="button" onClick={() => openConnectionSettings()}>{bootstrapState === "READY" ? "Open connections" : "Review setup"}</button>
            </section>

            <section className="metrics" aria-label="Platform summary">
              <article><span>Configured services</span><strong>{unlocked ? managedConnections.length : "—"}</strong><small>{unlocked ? `${connectionDefinitions.length} supported in this release` : "Unlock to view"}</small></article>
              <article><span>Healthy connections</span><strong>{unlocked ? healthyConnections : "—"}</strong><small>{connectionMonitoring?.enabled ? monitoringCadence(connectionMonitoring.intervalSeconds) : "Credential-aware checks"}</small></article>
              <article><span>Enabled connections</span><strong>{unlocked ? enabledConnections : "—"}</strong><small>Available to AIHub services</small></article>
              <article><span>Tool posture</span><strong>Default deny</strong><small>Gateway staged · approval gated</small></article>
            </section>

            <div className="content-grid">
              <section className="panel connections-panel">
                <div className="panel-heading">
                  <div><p className="section-kicker">Infrastructure</p><h2>Service connections</h2><p>Endpoints and credentials are managed in the encrypted vault.</p></div>
                  <button className="text-button" type="button" onClick={() => openConnectionSettings()}>Manage connections</button>
                </div>
                <div className="connection-list">
                  {connectionDefinitions.map((definition) => {
                    const saved = managedConnections.find(({ kind }) => kind === definition.kind);
                    const state = connectionState(saved);
                    return (
                      <article className="connection" key={definition.name}>
                        <div className={`connection-mark ${definition.tone}`}>{definition.name.slice(0, 2).toUpperCase()}</div>
                        <div className="connection-copy"><strong>{definition.name}</strong><span>{saved?.baseUrl ?? definition.role}</span></div>
                        <span className={`connection-status ${state.tone}`}><i />{state.label}</span>
                        <button type="button" aria-label={`Configure ${definition.name}`} onClick={() => openConnectionSettings(definition.kind)}>{saved ? "Edit" : "Configure"}</button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="panel architecture-panel">
                <div className="panel-heading"><div><p className="section-kicker">Runtime trust boundary</p><h2>Agent inference route</h2><p>The zero-tool Hermes path remains enforced while the governed MCP gateway is accepted.</p></div></div>
                <ol className="runtime-flow">
                  <li><span>1</span><div><strong>AIHub</strong><small>Identity and policy</small></div></li>
                  <li><span>2</span><div><strong>Hermes</strong><small>Scoped execution</small></div></li>
                  <li><span>3</span><div><strong>LiteLLM</strong><small>Gateway controls</small></div></li>
                  <li><span>4</span><div><strong>vLLM</strong><small>On-prem inference</small></div></li>
                </ol>
                <div className="boundary-note"><Glyph name="guardrails" /><div><strong>Credentials stay behind AIHub</strong><p>Hermes receives the bounded request and model alias, never storage, database, or connector credentials.</p></div></div>
              </section>

              <section className="panel delivery-panel">
                <div className="panel-heading"><div><p className="section-kicker">Delivery</p><h2>On-premise AI workflows</h2><p>Phase 7 connects operational evidence, incident response, guardrail posture, and release gates across the existing workflows.</p></div><span className="phase-tag">Phase 7 foundation</span></div>
                <div className="progress-copy"><span>Implementation status</span><strong>Acceptance candidate</strong></div>
                {chatMetrics && (
                  <div className="chat-metric-grid" aria-label="Chat metrics for the last 24 hours">
                    <div><span>Responses</span><strong>{chatMetrics.responses.toLocaleString()}</strong></div>
                    <div><span>Failure rate</span><strong>{(chatMetrics.failureRate * 100).toFixed(1)}%</strong></div>
                    <div><span>Avg latency</span><strong>{chatMetrics.averageLatencyMs === null ? "—" : `${(chatMetrics.averageLatencyMs / 1000).toFixed(1)}s`}</strong></div>
                    <div><span>Tokens</span><strong>{chatMetrics.totalTokens.toLocaleString()}</strong></div>
                  </div>
                )}
                <ul>
                  <li className="done">Controlled LiteLLM chat and enterprise identity</li>
                  <li className="done">SeaweedFS document conversion and OCR</li>
                  <li className="done">Private Supermemory retrieval with source evidence</li>
                  <li className="done">Immutable Hermes profiles and global runtime control</li>
                  <li className="done">Zero-tool capability preflight and run revocation</li>
                  <li className="done">MCP registry, exact-version grants, and approval inbox</li>
                  <li className="done">AI operations, durable incidents, and evaluation release gates</li>
                  <li className="next">Live Hermes propagation, GPU telemetry, SIEM, and target acceptance</li>
                </ul>
              </section>
            </div>
          </>
        )}
      </main>

      <ConnectionDrawer
        bootstrapState={bootstrapState}
        busy={settingsBusy}
        connections={managedConnections}
        monitoring={connectionMonitoring}
        diagnostic={diagnostic}
        error={settingsError}
        initialKind={drawerKind}
        open={drawerOpen}
        unlocked={unlocked}
        revisionConnectionId={revisionConnectionId}
        revisionHistory={revisionHistory}
        onClose={() => setDrawerOpen(false)}
        onSave={saveConnection}
        onTest={runConnectionTest}
        onUpdateMonitoring={saveConnectionMonitoring}
        onUnlock={unlockSettings}
        onLoadRevisions={loadRevisions}
        onRollback={restoreRevision}
        onSignOut={signOut}
      />
    </div>
  );
}

export default App;
