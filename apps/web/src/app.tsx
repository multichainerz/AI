import type {
  AdministratorSession,
  ConfigurationRevisionList,
  ConnectionTestResult,
  JobOperationsSnapshot,
  PlatformMeta,
  ServiceConnectionSummary,
  ServiceKind,
} from "@aihub/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AIHubApiError,
  createAdministratorSession,
  createConnection,
  getAdministratorSession,
  getConfigurationRevisions,
  getConnections,
  getJobOperations,
  getPlatformMeta,
  redriveDeadLetters,
  revokeAdministratorSession,
  rollbackConfiguration,
  sendSystemProbe,
  testConnection,
  updateConnection,
} from "./api.js";
import { ConnectionDrawer, type ConnectionDraft } from "./connection-drawer.js";
import { connectionDefinitions } from "./connection-definitions.js";
import { OperationsView } from "./operations-view.js";

type ActiveView = "Overview" | "Operations";

const navigation: ReadonlyArray<{
  label: string;
  icon: string;
  available: boolean;
}> = [
  { label: "Overview", icon: "overview", available: true },
  { label: "Chat", icon: "chat", available: false },
  { label: "Models", icon: "models", available: false },
  { label: "Agents", icon: "agents", available: false },
  { label: "Documents", icon: "documents", available: false },
  { label: "Memory", icon: "memory", available: false },
  { label: "Integrations", icon: "integrations", available: false },
  { label: "Guardrails", icon: "guardrails", available: false },
  { label: "Operations", icon: "operations", available: true },
];

function Glyph({ name }: { name: string }) {
  const glyphs: Record<string, ReactNode> = {
    overview: <><path d="M4 13h6V4H4v9Z"/><path d="M14 20h6v-9h-6v9Z"/><path d="M4 20h6v-3H4v3Z"/><path d="M14 7h6V4h-6v3Z"/></>,
    chat: <path d="M21 12a8 8 0 0 1-8 8H7l-4 2 1.4-4.2A8 8 0 1 1 21 12Z"/>,
    models: <><path d="m12 2 8 4.5-8 4.5-8-4.5L12 2Z"/><path d="m4 11 8 4.5 8-4.5"/><path d="m4 15.5 8 4.5 8-4.5"/></>,
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

function App() {
  const [platform, setPlatform] = useState<PlatformMeta | null>(null);
  const [apiAvailable, setApiAvailable] = useState(true);
  const [adminSession, setAdminSession] = useState<AdministratorSession | null>(null);
  const [managedConnections, setManagedConnections] = useState<ServiceConnectionSummary[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerKind, setDrawerKind] = useState<ServiceKind>("LITELLM");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ConnectionTestResult | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("Overview");
  const [operations, setOperations] = useState<JobOperationsSnapshot | null>(null);
  const [operationsBusy, setOperationsBusy] = useState(false);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [operationsMessage, setOperationsMessage] = useState<string | null>(null);
  const [revisionHistory, setRevisionHistory] = useState<ConfigurationRevisionList | null>(null);
  const [revisionConnectionId, setRevisionConnectionId] = useState<string | null>(null);
  const sessionGeneration = useRef(0);

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
      try {
        const session = await getAdministratorSession();
        if (!active || sessionGeneration.current !== generation) return;
        setAdminSession(session);
        try {
          const connections = await getConnections();
          if (active && sessionGeneration.current === generation) {
            setManagedConnections(connections.items);
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

  const refreshOperations = async () => {
    if (!adminSession) return;
    setOperationsBusy(true);
    setOperationsError(null);
    try {
      setOperations(await getJobOperations());
    } catch (error) {
      setOperationsError(handleAdminError(error, "Unable to load job operations."));
    } finally {
      setOperationsBusy(false);
    }
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
      if (activeView === "Operations") {
        setDrawerOpen(false);
        void getJobOperations().then(setOperations).catch((error) => {
          setOperationsError(handleAdminError(error, "Unable to load job operations."));
        });
      }
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

  const runSystemProbe = async () => {
    if (!adminSession) return;
    setOperationsBusy(true);
    setOperationsError(null);
    setOperationsMessage(null);
    try {
      const result = await sendSystemProbe();
      setOperationsMessage(`System probe ${result.jobId.slice(0, 8)} queued.`);
      setOperations(await getJobOperations());
    } catch (error) {
      setOperationsError(handleAdminError(error, "Unable to queue a system probe."));
    } finally {
      setOperationsBusy(false);
    }
  };

  const runDeadLetterRedrive = async () => {
    if (!adminSession) return;
    setOperationsBusy(true);
    setOperationsError(null);
    setOperationsMessage(null);
    try {
      const result = await redriveDeadLetters();
      setOperationsMessage(result.message);
      setOperations(await getJobOperations());
    } catch (error) {
      setOperationsError(handleAdminError(error, "Unable to redrive dead letters."));
    } finally {
      setOperationsBusy(false);
    }
  };

  const selectView = (view: ActiveView) => {
    setActiveView(view);
    if (view === "Operations" && adminSession) void refreshOperations();
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
    setManagedConnections([]);
    setOperations(null);
    setRevisionHistory(null);
    setRevisionConnectionId(null);
    await revokeAdministratorSession().catch(() => undefined);
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
            <div className="avatar">SA</div>
            <div><strong>{adminSession ? "System administrator" : "Administrator locked"}</strong><span>{adminSession ? adminSession.role.replaceAll("_", " ").toLowerCase() : "No active session"}</span></div>
            {adminSession && <button type="button" onClick={() => void signOut()}>Sign out</button>}
          </div>
        </div>
      </aside>

      <main>
        <div className="mobile-brand"><span className="brand-mark">M</span><strong>MPM AIHub</strong></div>
        {activeView === "Operations" ? (
          <OperationsView
            busy={operationsBusy}
            error={operationsError}
            message={operationsMessage}
            snapshot={operations}
            unlocked={unlocked}
            onConfigure={() => openConnectionSettings()}
            onProbe={() => void runSystemProbe()}
            onRedrive={() => void runDeadLetterRedrive()}
            onRefresh={() => void refreshOperations()}
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
              <article><span>Healthy connections</span><strong>{unlocked ? healthyConnections : "—"}</strong><small>Credential-aware checks</small></article>
              <article><span>Enabled routes</span><strong>{unlocked ? enabledConnections : "—"}</strong><small>Available to AIHub services</small></article>
              <article><span>Execution posture</span><strong className="text-good">Restricted</strong><small>Hermes remains default-deny</small></article>
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
                <div className="panel-heading"><div><p className="section-kicker">Trust boundary</p><h2>Inference route</h2><p>Every model request follows one governed path.</p></div></div>
                <ol className="runtime-flow">
                  <li><span>1</span><div><strong>AIHub</strong><small>Identity and policy</small></div></li>
                  <li><span>2</span><div><strong>Hermes</strong><small>Scoped execution</small></div></li>
                  <li><span>3</span><div><strong>LiteLLM</strong><small>Gateway controls</small></div></li>
                  <li><span>4</span><div><strong>vLLM</strong><small>On-prem inference</small></div></li>
                </ol>
                <div className="boundary-note"><Glyph name="guardrails" /><div><strong>Credentials stay behind AIHub</strong><p>Hermes receives per-run capabilities, never general infrastructure credentials.</p></div></div>
              </section>

              <section className="panel delivery-panel">
                <div className="panel-heading"><div><p className="section-kicker">Delivery</p><h2>Foundation readiness</h2><p>Core local controls are implemented; enterprise identity remains an integration gate.</p></div><span className="phase-tag">Phase 1</span></div>
                <progress value="5" max="6">83%</progress>
                <div className="progress-copy"><span>Platform foundation</span><strong>5 of 6 controls</strong></div>
                <ul>
                  <li className="done">Application and database foundation</li>
                  <li className="done">Encrypted configuration vault</li>
                  <li className="done">Service diagnostics and audit trail</li>
                  <li className="done">PostgreSQL job operations</li>
                  <li className="done">Administrator sessions and scoped RBAC</li>
                  <li className="next">Enterprise OIDC role mapping</li>
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
        onUnlock={unlockSettings}
        onLoadRevisions={loadRevisions}
        onRollback={restoreRevision}
        onSignOut={signOut}
      />
    </div>
  );
}

export default App;
