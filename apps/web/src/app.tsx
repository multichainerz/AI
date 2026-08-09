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
import { AdminSignInDialog } from "./admin-sign-in-dialog.js";
import { ConnectionDrawer, type ConnectionDraft } from "./connection-drawer.js";
import { connectionReadiness } from "./connection-readiness.js";
import { FrontPage } from "./front-page.js";
import { HomeView, type HomeLayer, type HomeReadinessCheck } from "./home-view.js";
import { connectionFor, deriveWorkspaceReadiness } from "./platform-readiness.js";
import { cn } from "./ui/index.js";
import {
  BalancerIcon,
  MonitorIcon,
  RobotIcon,
  ServerIcon,
  StorageIcon,
  TerminalIcon,
} from "./ui/relay-icons.js";
import { persistRailCollapsed, storedRailCollapsed } from "./shell-preferences.js";
import { currentTheme, toggleTheme, type Theme } from "./theme.js";
import {
  pathForView,
  primaryNavigationGroups,
  productAreaForView,
  viewFromHash,
  WorkspaceContextBar,
  type ActiveView,
  type ProductArea,
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

/**
 * Navigation glyphs, dispatched by the icon key `workspace-navigation.tsx`
 * already carries. The drawings are the Relay duotone set from the design
 * system (`ui/relay-icons.tsx`); the mapping lives here because it is a
 * navigation decision, not an icon-library one.
 *
 * One entry per product area and nothing else. The map used to carry eleven
 * keys, five of which no caller could reach — `Glyph` is only ever handed the
 * six `icon` values in `primaryNavigationGroups`, so the rest were imports
 * held open for a dispatch that never happened.
 *
 * Each drawing is the one the design reference names for that area: a monitor
 * for Home, a terminal window for Chat, a database cylinder for Knowledge, a
 * robot for Agents, stacked server racks for Platform, and a node graph for
 * Operations.
 */
function Glyph({ name }: { name: string }) {
  const glyphs: Record<string, ReactNode> = {
    overview: <MonitorIcon size={18} />,
    chat: <TerminalIcon size={18} />,
    documents: <StorageIcon size={18} />,
    agents: <RobotIcon size={18} />,
    setup: <ServerIcon size={18} />,
    operations: <BalancerIcon size={18} />,
  };

  /*
   * The glyph carries its own presentation (the Relay set brings size, stroke
   * and the duotone fills as presentation attributes — never an inline `style`,
   * which `style-src 'self'` refuses). It used to inherit from `.nav-item svg`,
   * and losing that rule once rendered every icon at the SVG default 300x150,
   * filled black, with nothing to catch it.
   */
  return glyphs[name] ?? null;
}

/**
 * The Sivali mark, served as a file rather than inlined: the traced SVG is
 * 66 KB, so as an <img> it is fetched once and cached instead of riding in
 * every render.
 */
function BrandMark({ size = 28 }: { size?: number }) {
  return <img src="/brand/sivali-mark.svg" alt="" width={size} height={size} className="block shrink-0" />;
}

function connectionState(connection: ServiceConnectionSummary | undefined) {
  const state = connectionReadiness(connection);
  return { label: state.label, tone: state.tone };
}

/**
 * The sticky band above every screen: where you are, and the theme switch.
 * Blurred over the content it floats on, per the design's header treatment.
 */
function WorkspaceHeader({ area }: { area: string }) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  return (
    <header className="workspace-header">
      <div className="flex h-12 items-center gap-4">
        <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-text">{area}</span>
        <span className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border border-border-strong px-2.5 py-1.5 text-caption font-medium text-muted transition-colors hover:border-faint hover:text-text"
          onClick={() => setTheme(toggleTheme())}
          title={theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"}
        >
          {theme === "light" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M20.4 13.2A8.4 8.4 0 0 1 10.8 3.6a8.4 8.4 0 1 0 9.6 9.6z" fill="currentColor" fillOpacity="0.14" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4.2" fill="currentColor" fillOpacity="0.14" />
              <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
            </svg>
          )}
          {theme === "light" ? "Dark" : "Light"}
        </button>
      </div>
    </header>
  );
}

function App() {
  // Read once, from storage, so the rail opens at the width it was left at
  // rather than snapping after mount.
  const [railCollapsed, setRailCollapsed] = useState(() => storedRailCollapsed());
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
  const [signInOpen, setSignInOpen] = useState(false);
  // False until both session probes have answered once. The front page and the
  // shell are mutually exclusive surfaces, so rendering either before the
  // answer arrives shows the wrong one for a beat on every reload.
  const [sessionRestored, setSessionRestored] = useState(false);
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
      /*
       * Both probes are awaited before `sessionRestored` flips, because the
       * front page renders the moment no session exists: an enterprise
       * employee whose probe was still in flight would see the sign-in page
       * flash before the workspace replaced it. The enterprise chain used to
       * be fire-and-forget when the shell rendered regardless.
       */
      const enterpriseRestore = getOidcStatus()
        .then((status) => {
          if (!active || sessionGeneration.current !== generation) return;
          setOidcStatus(status);
          if (!status.configured) {
            setEnterpriseSession(null);
            return;
          }
          return getEnterpriseSession()
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
        if (session.passwordChangeRequired) return;
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
      } finally {
        await enterpriseRestore.catch(() => undefined);
        if (active && sessionGeneration.current === generation) setSessionRestored(true);
      }
    };
    void restoreSession();
    return () => { active = false; };
  }, []);

  const bootstrapState = platform?.bootstrapState ?? (apiAvailable ? "REQUIRED" : "LOCKED");
  const passwordChangePending = adminSession?.passwordChangeRequired === true;
  const unlocked = adminSession !== null && adminSession.passwordChangeRequired !== true;
  /*
   * One error cell serves three surfaces — the front page, the connection
   * drawer and the elevation dialog — and only one of them is ever visible.
   * Without clearing on the way in and out, a message raised in one is
   * inherited verbatim by the next: "Unable to save the connection." greeted
   * an operator on the sign-in card after their session expired, presented
   * through role="alert" as though it described their sign-in.
   */
  const showSurface = (open: () => void) => {
    setSettingsError(null);
    open();
  };
  // Every admin view reports an expired session the same way: bump the
  // generation so in-flight restores are ignored, then drop the session.
  const forgetAdminSession = () => {
    sessionGeneration.current += 1;
    setSettingsError(null);
    setAdminSession(null);
  };
  // Chat, Knowledge and Agents also serve enterprise identities, so an expiry
  // there has to drop both sessions rather than only the administrator one.
  const forgetAnySession = () => {
    forgetAdminSession();
    setEnterpriseSession(null);
  };
  /*
   * All three read the same way on purpose. Chat used to accept any enterprise
   * session without asking for its scope, which made it the one governed area
   * whose locked screen could not render at all: past the front-page guard an
   * enterprise session is always present when the administrator one is not, so
   * `chatUnlocked` was a constant `true` while its two siblings were a real
   * question. Deleting Chat's locked screen would have been the other way to
   * resolve that, and the wrong one — it is the screen an employee is most
   * likely to arrive at without permission.
   *
   * `enterpriseSessionSchema.scopes` is a fixed three-literal tuple today, so
   * in practice all three still answer true. That is a property of the
   * contract, not of these lines: widen the tuple and the three screens start
   * disagreeing, which is exactly what they should do.
   */
  const chatUnlocked = unlocked || enterpriseSession?.scopes.includes("chat:use") === true;
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
    // Without an unlocked administrator session the drawer has nothing to
    // offer — its sign-in branch moved to the front page — so the ask becomes
    // elevation: the dialog raises an administrator session beside the
    // enterprise one, and the operator clicks their way back in.
    if (!unlocked) {
      setSettingsError(null);
      setSignInOpen(true);
      return;
    }
    if (kind === "HERMES") {
      setSettingsError(null);
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
      /*
       * A 401 ends the session, and losing the session swaps the whole app to
       * the front page — so whatever the caller was about to report is now the
       * greeting on a sign-in card. Clearing the cell does not help: every
       * caller writes its own message immediately after this returns. The
       * message itself has to become the one that fits where it will actually
       * be read. "Unable to save the connection." above a password field was
       * the reported symptom, and it survived the first attempt at this fix
       * because that attempt only covered the transitions an operator chooses.
       */
      return "Your administrator session expired. Sign in to continue.";
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
      // A temporary password flips `passwordChangePending`, and the whole app
      // swaps to the front page's change form on that flag alone.
      if (session.passwordChangeRequired) return true;
      const response = await getConnections();
      if (sessionGeneration.current !== generation) return false;
      setManagedConnections(response.items);
      void getConnectionMonitoring().then(setConnectionMonitoring).catch(() => setConnectionMonitoring(null));
      void getChatMetrics().then(setChatMetrics).catch(() => setChatMetrics(null));
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
    setSettingsError(null);
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

  /*
   * Sidebar counts, drawn only where the shell already holds the number.
   *
   * Chat has one: the conversation count from the same metrics window the Home
   * screen reports its Hermes responses from. Knowledge and Operations do not —
   * nothing in this component loads a document or an incident total — so those
   * rows carry no badge at all rather than a plausible-looking figure. A badge
   * is read as a fact about the workspace, and an invented one is worse than an
   * absent one.
   */
  const navigationCounts: Partial<Record<ProductArea, number>> =
    chatMetrics && chatMetrics.conversations > 0 ? { Chat: chatMetrics.conversations } : {};

  /*
   * Three mutually exclusive surfaces, decided only once the session probes
   * have answered: the splash (a beat of brand violet, never the wrong page),
   * the front page (no session at all, or a session that must change its
   * password before it counts), and the workspace shell. Enterprise-only
   * sessions get the shell exactly as before — the front page is strictly the
   * signed-out and must-change surface.
   */
  if (!sessionRestored) {
    return (
      <div className="grid min-h-screen place-items-center bg-brand" aria-busy="true">
        <BrandMark size={44} />
      </div>
    );
  }

  if ((!adminSession && !enterpriseSession) || passwordChangePending) {
    return (
      <FrontPage
        bootstrapState={bootstrapState}
        busy={settingsBusy}
        error={settingsError}
        oidcConfigured={oidcStatus?.configured === true}
        session={adminSession}
        onLogin={loginAdministrator}
        onStartRecovery={startAdministratorRecovery}
        onChangePassword={changeAdministratorPassword}
        onRecover={recoverAdministrator}
      />
    );
  }

  /*
   * Past the two guards above, a session exists: the front page has already
   * claimed the "nobody is signed in" case and the "this session still owes a
   * password change" case, and neither can reach here. So the shell has no
   * signed-out operator to draw, and the arms that used to draw one ("SA" with
   * no name, "Not signed in", "No active session", a Sign out button that
   * might not belong to anyone) were describing a screen that no longer
   * exists. The non-null assertion states the invariant those guards
   * establish, which TypeScript cannot carry across an early return; inventing
   * a fallback string instead would just put the dead arm back under a
   * different spelling.
   */
  const operator = adminSession
    ? {
      initials: "SA",
      name: "System administrator",
      detail: adminSession.role.replaceAll("_", " ").toLowerCase(),
    }
    : {
      initials: enterpriseSession!.user.displayName.slice(0, 2).toUpperCase(),
      name: enterpriseSession!.user.displayName,
      detail: "Enterprise user",
    };

  /*
   * The rail's width is the operator's to set, not the router's.
   *
   * It used to collapse in Chat and expand everywhere else, which meant it moved
   * under whoever was using it on every navigation and could never be chosen.
   * Chat is still where collapsing pays most -- it brings its own conversation
   * rail, and two vertical lists before a word of the thread is what started
   * this -- but that is a reason to collapse it, not a reason to decide for
   * someone. One preference, respected on every screen.
   */
  return (
    <div className={cn("app-shell", railCollapsed && "app-shell--focus")}>
      <aside className="sidebar" aria-label="OrcaSynapse navigation">
        {/*
          * The brand band, 64px measured from the rail's top edge — which is
          * why it cancels the sidebar's own 20px of top padding rather than
          * sitting below it.
          *
          * It no longer carries the `.brand` class. That rule is declared
          * after `@tailwind utilities` at the same specificity, so it wins
          * every tie against a utility here, and what it was winning with was
          * the old two-line lockup: an 11px gap, a 25px skirt and a strapline
          * beneath the wordmark. The one thing it did that mattered is the
          * mobile hide, restated as `max-[760px]:hidden` against the same
          * 760px breakpoint the rail's bottom-bar layout uses.
          */}
        {/*
          * The mark became a tile.
          *
          * Collapsed, the rail is 76px of icons with nothing at the top to say
          * whose product this is -- the wordmark is the only identity there,
          * and it is the first thing a collapse takes away. A filled tile reads
          * as the application at either width, so the rail keeps an anchor
          * instead of starting with a nav row.
          */}
        <div className="-mt-5 mb-5 flex h-16 shrink-0 items-center gap-2.5 px-1 max-[760px]:hidden">
          <span
            aria-hidden="true"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/15 bg-white/10"
          >
            <BrandMark size={24} />
          </span>
          <strong className="font-display text-[18px] font-bold leading-none tracking-[-0.01em] text-white">OrcaSynapse</strong>
        </div>
        <nav aria-label="Primary navigation">
          {/*
            * One flat list of six, not two labelled groups: the design draws
            * the areas as a single run. The grouping still lives in
            * `workspace-navigation.tsx` because that is where the product
            * split is described — this only declines to draw a heading for it.
            */}
          <div className="nav-group">
            {primaryNavigationGroups.flatMap((group) => group.items).map(({ area, icon, target, description }) => {
              const active = area === activeArea;
              const count = navigationCounts[area];
              return (
                <button
                  /*
                   * White on the brand violet, per the design: the active row
                   * is a soft white fill at full white and semibold; inactive
                   * rows keep a near-white label and lose their weight. Tokens
                   * would be wrong for the text — the rail's background never
                   * themes, so its foreground must not either. The description
                   * lives in the tooltip; the row itself is one line.
                   */
                  className={cn(
                    "flex h-10 w-full items-center gap-3 rounded px-3 text-left font-sans text-[14.5px] transition-colors",
                    active
                      ? "bg-white/10 font-semibold text-white"
                      : "font-medium text-white/85 hover:bg-white/[0.06] hover:text-white",
                  )}
                  key={area}
                  ref={active ? activeNavigationItem : undefined}
                  aria-current={active ? "page" : undefined}
                  type="button"
                  title={description}
                  onClick={() => selectView(target)}
                >
                  {/*
                    * The glyph is the one thing on the row that is *not* the
                    * label's colour: bright accent when the row is active,
                    * muted lavender when it is not, so the icon column reads
                    * as a second, quieter rank.
                    *
                    * The two descendant selectors put the Relay set's cyan
                    * "live node" back on `currentColor` for the duration of
                    * the rail. That accent is meant to appear once per
                    * composition; six of them stacked down the sidebar was the
                    * loudest thing on the screen, and it also defeated the
                    * active/muted tinting, because the dot stayed cyan whether
                    * the row was selected or not.
                    */}
                  <span
                    className={cn(
                      "flex shrink-0 [&_.fill-node]:fill-current [&_.stroke-node]:stroke-current",
                      active ? "text-accent" : "text-white/45",
                    )}
                  >
                    <Glyph name={icon} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{area}</span>
                  {count === undefined ? null : (
                    <span className="shrink-0 text-[12px] tabular-nums text-white/45" title="Conversations in the last 24 hours">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>
        <div className="sidebar-bottom">
          {/*
            * The control that sets the rail's width lives in the rail.
            *
            * Hidden below 760px on purpose: down there the rail is already a
            * fixed bottom bar with no width to collapse, and the same media
            * guard keeps `.app-shell--focus` off that layout.
            */}
          <button
            type="button"
            className="mb-3 flex h-9 w-full items-center gap-3 rounded px-3 text-left font-sans text-[13px] font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white max-[760px]:hidden"
            onClick={() => {
              const next = !railCollapsed;
              setRailCollapsed(next);
              persistRailCollapsed(next);
            }}
            aria-expanded={!railCollapsed}
            aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span aria-hidden="true" className="flex shrink-0 text-white/55">
              <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.9" y="2.6" width="12.2" height="10.8" rx="2.2" />
                <path d="M6.6 2.6v10.8" />
                {railCollapsed ? <path d="M9.4 6.2 11.2 8l-1.8 1.8" /> : <path d="M11.2 6.2 9.4 8l1.8 1.8" />}
              </svg>
            </span>
            <span className="min-w-0 flex-1 truncate">{railCollapsed ? "Expand" : "Collapse"}</span>
          </button>
          <div className="operator">
            <div className="avatar">{operator.initials}</div>
            <div>
              <strong>{operator.name}</strong>
              <span>{operator.detail}</span>
            </div>
            <button type="button" onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
      </aside>

      <main className={activeView === "Chat" ? "chat-page" : undefined}>
        <div className="mobile-brand"><BrandMark size={26} /><strong>OrcaSynapse</strong></div>
        <WorkspaceHeader area={activeArea} />
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
              identityMode={adminSession ? "ADMINISTRATOR_PREVIEW" : "ENTERPRISE"}
              displayName={operator.name}
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
              // No kind is named because none can be honoured. Tooling raises
              // this only from its locked screen, which it draws exactly when
              // there is no administrator session — and that is the one case
              // `openConnectionSettings` answers with the elevation dialog
              // before it ever looks at the kind. There is no MCP connection
              // definition either, so the drawer had nothing to render.
              onConfigure={() => openConnectionSettings()}
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
              // Locked, the screen asks for an administrator sign-in;
              // `openConnectionSettings` answers with the elevation dialog
              // whenever the session is not unlocked.
              onOpenSettings={() => openConnectionSettings()}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Overview: () => (
            <HomeView
              apiAvailable={apiAvailable}
              bootstrapState={bootstrapState}
              unlocked={unlocked}
              healthyConnections={healthyConnections}
              monitoring={connectionMonitoring}
              chatMetrics={chatMetrics}
              layers={platformLayers}
              readiness={readinessChecks}
              onSelect={selectView}
              onUnlock={() => showSurface(() => setSignInOpen(true))}
            />
          ),
        } satisfies Record<ActiveView, () => ReactNode>)[activeView]()}
        </Suspense>
      </main>

      <ConnectionDrawer
        busy={settingsBusy}
        connections={managedConnections}
        monitoring={connectionMonitoring}
        diagnostic={diagnostic}
        error={settingsError}
        initialKind={drawerKind}
        open={drawerOpen}
        revisionConnectionId={revisionConnectionId}
        revisionHistory={revisionHistory}
        onClose={() => showSurface(() => setDrawerOpen(false))}
        onOpenAgenticSystem={() => openConnectionSettings("HERMES")}
        onSave={saveConnection}
        onTest={runConnectionTest}
        onDiscoverInference={discoverInference}
        onUpdateMonitoring={saveConnectionMonitoring}
        onLoadRevisions={loadRevisions}
        onRollback={restoreRevision}
      />
      <AdminSignInDialog
        open={signInOpen}
        busy={settingsBusy}
        error={settingsError}
        onClose={() => showSurface(() => setSignInOpen(false))}
        onLogin={loginAdministrator}
        onStartRecovery={startAdministratorRecovery}
      />
    </div>
  );
}

export default App;
