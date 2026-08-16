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
  AgentMetrics,
  ToolMetrics,
  InferenceDiscoveryRequest,
  InferenceDiscoveryResult,
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
} from "@orcasynapse/contracts";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  LayoutDashboard,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Waypoints,
} from "lucide-react";
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
  getAgentMetrics,
  getAgentProfiles,
  getToolMetrics,
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
import { adminAccess } from "./admin-access.js";
import { AdminSignInDialog } from "./admin-sign-in-dialog.js";
import { ConnectionDrawer, type ConnectionDraft } from "./connection-drawer.js";
import type { SetupStepKey } from "./setup-steps.js";
import { connectionReadiness } from "./connection-readiness.js";
import { FrontPage } from "./front-page.js";
import { HomeView, type HomeLayer, type HomeReadinessCheck } from "./home-view.js";
import { DotGridField } from "./dot-grid-field.js";
import { connectionFor, deriveWorkspaceReadiness } from "./platform-readiness.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./ui/theme-toggle.js";
import { persistRailCollapsed, storedRailCollapsed } from "./shell-preferences.js";
import {
  pathForView,
  primaryNavigationItems,
  productAreaForView,
  setupStepFromHash,
  viewFromHash,
  WorkspaceContextBar,
  type ActiveView,
  type PrimaryNavigationItem,
  type ProductArea,
} from "./workspace-navigation.js";

const OperationsView = lazy(() => import("./operations-view.js").then((module) => ({ default: module.OperationsView })));
const ChatView = lazy(() => import("./chat-view.js").then((module) => ({ default: module.ChatView })));
const AgentsView = lazy(() => import("./agents-view.js").then((module) => ({ default: module.AgentsView })));
/*
 * Skills and Memory are one module rendered at two scopes rather than two
 * modules, because they are one governed mirror partitioned by file kind:
 * the node selector, the signed-snapshot status, the revision history and the
 * conflict-safe mutation dialog are identical on both, and duplicating four
 * hundred lines to change a noun is how two screens start disagreeing about
 * what an expected hash means.
 */
const CorpusView = lazy(() => import("./corpus-view.js").then((module) => ({ default: module.CorpusView })));
const ToolingView = lazy(() => import("./tooling-view.js").then((module) => ({ default: module.ToolingView })));
const ModelsView = lazy(() => import("./models-view.js").then((module) => ({ default: module.ModelsView })));
const GuardrailsView = lazy(() => import("./guardrails-view.js").then((module) => ({ default: module.GuardrailsView })));
const PromptsView = lazy(() => import("./prompts-view.js").then((module) => ({ default: module.PromptsView })));
const OnboardingView = lazy(() => import("./onboarding-view.js").then((module) => ({ default: module.OnboardingView })));
const ApplicationView = lazy(() => import("./application-view.js").then((module) => ({ default: module.ApplicationView })));
const AuditView = lazy(() => import("./audit-view.js").then((module) => ({ default: module.AuditView })));

/**
 * Navigation glyphs, dispatched by the icon key `workspace-navigation.tsx`
 * already carries. Functional shell icons use Lucide, matching the shadcn
 * component contract; the custom SVG remains reserved for the Orca brand.
 *
 * One entry per product area and nothing else. The map used to carry eleven
 * keys, five of which no caller could reach — `Glyph` is only ever handed the
 * icon values in the navigation model, so the rest were imports
 * held open for a dispatch that never happened.
 *
 * Each drawing is the one the design reference names for that area: a monitor
 * for Dashboard, a terminal window for Session, a robot for Agents, joined
 * waypoints for Gateway, a gear for Settings, and a node graph for Operations.
 *
 * Waypoints rather than a shield or a route marker: Gateway holds models,
 * prompts and guardrails, and a shield would overweight one of the three.
 */
function Glyph({ name }: { name: string }) {
  const glyphs: Record<string, ReactNode> = {
    overview: <LayoutDashboard size={20} strokeWidth={1.8} />,
    chat: <MessageSquareText size={20} strokeWidth={1.8} />,
    agents: <Bot size={20} strokeWidth={1.8} />,
    settings: <Settings size={20} strokeWidth={1.8} />,
    gateway: <Waypoints size={20} strokeWidth={1.8} />,
    operations: <Activity size={20} strokeWidth={1.8} />,
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

/** The one intentional pause between browser chrome and the restored surface. */
export function ApplicationBootScreen() {
  return (
    <div className="app-boot-screen" aria-busy="true" aria-live="polite">
      <DotGridField className="dot-grid-field--boot" />
      <div className="app-boot-stage">
        <div className="app-boot-orbit" aria-hidden="true">
          <span className="app-boot-orbit__ring app-boot-orbit__ring--outer" />
          <span className="app-boot-orbit__ring app-boot-orbit__ring--inner" />
          <span className="app-boot-orbit__node app-boot-orbit__node--one" />
          <span className="app-boot-orbit__node app-boot-orbit__node--two" />
          <span className="app-boot-mark"><BrandMark size={58} /></span>
        </div>
        <div className="app-boot-wordmark">
          <strong>OrcaSynapse</strong>
          <span>Private agentic intelligence</span>
        </div>
        <div className="app-boot-status">
          <span className="app-boot-progress" aria-hidden="true"><span /></span>
          <span>Initializing the intelligence fabric</span>
        </div>
      </div>
    </div>
  );
}

function connectionState(connection: ServiceConnectionSummary | undefined) {
  const state = connectionReadiness(connection);
  return { label: state.label, tone: state.tone };
}

/**
 * The sticky band above every screen: where you are, and the theme switch.
 * Blurred over the content it floats on, per the design's header treatment.
 */
function WorkspaceHeader({
  area,
  operator,
  onSignOut,
  immersive,
}: {
  area: string;
  operator: { initials: string; name: string; detail: string };
  onSignOut: () => void;
  /*
   * The Dashboard's command panel begins directly beneath this band. Immersive
   * keeps the header opaque on that same themed canvas so the sticky band and
   * the command surface read as one continuous field.
   */
  immersive: boolean;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const account = useRef<HTMLDivElement | null>(null);

  /*
   * A menu that outlives the click that opened it is a menu you cannot put
   * away, so it closes on an outside pointer and on Escape. `pointerdown`
   * rather than `click`, because a click that begins outside and ends inside
   * would otherwise leave it open.
   */
  useEffect(() => {
    if (!accountOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!account.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [accountOpen]);

  return (
    <header className={cn("workspace-header", immersive && "workspace-header--immersive")}>
      <div className="flex h-12 items-center gap-4">
        <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-text">{area}</span>
        <span className="flex-1" />
        <ThemeToggle />
        {/*
          * The account moved out of the rail and into the top-right corner.
          *
          * It sat at the foot of the sidebar, inside `.operator` -- which is
          * `display: none` below 760px, where the rail becomes a bottom bar.
          * Sign out was therefore unreachable on a phone: present in the markup,
          * hidden by a rule written for a layout that has no room for it. Here
          * it is reachable at every width, which is a fix rather than a move.
          */}
        <div className="relative flex items-center" ref={account}>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-2.5 py-1 pl-1 pr-2.5 text-left"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((open) => !open)}
          >
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-soft font-display text-micro font-semibold text-accent-strong"
            >
              {operator.initials}
            </span>
            <span className="hidden min-w-0 sm:block">
              <span className="block max-w-[150px] truncate text-caption font-semibold leading-tight text-text">
                {operator.name}
              </span>
              <span className="block max-w-[150px] truncate text-micro capitalize leading-tight text-faint">
                {operator.detail}
              </span>
            </span>
            <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-faint transition-transform", accountOpen && "rotate-180")} />
          </Button>
          {accountOpen && (
            <div
              className="absolute right-0 top-[calc(100%+8px)] z-50 grid min-w-[212px] gap-1 rounded-lg border border-border-strong bg-raised p-2 shadow-overlay"
              role="menu"
            >
              <div className="px-2 pb-1.5 pt-1">
                <span className="block truncate text-caption font-semibold text-text">{operator.name}</span>
                <span className="mt-0.5 block truncate text-micro capitalize text-faint">{operator.detail}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className="w-full justify-start px-2 text-caption"
                onClick={() => {
                  setAccountOpen(false);
                  onSignOut();
                }}
              >
                Sign out
              </Button>
            </div>
          )}
        </div>
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
  // The Dashboard hero reports what the deployment has actually done, so it
  // needs the three counts that live outside chat. Fetched beside the chat
  // figures and failing the same way: a metric that cannot be read is absent,
  // never zero.
  const [agentMetrics, setAgentMetrics] = useState<AgentMetrics | null>(null);
  const [toolMetrics, setToolMetrics] = useState<ToolMetrics | null>(null);
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
  const [minimumBootElapsed, setMinimumBootElapsed] = useState(false);
  const [drawerKind, setDrawerKind] = useState<ServiceKind>("INFERENCE");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ConnectionTestResult | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>(() => viewFromHash(window.location.hash));
  // Setup's open step is part of the address, not component state. It used to
  // be `deploymentInitialTab` here, which is why Back from the nodes panel left
  // Settings and a reload mid-enrolment returned to the overview.
  const [setupStep, setSetupStep] = useState<SetupStepKey | null>(() => setupStepFromHash(window.location.hash));
  const [revisionHistory, setRevisionHistory] = useState<ConfigurationRevisionList | null>(null);
  const [revisionConnectionId, setRevisionConnectionId] = useState<string | null>(null);
  const sessionGeneration = useRef(0);
  const activeNavigationItem = useRef<HTMLButtonElement | null>(null);

  /*
   * The session probes often complete quickly enough that the old lone mark
   * appeared as a flash rather than an intentional entrance. This timer runs
   * beside the probes rather than inside them: neither can delay the other,
   * and the shell opens as soon as both real state and one short brand cycle
   * are ready. Reduced-motion keeps a brief visual hand-off without asking the
   * operator to sit through the animated duration.
   */
  useEffect(() => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const timer = window.setTimeout(() => setMinimumBootElapsed(true), reducedMotion ? 240 : 1_400);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const item = activeNavigationItem.current;
    const container = item?.closest("nav");
    if (!item || !container || container.scrollWidth <= container.clientWidth) return;

    const centeredLeft = item.offsetLeft - (container.clientWidth - item.offsetWidth) / 2;
    container.scrollTo({ left: Math.max(0, centeredLeft), behavior: "auto" });
  }, [activeView]);

  useEffect(() => {
    const synchronizeRoute = () => {
      setActiveView(viewFromHash(window.location.hash));
      setSetupStep(setupStepFromHash(window.location.hash));
    };
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
            void getAgentMetrics().then((metrics) => {
              if (active && sessionGeneration.current === generation) setAgentMetrics(metrics);
            }).catch(() => undefined);
            void getToolMetrics().then((metrics) => {
              if (active && sessionGeneration.current === generation) setToolMetrics(metrics);
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
  // One definition of "may call admin routes", shared with every governed
  // view. The inline copy that used to live here was the same expression by
  // hand, which is how a shell and a screen start disagreeing about a session.
  const { unlocked } = adminAccess(adminSession);
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
  // Chat and Agents also serve enterprise identities, so an expiry
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
  const agentsUnlocked = unlocked || enterpriseSession?.scopes.includes("agents:use") === true;

  const refreshWorkspaceState = useCallback(async () => {
    const [connections, runtime, profiles, nodes, metrics, agents, tools] = await Promise.all([
      getConnections(),
      getAgentRuntime(),
      getAgentProfiles(true),
      getHermesRuntimeNodes(),
      getChatMetrics().catch(() => null),
      getAgentMetrics().catch(() => null),
      getToolMetrics().catch(() => null),
    ]);
    setManagedConnections(connections.items);
    setAgentRuntime(runtime);
    setAgentProfiles(profiles.items);
    setRuntimeNodes(nodes.items);
    if (metrics) setChatMetrics(metrics);
    if (agents) setAgentMetrics(agents);
    if (tools) setToolMetrics(tools);
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
      /*
       * The figures go with the state they describe. They used to survive a
       * lock, so an expired session left the Dashboard drawing the previous
       * administrator's tool and run counts beside em dashes for everything
       * else — the one arrangement that reads as live.
       */
      setChatMetrics(null);
      setAgentMetrics(null);
      setToolMetrics(null);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const [connections, runtime, profiles, nodes, metrics, agents, tools] = await Promise.all([
          getConnections(),
          getAgentRuntime(),
          getAgentProfiles(true),
          getHermesRuntimeNodes(),
          getChatMetrics().catch(() => null),
          // Fetched here rather than only at mount. `setAgentMetrics` and
          // `setToolMetrics` had one call site each, inside the session restore
          // that returns early when there is no cookie to restore, so half the
          // panel stayed blank for anyone who signed in inside the app.
          getAgentMetrics().catch(() => null),
          getToolMetrics().catch(() => null),
        ]);
        if (!active) return;
        setManagedConnections(connections.items);
        setAgentRuntime(runtime);
        setAgentProfiles(profiles.items);
        setRuntimeNodes(nodes.items);
        if (metrics) setChatMetrics(metrics);
        if (agents) setAgentMetrics(agents);
        if (tools) setToolMetrics(tools);
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
      setupStep: "inference" as const,
    },
    {
      label: "Isolated agent runtime",
      detail: readiness.runtimeNodeReady && readiness.hermesReady ? "VM2 is online and Hermes is reachable" : "Enroll VM2 and verify Hermes health",
      ready: readiness.runtimeNodeReady && readiness.hermesReady,
      action: "Deployment" as ActiveView,
      setupStep: "runtime" as const,
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
      selectView("Deployment", "runtime");
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
      /*
       * Read here as well as in the reconciler, exactly as the chat figures
       * are. The reconciler gathers seven calls with `Promise.all`, so it
       * cannot paint anything until the slowest of them lands — and one of
       * them is the agent runtime, which is the call that hangs when VM2 does.
       */
      void getAgentMetrics().then(setAgentMetrics).catch(() => setAgentMetrics(null));
      void getToolMetrics().then(setToolMetrics).catch(() => setToolMetrics(null));
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
        void getAgentMetrics().then(setAgentMetrics).catch(() => setAgentMetrics(null));
        void getToolMetrics().then(setToolMetrics).catch(() => setToolMetrics(null));
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

  const selectView = (view: ActiveView, step?: SetupStepKey) => {
    setActiveView(view);
    setSetupStep(view === "Deployment" ? step ?? null : null);

    /*
     * `pathForView` for every view, including Overview.
     *
     * Overview was special-cased to a literal `#home` so it could carry the
     * pathname and drop a stale query string. That made it the one route the
     * navigation table did not own — so when v3.5.0 renamed it to
     * `#dashboard`, the table changed and the address bar did not. Tests passed:
     * they exercise `pathForView`, which was right all along.
     */
    const target = `${window.location.pathname}${pathForView(view, view === "Deployment" ? step : null)}`;
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
    setAgentMetrics(null);
    setToolMetrics(null);
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
   * screen reports its Hermes responses from. Operations does not — nothing in
   * this component loads an incident total — so that
   * rows carry no badge at all rather than a plausible-looking figure. A badge
   * is read as a fact about the workspace, and an invented one is worse than an
   * absent one.
   */
  const navigationCounts: Partial<Record<ProductArea, number>> =
    chatMetrics && chatMetrics.conversations > 0 ? { Session: chatMetrics.conversations } : {};

  /*
   * One row, drawn the same way wherever it sits in the rail.
   *
   * Settings was the exception and the exception is what went wrong with it:
   * its own markup, its own height, its own muted white, and a second copy for
   * the phone dock. A single renderer means "Settings looks like the others"
   * is not a thing anyone has to keep true — the collapsed rail's
   * `.sidebar nav button` rules and the dock's `.nav-app-icon` tile already
   * reach every row in here, and now they reach that one too.
   */
  const renderNavigationRow = ({ area, icon, target, description }: PrimaryNavigationItem) => {
    const active = area === activeArea;
    const count = navigationCounts[area];
    return (
      <Button
        variant="ghost"
        /*
         * White on the brand violet, per the design: the active row is a soft
         * white fill at full white and semibold; inactive rows keep a
         * near-white label and lose their weight. Tokens would be wrong for
         * the text — the rail's background never themes, so its foreground
         * must not either. The description lives in the tooltip; the row
         * itself is one line.
         */
        className={cn(
          "h-10 w-full justify-start gap-3 border-transparent px-3 text-left font-sans text-[14.5px]",
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
          * The glyph is the one thing on the row that is *not* the label's
          * colour: bright accent when the row is active, muted lavender when
          * it is not, so the icon column reads as a second, quieter rank.
          *
          * The two descendant selectors put the Relay set's cyan "live node"
          * back on `currentColor` for the duration of the rail. That accent is
          * meant to appear once per composition; one on every row stacked down
          * the sidebar was the loudest thing on the screen, and it also
          * defeated the active/muted tinting, because the dot stayed cyan
          * whether the row was selected or not.
          */}
        <span
          className={cn(
            "nav-app-icon flex shrink-0 [&_.fill-node]:fill-current [&_.stroke-node]:stroke-current",
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
      </Button>
    );
  };

  /*
   * Three mutually exclusive surfaces, decided only once the session probes
   * have answered: the splash (a beat of brand violet, never the wrong page),
   * the front page (no session at all, or a session that must change its
   * password before it counts), and the workspace shell. Enterprise-only
   * sessions get the shell exactly as before — the front page is strictly the
   * signed-out and must-change surface.
   */
  if (!sessionRestored || !minimumBootElapsed) {
    return <ApplicationBootScreen />;
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
        {/* The same unboxed white mark anchors both rail widths; collapse only hides the wordmark. */}
        <div className="-mt-5 mb-5 flex h-16 shrink-0 items-center gap-2.5 px-1 max-[760px]:hidden">
          <span aria-hidden="true" className="sidebar-brand-mark grid shrink-0 place-items-center">
            <BrandMark size={38} />
          </span>
          <strong className="font-display text-[18px] font-bold leading-none tracking-[-0.01em] text-white">OrcaSynapse</strong>
        </div>
        <nav aria-label="Primary navigation">
          {/*
            * One flat list of primary work areas, not two labelled groups: the
            * design draws them as a single run. The grouping still lives in
            * `workspace-navigation.tsx` because that is where the product
            * split is described — this only declines to draw a heading for it.
            */}
          <div className="nav-group">{primaryNavigationItems("top").map(renderNavigationRow)}</div>
          {/*
            * Settings, last in the same menu rather than a slab bolted beneath
            * it. It used to be drawn twice — an edge-to-edge footer row for the
            * rail, plus a duplicate hidden inside this nav that only the phone
            * dock revealed — so it was the one area whose height, padding,
            * hover and active fill were maintained in two places, and while it
            * was the active area both copies claimed `activeNavigationItem`.
            * The only thing this group still does differently is sit at the
            * bottom, and it does that in CSS, through one auto margin.
            */}
          <div className="nav-group nav-group--bottom">{primaryNavigationItems("bottom").map(renderNavigationRow)}</div>
        </nav>
        <div className="sidebar-bottom">
          {/*
            * The control that sets the rail's width lives in the rail.
            *
            * Hidden below 760px on purpose: down there the rail is already a
            * fixed bottom bar with no width to collapse, and the same media
            * guard keeps `.app-shell--focus` off that layout.
            */}
          <Button
            variant="ghost"
            className="sidebar-collapse-button h-12 w-full justify-start gap-3 rounded-none border-transparent px-4 text-left font-sans text-[13px] font-medium text-white/70 hover:bg-white/[0.06] hover:text-white max-[760px]:hidden"
            onClick={() => {
              const next = !railCollapsed;
              setRailCollapsed(next);
              persistRailCollapsed(next);
            }}
            aria-expanded={!railCollapsed}
            aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span aria-hidden="true" className="sidebar-collapse-icon grid h-8 w-8 shrink-0 place-items-center text-white/55">
              {railCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{railCollapsed ? "Expand" : "Collapse"}</span>
          </Button>
          {/* The operator block that lived here is now the account chip in the
              top bar, where it is reachable at every width. */}
        </div>
      </aside>

      <main
        className={cn(
          activeView === "Chat" && "chat-page",
          activeView === "Overview" && "dashboard-page",
        )}
      >
        <div className="mobile-brand"><BrandMark size={26} /><strong>OrcaSynapse</strong></div>
        <WorkspaceHeader area={activeArea} operator={operator} onSignOut={() => void signOut()} immersive={activeView === "Overview"} />
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
              // The session itself, not only a boolean drawn from it: the view
              // gates six mutating controls on the scopes it carries, and
              // without this prop that gating falls back to the old
              // all-or-nothing boolean and does nothing at all.
              session={adminSession}
              // `unlocked` from `adminAccess`, not `adminSession !== null`: a
              // session pending a forced password change is signed in and
              // refused by every admin route, so the two are not the same test.
              administrator={unlocked}
              activationReady={unlocked ? readiness.agenticInfrastructureReady && readiness.inferenceReady : null}
              activationMessage={readiness.nextChatStep?.detail ?? null}
              oidcConfigured={oidcStatus?.configured === true}
              onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23agents%2Fprofiles")}
              onConfigure={() => openConnectionSettings("HERMES")}
              onOpenChat={() => {
                void refreshWorkspaceState().catch(() => undefined);
                selectView("Chat");
              }}
              onOpenReadiness={() => selectView("Deployment", "runtime")}
              onSessionExpired={forgetAnySession}
            />
          ),
          /*
           * `key` is what makes the scope change a remount rather than a prop
           * update. Both entries render the same component at the same position,
           * so React would otherwise keep the mounted instance and hold the
           * previous tab's entries and selection on screen until the debounced
           * refetch landed.
           */
          Skills: () => (
            <CorpusView
              key="corpus-skills"
              scope="SKILLS"
              session={adminSession}
              onConfigure={() => openConnectionSettings()}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Memory: () => (
            <CorpusView
              key="corpus-memory"
              scope="MEMORY"
              session={adminSession}
              onConfigure={() => openConnectionSettings()}
              onSessionExpired={forgetAdminSession}
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
              session={adminSession}
              connections={managedConnections}
              agentRuntime={agentRuntime}
              profiles={agentProfiles}
              runtimeNodes={runtimeNodes}
              oidcConfigured={oidcStatus?.administratorSignIn === true}
              initialStep={setupStep}
              onSelectStep={(step) => selectView("Deployment", step)}
              onConfigure={(kind) => openConnectionSettings(kind)}
              onOpenWorkspace={(workspace) => selectView(workspace)}
              onRuntimeNodesChange={setRuntimeNodes}
              onOpenOperations={() => selectView("Operations")}
              onSignIn={() => window.location.assign("/api/v1/auth/oidc/start?returnTo=%2F%23settings%2Fsetup")}
              onSessionExpired={forgetAdminSession}
            />
          ),
          Application: () => (
            <ApplicationView
              session={adminSession}
              currentVersion={platform?.version ?? "unknown"}
              onConfigure={() => openConnectionSettings()}
              onOpenOperations={() => selectView("Operations")}
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
          Overview: () => (
            <HomeView
              apiAvailable={apiAvailable}
              bootstrapState={bootstrapState}
              unlocked={unlocked}
              healthyConnections={healthyConnections}
              monitoring={connectionMonitoring}
              chatMetrics={chatMetrics}
              agentMetrics={agentMetrics}
              toolMetrics={toolMetrics}
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
