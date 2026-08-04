import {
  createDrizzleClient,
  createPrismaClient,
  hasBootstrapSecret,
  readBootstrapSecret,
  type OrcaSynapseDatabase,
  type OrcaSynapsePrismaClient,
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
import { ConnectionMonitorRuntime, type ConnectionMonitorService } from "./connections/connection-monitor.js";
import type { OperationsManager } from "./operations/operations-manager.js";
import { DrizzleOperationsManager } from "./operations/drizzle-operations-manager.js";
import type { ChatManager } from "./chat/chat-manager.js";
import { PrismaChatManager } from "./chat/prisma-chat-manager.js";
import {
  DrizzleEnterpriseIdentityManager,
  type EnterpriseIdentityManager,
} from "./identity/enterprise-session.js";
import { DrizzleRuntimeConnectionResolver, HermesClient } from "@orcasynapse/runtime-clients";
import {
  APPROVED_EMBEDDING_MODEL,
  DocumentVectorStore,
  LocalBgeM3Embedder,
} from "@orcasynapse/knowledge";
import type { DocumentManager } from "./documents/document-manager.js";
import { DrizzleDocumentManager } from "./documents/drizzle-document-manager.js";
import type { AgentManager } from "./agents/agent-manager.js";
import { DrizzleAgentManager } from "./agents/drizzle-agent-manager.js";
import type { ToolingManager } from "./tooling/tooling-manager.js";
import { DrizzleToolingManager } from "./tooling/drizzle-tooling-manager.js";
import type { AiOpsManager } from "./ai-ops/ai-ops-manager.js";
import { PrismaAiOpsManager } from "./ai-ops/prisma-ai-ops-manager.js";
import type { ModelManager } from "./models/model-manager.js";
import { DrizzleModelManager } from "./models/drizzle-model-manager.js";
import type { GuardrailManager } from "./guardrails/guardrail-manager.js";
import { DrizzleGuardrailManager } from "./guardrails/drizzle-guardrail-manager.js";
import type { PromptManager } from "./prompts/prompt-manager.js";
import { DrizzlePromptManager } from "./prompts/drizzle-prompt-manager.js";
import type { OnboardingManager } from "./onboarding/onboarding-manager.js";
import { DrizzleOnboardingManager } from "./onboarding/drizzle-onboarding-manager.js";
import type { HermesRuntimeNodeManager } from "./runtime-nodes/runtime-node-manager.js";
import { DrizzleHermesRuntimeNodeManager } from "./runtime-nodes/drizzle-runtime-node-manager.js";
import { DrizzleInferenceGateway } from "./inference/inference-gateway.js";

export type BootstrapState = "REQUIRED" | "READY" | "LOCKED";

export interface RuntimeServices {
  bootstrapState: BootstrapState;
  sessionManager?: AdminSessionManager;
  connectionManager?: ConnectionManager;
  connectionTestService?: ConnectionTestService;
  inferenceDiscoveryService?: InferenceDiscoveryService;
  connectionMonitor?: ConnectionMonitorService;
  operationsManager?: OperationsManager;
  chatManager?: ChatManager;
  identityManager?: EnterpriseIdentityManager;
  documentManager?: DocumentManager;
  modelManager?: ModelManager;
  guardrailManager?: GuardrailManager;
  promptManager?: PromptManager;
  agentManager?: AgentManager;
  toolingManager?: ToolingManager;
  aiOpsManager?: AiOpsManager;
  onboardingManager?: OnboardingManager;
  runtimeNodeManager?: HermesRuntimeNodeManager;
  inferenceGateway?: DrizzleInferenceGateway;
  prisma?: OrcaSynapsePrismaClient;
  database?: OrcaSynapseDatabase;
  /** Closes the Drizzle pool. Prisma is torn down through its own client. */
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

  try {
    const databaseUrl = readBootstrapSecret("orcasynapse_database_url");
    const prisma = createPrismaClient(databaseUrl);
    const { database, close: closeDatabase } = createDrizzleClient(databaseUrl);
    const masterKey = decodeMasterKey(readBootstrapSecret("orcasynapse_master_key"));
    const encryption = new EnvelopeEncryption({ masterKey });
    const authenticator = new InstallationKeyAuthenticator(
      readBootstrapSecret("orcasynapse_installation_key"),
    );

    const connectionManager = new DrizzleConnectionManager(database, encryption);
    const connectionTestService = new ConnectionTestService(connectionManager);
    const inferenceDiscoveryService = new InferenceDiscoveryService(connectionManager);
    const connectionMonitor = new ConnectionMonitorRuntime(
      database,
      connectionTestService,
      { error: (message, error) => console.error(message, error) },
    );
    const sessionManager = new DrizzleAdminSessionManager(database, authenticator);
    const operationsManager = new DrizzleOperationsManager(database);
    const documentResolver = new DrizzleRuntimeConnectionResolver(database, encryption);
    const modelManager = new DrizzleModelManager(database);
    const guardrailManager = new DrizzleGuardrailManager(database);
    const promptManager = new DrizzlePromptManager(database);
    const documentManager = new DrizzleDocumentManager(
      database,
      new DocumentVectorStore(database, APPROVED_EMBEDDING_MODEL),
      new LocalBgeM3Embedder(),
    );
    const hermesClient = new HermesClient(documentResolver);
    const agentManager = new DrizzleAgentManager(database, hermesClient);
    const chatManager = new PrismaChatManager(prisma, agentManager);
    const toolingManager = new DrizzleToolingManager(database, hermesClient);
    const aiOpsManager = new PrismaAiOpsManager(prisma, {
      connections: connectionManager,
      connectionMonitoring: connectionMonitor,
      models: modelManager,
      runtime: operationsManager,
      chat: chatManager,
      documents: documentManager,
      agents: agentManager,
      tools: toolingManager,
    });
    const onboardingManager = new DrizzleOnboardingManager(database, masterKey, aiOpsManager);
    const runtimeNodeManager = new DrizzleHermesRuntimeNodeManager(database, encryption, connectionTestService);
    const inferenceGateway = new DrizzleInferenceGateway(database, connectionManager);
    return {
      bootstrapState,
      prisma,
      database,
      closeDatabase,
      sessionManager,
      connectionManager,
      connectionTestService,
      inferenceDiscoveryService,
      connectionMonitor,
      operationsManager,
      chatManager,
      identityManager: new DrizzleEnterpriseIdentityManager(
        database,
        connectionManager,
        encryption,
        fetch,
        sessionManager,
      ),
      documentManager,
      modelManager,
      guardrailManager,
      promptManager,
      agentManager,
      toolingManager,
      aiOpsManager,
      onboardingManager,
      runtimeNodeManager,
      inferenceGateway,
    };
  } catch (error) {
    const failure = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
    console.error("OrcaSynapse runtime initialization failed; the control plane is locked.", {
      errorName: typeof failure.name === "string" ? failure.name.slice(0, 80) : "UnknownError",
      errorCode: typeof failure.code === "string" ? failure.code.slice(0, 80) : undefined,
    });
    return { bootstrapState: "LOCKED" };
  }
}
