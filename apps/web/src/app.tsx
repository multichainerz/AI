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
  InferenceDiscoveryRequest,
  InferenceDiscoveryResult,
} from "@orcasynapse/contracts";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  OrcaSynapseApiError,
  changeLocalAdministratorPassword,
  createInstallationKeyRecoverySession,
  createLocalAdministratorSession,
  createConnection,
  discoverInferenceServer,
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
  recoverLocalAdministrator,
  rollbackConfiguration,
  testConnection,
  updateConnection,
  updateConnectionMonitoring,
} from "./api.js";
import { ConnectionDrawer, type ConnectionDraft } from "./connection-drawer.js";
import { connectionDefinitions } from "./connection-definitions.js";

const OperationsView = lazy(() => import("./operations-view.js").then((module) => ({ default: module.OperationsView })));
const ChatView = lazy(() => import("./chat-view.js").then((module) => ({ default: module.ChatView })));
const DocumentsView = lazy(() => import("./documents-view.js").then((module) => ({ default: module.DocumentsView })));
const MemoryView = lazy(() => import("./memory-view.js").then((module) => ({ default: module.MemoryView })));
const AgentsView = lazy(() => import("./agents-view.js").then((module) => ({ default: module.AgentsView })));
const ToolingView = lazy(() => import("./tooling-view.js").then((module) => ({ default: module.ToolingView })));
const ModelsView = lazy(() => import("./models-view.js").then((module) => ({ default: module.ModelsView })));
const GuardrailsView = lazy(() => import("./guardrails-view.js").then((module) => ({ default: module.GuardrailsView })));
const PromptsView = lazy(() => import("./prompts-view.js").then((module) => ({ default: module.PromptsView })));
const OnboardingView = lazy(() => import("./onboarding-view.js").then((module) => ({ default: module.OnboardingView })));

type ActiveView = "Overview" | "Deployment" | "Chat" | "Models" | "Prompts" | "Agents" | "Documents" | "Memory" | "Integrations" | "Guardrails" | "Operations";

type NavigationItem = {
  label: string;
  icon: string;
  available: boolean;
};

const navigationGroups: ReadonlyArray<{ label: string; items: ReadonlyArray<NavigationItem> }> = [
  {
    label: "Workspace",
    items: [
      { label: "Overview", icon: "overview", available: true },
      { label: "Chat", icon: "chat", available: true },
      { label: "Documents", icon: "documents", available: true },
      { label: "Memory", icon: "memory", available: true },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { label: "Models", icon: "models", available: true },
      { label: "Prompts", icon: "prompts", available: true },
      { label: "Agents", icon: "agents", available: true },
    ],
  },
  {
    label: "Control",
    items: [
      { label: "Deployment", icon: "setup", available: true },
      { label: "Integrations", icon: "integrations", available: true },
      { label: "Guardrails", icon: "guardrails", available: true },
      { label: "Operations", icon: "operations", available: true },
    ],
  },
];

function Glyph({ name }: { name: string }) {
  const glyphs: Record<string, ReactNode> = {
    overview: <><path d="M4 13h6V4H4v9Z"/><path d="M14 20h6v-9h-6v9Z"/><path d="M4 20h6v-3H4v3Z"/><path d="M14 7h6V4h-6v3Z"/></>,
    setup: <><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5M8 17h3"/><path d="m15.5 16.5 1.5 1.5 3-3"/></>,
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

function OrcaSynapseMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 20.5c2.2-7 7-10.2 14.5-9.8 2.5.2 4.5 1 6 2.4-2.4.2-4.4 1.1-5.8 2.8-2.3 2.7-5.1 4.4-8.4 5.2-2.2.5-4.3.3-6.3-.6Z" />
      <path d="M21.2 10.8c.2-2 1.3-3.6 3.2-4.8.2 2.3-.5 4.2-2.1 5.7" />
      <circle cx="10" cy="13.4" r="1.4" />
      <circle cx="16.1" cy="9.4" r="1.2" />
      <circle cx="22.7" cy="16.2" r="1.2" />
      <path className="synapse-link" d="m10.9 12.4 4.2-2.3m2.2.1 4.4 5.1" />
    </svg>
  );
}

function connectionState(connection: ServiceConnectionSummary | undefined) {
  if (!connection) return { label: "Not configured", tone: "unconfigured" };
  if (!connection.enabled) return { label: "Saved, disabled", tone: "disabled" };
  return {
    label: connection.status
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/^./, (character) => character.toUpperCase()),
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
  const [drawerKind, setDrawerKind] = useState<ServiceKind>("INFERENCE");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ConnectionTestResult | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>(() => {
    const hash = window.location.hash.toLowerCase();
    return hash === "#chat"
      ? "Chat"
      : hash === "#setup" || hash === "#deployment"
        ? "Deployment"
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
    const item = activeNavigationItem.current;
    const container = item?.closest("nav");
    if (!item || !container || container.scrollWidth <= container.clientWidth) return;

    const centeredLeft = item.offsetLeft - (container.clientWidth - item.offsetWidth) / 2;
    container.scrollTo({ left: Math.max(0, centeredLeft), behavior: "auto" });
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
        if (session.passwordChangeRequired) {
          setDrawerOpen(true);
          return;
        }
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
            if (error instanceof OrcaSynapseApiError && error.status === 401) {
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
  const passwordChangePending = adminSession?.passwordChangeRequired === true;
  const unlocked = adminSession !== null && adminSession.passwordChangeRequired !== true;
  const chatUnlocked = enterpriseSession !== null || unlocked;
  const documentsUnlocked = unlocked || enterpriseSession?.scopes.includes("documents:use") === true;
  const agentsUnlocked = unlocked || enterpriseSession?.scopes.includes("agents:use") === true;
  const enabledConnections = managedConnections.filter(({ enabled }) => enabled).length;
  const healthyConnections = managedConnections.filter(({ status }) => status === "HEALTHY").length;
  const healthyConnection = (kind: ServiceKind) => managedConnections.some((connection) =>
    connection.kind === kind && connection.enabled && connection.status === "HEALTHY");
  const connectionFor = (kind: ServiceKind) => managedConnections.find((connection) => connection.kind === kind);
  const inferenceConnection = connectionFor("INFERENCE");
  const hermesConnection = connectionFor("HERMES");
  const supermemoryConnection = connectionFor("SUPERMEMORY");
  const oidcConnection = connectionFor("OIDC");
  const agenticReady = healthyConnection("HERMES") && healthyConnection("SUPERMEMORY");
  const agenticConfigured = Boolean(hermesConnection || supermemoryConnection);
  const agenticState = !unlocked
    ? { label: "Unlock to view", tone: "disabled" }
    : agenticReady
      ? { label: "Healthy", tone: "healthy" }
      : agenticConfigured
        ? { label: "Needs attention", tone: "degraded" }
        : { label: "Not configured", tone: "unconfigured" };
  const agenticActionKind: ServiceKind = !hermesConnection || !healthyConnection("HERMES") ? "HERMES" : "SUPERMEMORY";
  const platformLayers = [
    {
      key: "inference",
      name: "AI Inference",
      role: "Enterprise model serving",
      mark: "AI",
      tone: "blue",
      state: unlocked ? connectionState(inferenceConnection) : { label: "Unlock to view", tone: "disabled" },
      actionKind: "INFERENCE" as ServiceKind,
      components: undefined,
    },
    {
      key: "agentic",
      name: "Agentic System",
      role: "Hermes execution and Supermemory",
      mark: "AS",
      tone: "violet",
      state: agenticState,
      actionKind: agenticActionKind,
      components: unlocked ? [
        { name: "Hermes", ...connectionState(hermesConnection) },
        { name: "Memory", ...connectionState(supermemoryConnection) },
      ] : undefined,
    },
    {
      key: "access",
      name: "Enterprise Access",
      role: "OIDC, Microsoft Entra ID and RBAC · tenant isolation planned",
      mark: "EA",
      tone: "rose",
      state: unlocked
        ? oidcStatus?.configured
          ? { label: "Configured", tone: "healthy" }
          : connectionState(oidcConnection)
        : { label: "Unlock to view", tone: "disabled" },
      actionKind: "OIDC" as ServiceKind,
      components: undefined,
    },
  ];
  const readinessChecks = [
    {
      label: "AI Inference",
      detail: healthyConnection("INFERENCE") ? "Approved model serving is reachable" : "Connect and verify model serving",
      ready: healthyConnection("INFERENCE"),
      action: "Models" as ActiveView,
    },
    {
      label: "Agentic System",
      detail: agenticReady ? "Hermes and durable memory are reachable" : "Enroll the Hermes and Supermemory runtime",
      ready: agenticReady,
      action: "Deployment" as ActiveView,
    },
    {
      label: "Enterprise access",
      detail: oidcStatus?.configured ? "Enterprise identity and RBAC are configured" : "Configure OIDC or Microsoft Entra ID",
      ready: oidcStatus?.configured === true,
      action: "Deployment" as ActiveView,
    },
  ];
  const readyWorkloads = readinessChecks.filter(({ ready }) => ready).length;

  const openConnectionSettings = (kind: ServiceKind = "INFERENCE") => {
    setDrawerKind(kind);
    setSettingsError(null);
    setDiagnostic(null);
    setDrawerOpen(true);
  };

  const handleAdminError = (error: unknown, fallback: string): string => {
    if (error instanceof OrcaSynapseApiError && error.status === 401) {
      sessionGeneration.current += 1;
      setAdminSession(null);
    }
    return error instanceof Error ? error.message : fallback;
  };

  const establishAdministratorSession = async (
    issue: () => Promise<AdministratorSession>,
    fallback: string,
  ) => {
    const generation = ++sessionGeneration.current;
    let createdSession = false;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const session = await issue();
      createdSession = true;
      if (sessionGeneration.current !== generation) return false;
      setAdminSession(session);
      if (session.passwordChangeRequired) {
        setDrawerOpen(true);
        return true;
      }
      const response = await getConnections();
      if (sessionGeneration.current !== generation) return false;
      setManagedConnections(response.items);
      void getConnectionMonitoring().then(setConnectionMonitoring).catch(() => setConnectionMonitoring(null));
      void getChatMetrics().then(setChatMetrics).catch(() => setChatMetrics(null));
      if (activeView === "Operations") setDrawerOpen(false);
      return true;
    } catch (error) {
      if (createdSession) await revokeAdministratorSession().catch(() => undefined);
      if (sessionGeneration.current === generation) {
        setAdminSession(null);
        setSettingsError(handleAdminError(error, fallback));
      }
      return false;
    } finally {
      setSettingsBusy(false);
    }
  };

  const loginAdministrator = (username: string, password: string) =>
    establishAdministratorSession(
      () => createLocalAdministratorSession(username, password),
      "Unable to sign in with the supplied local account.",
    );

  const startAdministratorRecovery = (installationKey: string) =>
    establishAdministratorSession(
      () => createInstallationKeyRecoverySession(installationKey),
      "Unable to start local-account recovery.",
    );

  const completeAdministratorPassword = async (
    action: () => Promise<AdministratorSession>,
    fallback: string,
  ) => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const session = await action();
      setAdminSession(session);
      try {
        const response = await getConnections();
        setManagedConnections(response.items);
        void getConnectionMonitoring().then(setConnectionMonitoring).catch(() => setConnectionMonitoring(null));
        void getChatMetrics().then(setChatMetrics).catch(() => setChatMetrics(null));
      } catch {
        setSettingsError("The password was saved, but connection state could not be refreshed.");
      }
      return true;
    } catch (error) {
      setSettingsError(handleAdminError(error, fallback));
      return false;
    } finally {
      setSettingsBusy(false);
    }
  };

  const changeAdministratorPassword = (currentPassword: string, newPassword: string) =>
    completeAdministratorPassword(
      () => changeLocalAdministratorPassword(currentPassword, newPassword),
      "Unable to change the local administrator password.",
    );

  const recoverAdministrator = (username: string, newPassword: string) =>
    completeAdministratorPassword(
      () => recoverLocalAdministrator(username, newPassword),
      "Unable to recover the local administrator account.",
    );

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

  const discoverInference = async (
    input: InferenceDiscoveryRequest,
  ): Promise<InferenceDiscoveryResult | null> => {
    if (!adminSession) return null;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      return await discoverInferenceServer(input);
    } catch (error) {
      setSettingsError(handleAdminError(error, "Unable to discover the AI Inference endpoint."));
      return null;
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
      <aside className="sidebar" aria-label="OrcaSynapse navigation">
        <div className="brand">
          <div className="brand-mark"><OrcaSynapseMark /></div>
          <div><strong>OrcaSynapse</strong><span>On-prem AI control plane</span></div>
        </div>
        <nav aria-label="Primary navigation">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map(({ label, icon, available }) => (
                <button
                  className={label === activeView ? "nav-item active" : "nav-item"}
                  disabled={!available}
                  key={label}
                  ref={label === activeView ? activeNavigationItem : undefined}
                  aria-current={label === activeView ? "page" : undefined}
                  type="button"
                  title={available ? label : `${label} is planned for a later phase`}
                  onClick={() => available && selectView(label as ActiveView)}
                >
                  <Glyph name={icon} />
                  <span>{label}</span>
                  {!available && <small>Planned</small>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item settings-nav" type="button" onClick={() => openConnectionSettings()}>
            <Glyph name="settings"/><span>Settings</span>
          </button>
          <div className="operator">
            <div className="avatar">{adminSession ? "SA" : enterpriseSession ? enterpriseSession.user.displayName.slice(0, 2).toUpperCase() : "SA"}</div>
            <div>
              <strong>{passwordChangePending ? "Password change required" : adminSession ? "System administrator" : enterpriseSession?.user.displayName ?? "Not signed in"}</strong>
              <span>{adminSession ? adminSession.role.replaceAll("_", " ").toLowerCase() : enterpriseSession ? "Enterprise user" : "No active session"}</span>
            </div>
            {(adminSession || enterpriseSession) && <button type="button" onClick={() => void signOut()}>Sign out</button>}
          </div>
        </div>
      </aside>

      <main className={activeView === "Chat" ? "chat-page" : undefined}>
        <div className="mobile-brand"><span className="brand-mark"><OrcaSynapseMark /></span><strong>OrcaSynapse</strong></div>
        <Suspense fallback={<section className="view-loading" aria-live="polite"><span className="setup-spinner" />Loading workspace...</section>}>
        {activeView === "Chat" ? (
          <ChatView
            unlocked={chatUnlocked}
            identityMode={unlocked && adminSession ? "ADMINISTRATOR_PREVIEW" : enterpriseSession ? "ENTERPRISE" : null}
            displayName={unlocked && adminSession ? "System administrator" : enterpriseSession?.user.displayName ?? null}
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
            onConfigureConnections={() => openConnectionSettings("INFERENCE")}
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
            onOpenSettings={() => openConnectionSettings("INFERENCE")}
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
            onConfigure={() => openConnectionSettings("SUPERMEMORY")}
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
            onConfigureInference={() => openConnectionSettings("INFERENCE")}
            onOpenOperations={() => selectView("Operations")}
            onSessionExpired={() => {
              sessionGeneration.current += 1;
              setAdminSession(null);
            }}
          />
        ) : activeView === "Deployment" ? (
          <OnboardingView
            connections={managedConnections}
            unlocked={unlocked}
            oidcConfigured={oidcStatus?.administratorSignIn === true}
            onConfigure={(kind) => openConnectionSettings(kind)}
            onOpenWorkspace={(workspace) => selectView(workspace)}
            onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23deployment")}
            onUnauthorized={() => {
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
                <p className="page-kicker">Control plane overview</p>
                <h1>AI operations at a glance</h1>
                <p>Current readiness, infrastructure health, and the shortest path to a usable on-premise AI workspace.</p>
              </div>
              <div className="topbar-actions">
                <span className={`status-chip ${apiAvailable ? "online" : "offline"}`}><i />{apiAvailable ? "Control plane online" : "Control plane offline"}</span>
                <button className="primary-button" type="button" onClick={() => openConnectionSettings()}>Manage platform</button>
              </div>
            </header>

            <section className={`setup-banner ${bootstrapState.toLowerCase()}`}>
              <div className="banner-icon"><Glyph name="guardrails" /></div>
              <div>
                <strong>{bootstrapState === "READY" ? unlocked ? "Administrator workspace active" : passwordChangePending ? "Password change required" : "Local sign-in ready" : bootstrapState === "REQUIRED" ? "Installation required" : "Installation trust locked"}</strong>
                <p>{bootstrapState === "READY" ? unlocked ? `${readyWorkloads} of ${readinessChecks.length} core capabilities are ready.` : passwordChangePending ? "Replace the temporary password before opening administrative operations." : "Sign in with the local administrator account to manage encrypted endpoints and credentials." : "Run the protected host installer before configuring services."}</p>
              </div>
              <button type="button" onClick={() => bootstrapState === "READY" ? openConnectionSettings() : selectView("Deployment")}>{bootstrapState === "READY" ? "Open connections" : "Review setup"}</button>
            </section>

            <section className="metrics" aria-label="Platform summary">
              <article><span>Configured endpoints</span><strong>{unlocked ? managedConnections.length : "—"}</strong><small>{unlocked ? `${connectionDefinitions.length} managed connectors across 3 layers` : "Unlock to view"}</small></article>
              <article><span>Healthy connections</span><strong>{unlocked ? healthyConnections : "—"}</strong><small>{connectionMonitoring?.enabled ? monitoringCadence(connectionMonitoring.intervalSeconds) : "Credential-aware checks"}</small></article>
              <article><span>Enabled connections</span><strong>{unlocked ? enabledConnections : "—"}</strong><small>Available to OrcaSynapse services</small></article>
              <article><span>Tool posture</span><strong className="metric-posture">Default deny</strong><small>No access without an explicit grant</small></article>
            </section>

            <div className="content-grid">
              <section className="panel connections-panel">
                <div className="panel-heading">
                  <div><p className="section-kicker">Platform foundation</p><h2>AI operating layers</h2><p>Three layers take the installation from model serving to governed agents and enterprise access.</p></div>
                  <button className="text-button" type="button" onClick={() => openConnectionSettings()}>Manage platform</button>
                </div>
                <div className="connection-list">
                  {platformLayers.map((layer) => <article className="connection connection-layer" key={layer.key}>
                    <div className={`connection-mark ${layer.tone}`}>{layer.mark}</div>
                    <div className="connection-copy">
                      <strong>{layer.name}</strong>
                      <span>{layer.role}</span>
                      {layer.components && <div className="connection-components">{layer.components.map((component) => <small key={component.name}><i className={component.tone} />{component.name}: {component.label}</small>)}</div>}
                    </div>
                    <span className={`connection-status ${layer.state.tone}`}><i />{layer.state.label}</span>
                    <button type="button" aria-label={`Manage ${layer.name}`} onClick={() => openConnectionSettings(layer.actionKind)}>{unlocked ? layer.state.tone === "unconfigured" ? "Configure" : "Manage" : "Unlock"}</button>
                  </article>)}
                </div>
              </section>

              <section className="panel architecture-panel">
                <div className="panel-heading"><div><p className="section-kicker">Runtime trust boundary</p><h2>Target execution path</h2><p>Hermes stays isolated while OrcaSynapse mediates identity, policy, model access, and approved integrations.</p></div><span className="phase-tag">Default deny</span></div>
                <ol className="runtime-flow">
                  <li><span>1</span><div><strong>OrcaSynapse</strong><small>Identity and orchestration</small></div></li>
                  <li><span>2</span><div><strong>Hermes</strong><small>Isolated agent runtime</small></div></li>
                  <li><span>3</span><div><strong>OrcaSynapse gateway</strong><small>Model policy and audit</small></div></li>
                  <li><span>4</span><div><strong>AI Inference</strong><small>Approved local model serving</small></div></li>
                </ol>
                <div className="boundary-note"><Glyph name="guardrails" /><div><strong>Secrets terminate at OrcaSynapse</strong><p>Hermes receives bounded runtime access; database and enterprise connector credentials remain in the control plane.</p></div></div>
              </section>

              <section className="panel readiness-panel">
                <div className="panel-heading"><div><p className="section-kicker">Operational readiness</p><h2>Core capabilities</h2><p>Live connection state determines what operators and employees can use now.</p></div><span className={`readiness-count ${!unlocked ? "restricted" : readyWorkloads === readinessChecks.length ? "ready" : "pending"}`}>{unlocked ? `${readyWorkloads}/${readinessChecks.length} ready` : "Unlock to verify"}</span></div>
                {chatMetrics && (
                  <div className="chat-metric-grid" aria-label="Chat metrics for the last 24 hours">
                    <div><span>Responses</span><strong>{chatMetrics.responses.toLocaleString()}</strong></div>
                    <div><span>Failure rate</span><strong>{(chatMetrics.failureRate * 100).toFixed(1)}%</strong></div>
                    <div><span>Avg latency</span><strong>{chatMetrics.averageLatencyMs === null ? "—" : `${(chatMetrics.averageLatencyMs / 1000).toFixed(1)}s`}</strong></div>
                    <div><span>Tokens</span><strong>{chatMetrics.totalTokens.toLocaleString()}</strong></div>
                  </div>
                )}
                <div className="readiness-list">
                  {readinessChecks.map((check) => (
                    <button type="button" key={check.label} onClick={() => unlocked ? selectView(check.action) : openConnectionSettings()}>
                      <span className={`readiness-dot ${!unlocked ? "restricted" : check.ready ? "ready" : "pending"}`}><i /></span>
                      <span><strong>{check.label}</strong><small>{unlocked ? check.detail : "Unlock to view current readiness"}</small></span>
                      <span aria-hidden="true">→</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
        </Suspense>
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
        session={adminSession}
        revisionConnectionId={revisionConnectionId}
        revisionHistory={revisionHistory}
        onClose={() => {
          if (!adminSession?.passwordChangeRequired) setDrawerOpen(false);
        }}
        onSave={saveConnection}
        onTest={runConnectionTest}
        onDiscoverInference={discoverInference}
        onUpdateMonitoring={saveConnectionMonitoring}
        onLogin={loginAdministrator}
        onStartRecovery={startAdministratorRecovery}
        onChangePassword={changeAdministratorPassword}
        onRecover={recoverAdministrator}
        onLoadRevisions={loadRevisions}
        onRollback={restoreRevision}
        onSignOut={signOut}
      />
    </div>
  );
}

export default App;
