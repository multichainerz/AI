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
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
} from "@orcasynapse/contracts";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  getAgentProfiles,
  getAgentRuntime,
  getHermesRuntimeNodes,
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
import { connectionReadiness } from "./connection-readiness.js";
import { HomeView, type HomeLayer, type HomeReadinessCheck } from "./home-view.js";
import { connectionFor, deriveWorkspaceReadiness } from "./platform-readiness.js";
import { MicroLabel, cn } from "./ui/index.js";
import {
  pathForView,
  primaryNavigationGroups,
  productAreaForView,
  viewFromHash,
  WorkspaceContextBar,
  type ActiveView,
} from "./workspace-navigation.js";

const OperationsView = lazy(() => import("./operations-view.js").then((module) => ({ default: module.OperationsView })));
const BenchmarksView = lazy(() => import("./benchmarks-view.js").then((module) => ({ default: module.BenchmarksView })));
const ChatView = lazy(() => import("./chat-view.js").then((module) => ({ default: module.ChatView })));
const DocumentsView = lazy(() => import("./documents-view.js").then((module) => ({ default: module.DocumentsView })));
const AgentsView = lazy(() => import("./agents-view.js").then((module) => ({ default: module.AgentsView })));
const ToolingView = lazy(() => import("./tooling-view.js").then((module) => ({ default: module.ToolingView })));
const ModelsView = lazy(() => import("./models-view.js").then((module) => ({ default: module.ModelsView })));
const GuardrailsView = lazy(() => import("./guardrails-view.js").then((module) => ({ default: module.GuardrailsView })));
const PromptsView = lazy(() => import("./prompts-view.js").then((module) => ({ default: module.PromptsView })));
const MemoryView = lazy(() => import("./memory-view.js").then((module) => ({ default: module.MemoryView })));
const OnboardingView = lazy(() => import("./onboarding-view.js").then((module) => ({ default: module.OnboardingView })));
const AuditView = lazy(() => import("./audit-view.js").then((module) => ({ default: module.AuditView })));

function Glyph({ name }: { name: string }) {
  const glyphs: Record<string, ReactNode> = {
    overview: <><path d="M4 13h6V4H4v9Z"/><path d="M14 20h6v-9h-6v9Z"/><path d="M4 20h6v-3H4v3Z"/><path d="M14 7h6V4h-6v3Z"/></>,
    setup: <><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5M8 17h3"/><path d="m15.5 16.5 1.5 1.5 3-3"/></>,
    chat: <path d="M21 12a8 8 0 0 1-8 8H7l-4 2 1.4-4.2A8 8 0 1 1 21 12Z"/>,
    models: <><path d="m12 2 8 4.5-8 4.5-8-4.5L12 2Z"/><path d="m4 11 8 4.5 8-4.5"/><path d="m4 15.5 8 4.5 8-4.5"/></>,
    prompts: <><path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    agents: <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M9 12h.01M15 12h.01M9 16h6M12 7V3M9 3h6"/></>,
    documents: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
    integrations: <><path d="M8 12h8M12 8v8"/><circle cx="12" cy="12" r="9"/></>,
    guardrails: <path d="M12 2 20 5v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5l8-3Z"/>,
    operations: <><path d="M4 18v-5M9 18V8M14 18v-3M19 18V5"/><path d="M3 21h18"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };

  /*
   * The glyph carries its own presentation.
   *
   * It used to inherit size and stroke from `.nav-item svg`, so rebuilding the
   * nav row on utility classes dropped the rule and every icon fell back to the
   * SVG default: 300x150, filled black. Nothing caught it — a black shape on a
   * dark panel has no text for the contrast sweep to measure, and the
   * accessibility tree does not report size. Presentation attributes rather than
   * an inline `style`, which `style-src 'self'` refuses.
   */
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-[18px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyphs[name]}
    </svg>
  );
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
  const state = connectionReadiness(connection);
  return { label: state.label, tone: state.tone };
}

function App() {
  const [platform, setPlatform] = useState<PlatformMeta | null>(null);
  const [apiAvailable, setApiAvailable] = useState(true);
  const [adminSession, setAdminSession] = useState<AdministratorSession | null>(null);
  const [enterpriseSession, setEnterpriseSession] = useState<EnterpriseSession | null>(null);
  const [oidcStatus, setOidcStatus] = useState<OidcStatus | null>(null);
  const [chatMetrics, setChatMetrics] = useState<ChatMetrics | null>(null);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeControl | null>(null);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [runtimeNodes, setRuntimeNodes] = useState<HermesRuntimeNode[]>([]);
  const [managedConnections, setManagedConnections] = useState<ServiceConnectionSummary[]>([]);
  const [connectionMonitoring, setConnectionMonitoring] = useState<ConnectionMonitoringControl | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerKind, setDrawerKind] = useState<ServiceKind>("INFERENCE");
  const [deploymentInitialTab, setDeploymentInitialTab] = useState<"journey" | "nodes" | "readiness">("journey");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ConnectionTestResult | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>(() => viewFromHash(window.location.hash));
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
    const synchronizeRoute = () => setActiveView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", synchronizeRoute);
    return () => window.removeEventListener("hashchange", synchronizeRoute);
  }, []);

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
        .then((status) => {
          if (!active || sessionGeneration.current !== generation) return;
          setOidcStatus(status);
          if (!status.configured) {
            setEnterpriseSession(null);
            return;
          }
          void getEnterpriseSession()
            .then((session) => {
              if (active && sessionGeneration.current === generation) setEnterpriseSession(session);
            })
            .catch(() => {
              if (active && sessionGeneration.current === generation) setEnterpriseSession(null);
            });
        })
        .catch(() => active && sessionGeneration.current === generation && setOidcStatus(null));
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
  // Every admin view reports an expired session the same way: bump the
  // generation so in-flight restores are ignored, then drop the session.
  const forgetAdminSession = () => {
    sessionGeneration.current += 1;
    setAdminSession(null);
  };
  // Chat, Knowledge and Agents also serve enterprise identities, so an expiry
  // there has to drop both sessions rather than only the administrator one.
  const forgetAnySession = () => {
    forgetAdminSession();
    setEnterpriseSession(null);
  };
  const chatUnlocked = enterpriseSession !== null || unlocked;
  const documentsUnlocked = unlocked || enterpriseSession?.scopes.includes("documents:use") === true;
  const agentsUnlocked = unlocked || enterpriseSession?.scopes.includes("agents:use") === true;

  const refreshWorkspaceState = useCallback(async () => {
    const [connections, runtime, profiles, nodes, metrics] = await Promise.all([
      getConnections(),
      getAgentRuntime(),
      getAgentProfiles(true),
      getHermesRuntimeNodes(),
      getChatMetrics().catch(() => null),
    ]);
    setManagedConnections(connections.items);
    setAgentRuntime(runtime);
    setAgentProfiles(profiles.items);
    setRuntimeNodes(nodes.items);
    if (metrics) setChatMetrics(metrics);
  }, []);

  /*
   * Keeps the session alive while the password must be changed.
   *
   * Every other authenticated screen touches the session constantly through the
   * reconciler below, which slides the server's idle window. This one is gated
   * out of it — `unlocked` is false until the password changes — so the single
   * screen that asks the operator to open a password manager, generate a
   * passphrase and type it three times was also the only screen whose session
   * quietly expired underneath them. Submitting then failed as
   * "the password could not be changed with the supplied credentials", which
   * reads as a wrong password and sends them round the same loop again.
   *
   * `GET /admin/session` is deliberately the call: it needs no scope, so it
   * works in exactly this state, and re-reading the principal means an expiry
   * that does happen surfaces here rather than at submit.
   */
  useEffect(() => {
    if (!passwordChangePending) return;
    const timer = window.setInterval(() => {
      void getAdministratorSession()
        .then((session) => setAdminSession(session))
        .catch(() => undefined);
    }, 4 * 60_000);
    return () => window.clearInterval(timer);
  }, [passwordChangePending]);

  useEffect(() => {
    if (!unlocked) {
      setAgentRuntime(null);
      setAgentProfiles([]);
      setRuntimeNodes([]);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const [connections, runtime, profiles, nodes, metrics] = await Promise.all([
          getConnections(),
          getAgentRuntime(),
          getAgentProfiles(true),
          getHermesRuntimeNodes(),
          getChatMetrics().catch(() => null),
        ]);
        if (!active) return;
        setManagedConnections(connections.items);
        setAgentRuntime(runtime);
        setAgentProfiles(profiles.items);
        setRuntimeNodes(nodes.items);
        if (metrics) setChatMetrics(metrics);
      } catch {
        // Individual workspaces surface actionable errors. This background
        // reconciler must never sign the operator out because of a transient VM2 gap.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked]);

  const readiness = deriveWorkspaceReadiness({
    connections: managedConnections,
    runtimeNodes,
    profiles: agentProfiles,
    runtime: agentRuntime,
  });
  const healthyConnections = managedConnections.filter(({ enabled, status }) => enabled && status === "HEALTHY").length;
  const inferenceConnection = connectionFor(managedConnections, "INFERENCE");
  const hermesConnection = connectionFor(managedConnections, "HERMES");
  const oidcConnection = connectionFor(managedConnections, "OIDC");
  const hermesChatReady = readiness.chatReady;
  const agenticReady = readiness.agenticReady;
  const agenticConfigured = Boolean(hermesConnection);
  const agenticState = !unlocked
    ? { label: "Unlock to view", tone: "disabled" }
    : agenticReady
      ? { label: "Ready", tone: "ready" }
      : agenticConfigured
        ? { label: "Degraded", tone: "degraded" }
        : { label: "Not configured", tone: "unconfigured" };
  const platformLayers: HomeLayer[] = [
    {
      key: "inference",
      name: "AI Inference",
      role: "Enterprise model serving",
      mark: "AI",
      state: unlocked ? connectionState(inferenceConnection) : { label: "Unlock to view", tone: "disabled" },
      components: [],
    },
    {
      key: "agentic",
      name: "Agentic System",
      role: "Governed Hermes execution",
      mark: "AS",
      state: agenticState,
      components: unlocked ? [
        { name: "Hermes", label: hermesChatReady ? "Ready" : readiness.runtimeNodeReady ? "Needs Profile or policy" : connectionState(hermesConnection).label, tone: hermesChatReady ? "ready" : readiness.runtimeNodeReady ? "degraded" : connectionState(hermesConnection).tone },
      ] : [],
    },
    {
      key: "access",
      name: "Enterprise Access",
      role: "OIDC, Microsoft Entra ID and RBAC · owner-scoped access",
      mark: "EA",
      state: unlocked
        ? oidcStatus?.configured
          ? { label: "Ready", tone: "ready" }
          : oidcConnection
            ? connectionState(oidcConnection)
            : { label: "Optional", tone: "configured" }
        : { label: "Unlock to view", tone: "disabled" },
      components: [],
    },
  ];
  const readinessChecks: HomeReadinessCheck[] = [
    {
      label: "AI Inference",
      detail: readiness.inferenceReady ? "Approved model serving is reachable" : "Connect and verify model serving",
      ready: readiness.inferenceReady,
      action: "Deployment" as ActiveView,
    },
    {
      label: "Isolated agent runtime",
      detail: readiness.runtimeNodeReady && readiness.hermesReady ? "VM2 is online and Hermes is reachable" : "Enroll VM2 and verify Hermes health",
      ready: readiness.runtimeNodeReady && readiness.hermesReady,
      action: "Deployment" as ActiveView,
    },
    {
      label: "Active Agent Profile",
      detail: readiness.executionReady ? "Hermes execution policy and an active Profile are ready" : readiness.profileReady ? "Enable the global Hermes execution boundary" : "Create and activate an Agent Profile",
      ready: readiness.executionReady,
      action: "Agents" as ActiveView,
    },
  ];

  const openConnectionSettings = (kind: ServiceKind = "INFERENCE") => {
    if (kind === "HERMES") {
      setDrawerOpen(false);
      selectView("Deployment", "nodes");
      return;
    }
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
      let savedConnection: ServiceConnectionSummary;
      const activateInference = draft.kind === "INFERENCE" && draft.enabled;
      if (draft.existingId) {
        const secrets = Object.keys(draft.secrets).length > 0 ? draft.secrets : undefined;
        savedConnection = await updateConnection(draft.existingId, {
          displayName: draft.displayName,
          environment: draft.environment,
          baseUrl: draft.baseUrl,
          enabled: activateInference ? false : draft.enabled,
          configuration: draft.configuration,
          ...(secrets ? { secrets } : {}),
        });
      } else {
        savedConnection = await createConnection({
          ...draft,
          enabled: activateInference ? false : draft.enabled,
        });
      }
      if (activateInference) {
        const result = await testConnection(savedConnection.id);
        setDiagnostic(result);
        if (result.status === "HEALTHY") {
          await updateConnection(savedConnection.id, { enabled: true });
        } else {
          setSettingsError(`AI Inference was saved but remains disabled: ${result.message}`);
        }
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
      const connection = managedConnections.find((item) => item.id === id);
      const result = await testConnection(id);
      setDiagnostic(result);
      if (connection?.kind === "INFERENCE" && !connection.enabled) {
        if (result.status === "HEALTHY") {
          await updateConnection(id, { enabled: true });
        } else {
          setSettingsError(`AI Inference remains disabled: ${result.message}`);
        }
      }
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

  const selectView = (view: ActiveView, deploymentTab: "journey" | "nodes" | "readiness" = "journey") => {
    if (view === "Deployment") setDeploymentInitialTab(deploymentTab);
    setActiveView(view);

    const target = view === "Overview" ? `${window.location.pathname}#home` : pathForView(view);
    // pushState, not replaceState: replacing left no history entry, so Back from
    // anywhere in the dashboard exited the application entirely rather than
    // returning to the previous screen. The existing hashchange listener picks
    // the pop up and re-derives the view, so nothing else is needed.
    //
    // Guarded because selectView is also called for the view already showing —
    // pushing there would stack duplicate entries and make Back appear stuck.
    if (`${window.location.pathname}${window.location.hash}` !== target) {
      window.history.pushState(null, "", target);
    }
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

  const activeArea = productAreaForView(activeView);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="OrcaSynapse navigation">
        <div className="brand">
          <div className="brand-mark"><OrcaSynapseMark /></div>
          <div><strong>OrcaSynapse</strong><span>On-prem AI control plane</span></div>
        </div>
        <nav aria-label="Primary navigation">
          {primaryNavigationGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <MicroLabel className="mx-2.5 mb-2 block">{group.label}</MicroLabel>
              {group.items.map(({ area, icon, target, description }) => (
                <button
                  /*
                   * The active row is marked by an accent rule on its leading
                   * edge and a lift in text weight - not a filled block. A solid
                   * highlight competes with the content it is pointing at, which
                   * on a screen this dense is the thing that should hold the eye.
                   */
                  className={cn(
                    "flex w-full items-center gap-3 rounded border-l-2 px-2.5 py-2 text-left transition-colors",
                    area === activeArea
                      ? "border-l-accent bg-raised text-text"
                      : "border-l-transparent text-muted hover:bg-raised hover:text-text",
                  )}
                  key={area}
                  ref={area === activeArea ? activeNavigationItem : undefined}
                  aria-current={area === activeArea ? "page" : undefined}
                  type="button"
                  title={description}
                  onClick={() => selectView(target)}
                >
                  <Glyph name={icon} />
                  <span className="min-w-0">
                    <strong className="block text-[12px] font-medium leading-tight">{area}</strong>
                    <small className="mt-0.5 block truncate text-[9px] leading-tight text-faint">{description}</small>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
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
        {activeView !== "Chat" && activeView !== "Overview" && (
          <WorkspaceContextBar area={activeArea} activeView={activeView} onSelect={selectView} />
        )}
        <Suspense fallback={<section className="view-loading" aria-live="polite"><span className="setup-spinner" />Loading workspace...</section>}>
        {/*
          * One entry per view, keyed by the same token the router produces.
          *
          * This was a twelve-branch nested ternary. A lookup makes the set
          * closed — a view without an entry is a compile error rather than a
          * silent fall-through to Home, which is what the chain did.
          */}
        {({
          Chat: () => (
            <ChatView
              unlocked={chatUnlocked}
              identityMode={unlocked && adminSession ? "ADMINISTRATOR_PREVIEW" : enterpriseSession ? "ENTERPRISE" : null}
              displayName={unlocked && adminSession ? "System administrator" : enterpriseSession?.user.displayName ?? null}
              administratorReadiness={unlocked ? {
                ready: readiness.chatReady,
                title: readiness.nextChatStep?.title ?? "Hermes is ready",
                detail: readiness.nextChatStep?.detail ?? "The governed Hermes route is ready.",
                target: readiness.nextChatStep?.target ?? "Agents",
              } : null}
              oidcConfigured={oidcStatus?.configured === true}
              onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23chat")}
              onConfigure={() => openConnectionSettings("OIDC")}
              onOpenAgents={() => selectView("Agents")}
              onOpenPlatform={() => selectView("Deployment")}
              onSessionExpired={forgetAnySession}
            />
          ),
          Models: () => (
            <ModelsView
              session={adminSession}
              connections={managedConnections}
              onConfigureConnections={() => openConnectionSettings("INFERENCE")}
              onOpenOperations={() => selectView("Operations")}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Memory: () => (
            <MemoryView
              session={adminSession}
              onOpenSettings={() => openConnectionSettings()}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Prompts: () => (
            <PromptsView
              session={adminSession}
              onOpenOperations={() => selectView("Operations")}
              onOpenSettings={() => openConnectionSettings("INFERENCE")}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Agents: () => (
            <AgentsView
              unlocked={agentsUnlocked}
              administrator={adminSession !== null}
              activationReady={unlocked ? readiness.agenticInfrastructureReady && readiness.inferenceReady : null}
              activationMessage={readiness.nextChatStep?.detail ?? null}
              oidcConfigured={oidcStatus?.configured === true}
              onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23agents%2Fprofiles")}
              onConfigure={() => openConnectionSettings("HERMES")}
              onOpenChat={() => {
                void refreshWorkspaceState().catch(() => undefined);
                selectView("Chat");
              }}
              onOpenReadiness={() => selectView("Deployment", "nodes")}
              onSessionExpired={forgetAnySession}
            />
          ),
          Documents: () => (
            <DocumentsView
              unlocked={documentsUnlocked}
              administrator={adminSession !== null}
              oidcConfigured={oidcStatus?.configured === true}
              onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23knowledge%2Fdocuments")}
              onConfigure={() => openConnectionSettings("HERMES")}
              onSessionExpired={forgetAnySession}
            />
          ),
          Integrations: () => (
            <ToolingView
              session={adminSession}
              onConfigure={() => openConnectionSettings("MCP")}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Guardrails: () => (
            <GuardrailsView
              session={adminSession}
              onConfigureInference={() => openConnectionSettings("INFERENCE")}
              onOpenOperations={() => selectView("Operations")}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Deployment: () => (
            <OnboardingView
              connections={managedConnections}
              agentRuntime={agentRuntime}
              profiles={agentProfiles}
              runtimeNodes={runtimeNodes}
              unlocked={unlocked}
              oidcConfigured={oidcStatus?.administratorSignIn === true}
              initialTab={deploymentInitialTab}
              onConfigure={(kind) => openConnectionSettings(kind)}
              onOpenWorkspace={(workspace) => selectView(workspace)}
              onRuntimeNodesChange={setRuntimeNodes}
              onOpenOperations={() => selectView("Operations")}
              onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23platform%2Fsetup")}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Audit: () => (
            <AuditView
              session={adminSession}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Operations: () => (
            <OperationsView
              session={adminSession}
              onConfigure={() => openConnectionSettings()}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Benchmarks: () => (
            <BenchmarksView
              session={adminSession}
              onOpenOperations={() => selectView("Operations")}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Overview: () => (
            <HomeView
              apiAvailable={apiAvailable}
              bootstrapState={bootstrapState}
              unlocked={unlocked}
              passwordChangePending={passwordChangePending}
              healthyConnections={healthyConnections}
              monitoring={connectionMonitoring}
              chatMetrics={chatMetrics}
              layers={platformLayers}
              readiness={readinessChecks}
              onSelect={selectView}
              onUnlock={() => setDrawerOpen(true)}
            />
          ),
        } satisfies Record<ActiveView, () => ReactNode>)[activeView]()}
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
        onOpenAgenticSystem={() => openConnectionSettings("HERMES")}
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
