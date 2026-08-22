import {
  createChatRunWakeHub,
  createDrizzleClient,
  hasBootstrapSecret,
  readBootstrapSecret,
  type ChatRunWakeHub,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { decodeMasterKey, EnvelopeEncryption } from "@orcasynapse/security";
import { InstallationKeyAuthenticator } from "./auth/installation-key-auth.js";
import {
  DrizzleAdminSessionManager,
  type AdminSessionManager,
} from "./auth/admin-session.js";
import type { ConnectionManager } from "./connections/connection-manager.js";
import { DrizzleConnectionManager } from "./connections/drizzle-connection-manager.js";
import { ConnectionTestService } from "./connections/diagnostics/connection-test-service.js";
import { InferenceDiscoveryService } from "./connections/diagnostics/inference-discovery-service.js";
import { InferenceCatalogueService } from "./connections/diagnostics/inference-catalogue-service.js";
import { ConnectionMonitorRuntime, type ConnectionMonitorService } from "./connections/connection-monitor.js";
import type { OperationsManager } from "./operations/operations-manager.js";
import { DrizzleOperationsManager } from "./operations/drizzle-operations-manager.js";
import type { ChatManager } from "./chat/chat-manager.js";
import { DrizzleChatManager } from "./chat/drizzle-chat-manager.js";
import { ScheduleRuntime } from "./chat/schedule-runtime.js";
import {
  DrizzleEnterpriseIdentityManager,
  type EnterpriseIdentityManager,
} from "./identity/enterprise-session.js";
import { DrizzleRuntimeConnectionResolver, HermesClient } from "@orcasynapse/runtime-clients";
import type { AgentManager } from "./agents/agent-manager.js";
import { DrizzleAgentManager } from "./agents/drizzle-agent-manager.js";
import type { ToolingManager } from "./tooling/tooling-manager.js";
import { DrizzleToolingManager } from "./tooling/drizzle-tooling-manager.js";
import type { AiOpsManager } from "./ai-ops/ai-ops-manager.js";
import { DrizzleAiOpsManager } from "./ai-ops/drizzle-ai-ops-manager.js";
import type { ModelManager } from "./models/model-manager.js";
import { DrizzleModelManager } from "./models/drizzle-model-manager.js";
import { InferenceRefreshService } from "./models/inference-refresh-service.js";
import type { GuardrailManager } from "./guardrails/guardrail-manager.js";
import { DrizzleGuardrailManager } from "./guardrails/drizzle-guardrail-manager.js";
import { DrizzleAuditManager, type AuditManager } from "./audit/audit-manager.js";
import { DrizzlePersonManager } from "./people/drizzle-person-manager.js";
import type { DivisionManager } from "./divisions/division-manager.js";
import { DrizzleDivisionManager } from "./divisions/drizzle-division-manager.js";
import type { ConfigurationSetManager } from "./configuration-sets/configuration-set-manager.js";
import { DrizzleConfigurationSetManager } from "./configuration-sets/drizzle-configuration-set-manager.js";
import type { PromptManager } from "./prompts/prompt-manager.js";
import { DrizzlePromptManager } from "./prompts/drizzle-prompt-manager.js";
import type { OnboardingManager } from "./onboarding/onboarding-manager.js";
import { DrizzleOnboardingManager } from "./onboarding/drizzle-onboarding-manager.js";
import type { HermesRuntimeNodeManager } from "./runtime-nodes/runtime-node-manager.js";
import { DrizzleHermesRuntimeNodeManager } from "./runtime-nodes/drizzle-runtime-node-manager.js";
import { DrizzleInferenceGateway } from "./inference/inference-gateway.js";
import type { ChatArtifactManager } from "./artifacts/artifact-manager.js";
import { DrizzleChatArtifactManager } from "./artifacts/drizzle-artifact-manager.js";
import type { HermesCorpusManager } from "./corpus/corpus-manager.js";
import { DrizzleHermesCorpusManager } from "./corpus/drizzle-corpus-manager.js";
import type { PlatformReleaseTargetManager } from "./updates/release-target-manager.js";
import { DrizzlePlatformReleaseTargetManager } from "./updates/drizzle-release-target-manager.js";
import type { UsageManager } from "./usage/usage-manager.js";
import { DrizzleUsageManager } from "./usage/drizzle-usage-manager.js";

export type BootstrapState = "REQUIRED" | "READY" | "LOCKED";

export interface RuntimeServices {
  bootstrapState: BootstrapState;
  sessionManager?: AdminSessionManager;
  connectionManager?: ConnectionManager;
  connectionTestService?: ConnectionTestService;
  inferenceDiscoveryService?: InferenceDiscoveryService;
  inferenceCatalogueService?: InferenceCatalogueService;
  inferenceRefreshService?: InferenceRefreshService;
  connectionMonitor?: ConnectionMonitorService;
  operationsManager?: OperationsManager;
  chatManager?: ChatManager;
  scheduleRuntime?: ScheduleRuntime;
  identityManager?: EnterpriseIdentityManager;
  modelManager?: ModelManager;
  guardrailManager?: GuardrailManager;
  promptManager?: PromptManager;
  configurationSetManager?: ConfigurationSetManager;
  divisionManager?: DivisionManager;
  personManager?: DrizzlePersonManager;
  auditManager?: AuditManager;
  usageManager?: UsageManager;
  agentManager?: AgentManager;
  toolingManager?: ToolingManager;
  aiOpsManager?: AiOpsManager;
  onboardingManager?: OnboardingManager;
  runtimeNodeManager?: HermesRuntimeNodeManager;
  corpusManager?: HermesCorpusManager;
  artifactManager?: ChatArtifactManager;
  releaseTargetManager?: PlatformReleaseTargetManager;
  inferenceGateway?: DrizzleInferenceGateway;
  database?: OrcaSynapseDatabase;
  /** Closes the single connection pool the control plane opens. */
  closeDatabase?: () => Promise<void>;
}

export function getBootstrapState(): BootstrapState {
  const names = ["orcasynapse_database_url", "orcasynapse_master_key", "orcasynapse_installation_key"] as const;
  const available = names.map((name) => hasBootstrapSecret(name));

  if (available.every((value) => !value)) return "REQUIRED";
  if (!available.every(Boolean)) return "LOCKED";

  try {
    const databaseUrl = new URL(readBootstrapSecret("orcasynapse_database_url"));
    if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") {
      return "LOCKED";
    }
    decodeMasterKey(readBootstrapSecret("orcasynapse_master_key"));
    if (readBootstrapSecret("orcasynapse_installation_key").length < 32) return "LOCKED";
    return "READY";
  } catch {
    return "LOCKED";
  }
}

export function createRuntimeServices(): RuntimeServices {
  const bootstrapState = getBootstrapState();
  if (bootstrapState !== "READY") return { bootstrapState };

  // Held outside the try so a failure further down can release it. The pool
  // itself is a pre-existing leak on this path and is left alone; this is only
  // about not making it two connections instead of one.
  let chatWake: ChatRunWakeHub | null = null;
  try {
    const databaseUrl = readBootstrapSecret("orcasynapse_database_url");
    const { database, close: closePool } = createDrizzleClient(databaseUrl);
    const masterKey = decodeMasterKey(readBootstrapSecret("orcasynapse_master_key"));
    const encryption = new EnvelopeEncryption({ masterKey });
    const authenticator = new InstallationKeyAuthenticator(
      readBootstrapSecret("orcasynapse_installation_key"),
    );

    const connectionManager = new DrizzleConnectionManager(database, encryption);
    const connectionTestService = new ConnectionTestService(connectionManager);
    const inferenceDiscoveryService = new InferenceDiscoveryService(connectionManager);
    const inferenceCatalogueService = new InferenceCatalogueService();
    const connectionMonitor = new ConnectionMonitorRuntime(
      database,
      connectionTestService,
      { error: (message, error) => console.error(message, error) },
    );
    const sessionManager = new DrizzleAdminSessionManager(database, authenticator);
    const operationsManager = new DrizzleOperationsManager(database);
    const connectionResolver = new DrizzleRuntimeConnectionResolver(database, encryption);
    const modelManager = new DrizzleModelManager(database);
    const inferenceRefreshService = new InferenceRefreshService(connectionManager, modelManager);
    const guardrailManager = new DrizzleGuardrailManager(database);
    const promptManager = new DrizzlePromptManager(database);
    const configurationSetManager = new DrizzleConfigurationSetManager(database);
    const divisionManager = new DrizzleDivisionManager(database);
    const personManager = new DrizzlePersonManager(database);
    const auditManager = new DrizzleAuditManager(database);
    const usageManager = new DrizzleUsageManager(database);
    const hermesClient = new HermesClient(connectionResolver);
    const agentManager = new DrizzleAgentManager(database, hermesClient);
    /*
     * Accelerates every chat stream this process serves, from one connection.
     *
     * Constructed late so a failure anywhere above it cannot leave a listen
     * connection open beside the pool. Connecting happens in the background:
     * until it is up, and again if it drops, subscribers fall back to their own
     * poll interval and are told nothing, because there is nothing they would
     * do differently.
     */
    chatWake = createChatRunWakeHub(databaseUrl, (error) =>
      console.error("OrcaSynapse chat wake channel error.", error));
    const chatManager = new DrizzleChatManager(database, agentManager, chatWake, hermesClient);
    const scheduleRuntime = new ScheduleRuntime(database, chatManager, {
      info: (message) => console.info(message),
      error: (message, error) => console.error(message, error),
    });
    const toolingManager = new DrizzleToolingManager(database, hermesClient);
    const aiOpsManager = new DrizzleAiOpsManager(database, {
      connections: connectionManager,
      connectionMonitoring: connectionMonitor,
      models: modelManager,
      runtime: operationsManager,
      chat: chatManager,
      agents: agentManager,
      tools: toolingManager,
    });
    const onboardingManager = new DrizzleOnboardingManager(database, masterKey, aiOpsManager);
    // The Hermes client doubles as the catalogue reader: enrolment admits the
    // toolsets the node reports, so a fresh install is usable without an
    // operator admitting each one by hand.
    const runtimeNodeManager = new DrizzleHermesRuntimeNodeManager(database, encryption, connectionTestService);
    const corpusManager = new DrizzleHermesCorpusManager(database, runtimeNodeManager);
    const artifactManager = new DrizzleChatArtifactManager(database, runtimeNodeManager);
    const releaseTargetManager = new DrizzlePlatformReleaseTargetManager(database);
    const inferenceGateway = new DrizzleInferenceGateway(database, connectionManager);
    return {
      bootstrapState,
      database,
      // Composed rather than exposed separately, so both existing shutdown
      // paths close the listen connection before the pool by construction, and
      // no future edit can get that sequence wrong.
      closeDatabase: async () => {
        await chatWake?.stop();
        await closePool();
      },
      sessionManager,
      connectionManager,
      connectionTestService,
      inferenceDiscoveryService,
      inferenceCatalogueService,
      inferenceRefreshService,
      connectionMonitor,
      operationsManager,
      chatManager,
      scheduleRuntime,
      identityManager: new DrizzleEnterpriseIdentityManager(database),
      modelManager,
      guardrailManager,
      promptManager,
      configurationSetManager,
      divisionManager,
      personManager,
      auditManager,
      usageManager,
      agentManager,
      toolingManager,
      aiOpsManager,
      onboardingManager,
      runtimeNodeManager,
      corpusManager,
      artifactManager,
      releaseTargetManager,
      inferenceGateway,
    };
  } catch (error) {
    const failure = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
    console.error("OrcaSynapse runtime initialization failed; the control plane is locked.", {
      errorName: typeof failure.name === "string" ? failure.name.slice(0, 80) : "UnknownError",
      errorCode: typeof failure.code === "string" ? failure.code.slice(0, 80) : undefined,
    });
    void chatWake?.stop().catch(() => undefined);
    return { bootstrapState: "LOCKED" };
  }
}
