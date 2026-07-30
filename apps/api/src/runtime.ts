import {
  createPrismaClient,
  hasBootstrapSecret,
  readBootstrapSecret,
  type AIHubPrismaClient,
} from "@aihub/database";
import { decodeMasterKey, EnvelopeEncryption } from "@aihub/security";
import { BootstrapTokenAuthenticator } from "./auth/bootstrap-auth.js";
import {
  PrismaAdminSessionManager,
  type AdminSessionManager,
} from "./auth/admin-session.js";
import type { ConnectionManager } from "./connections/connection-manager.js";
import { PrismaConnectionManager } from "./connections/prisma-connection-manager.js";
import { ConnectionTestService } from "./connections/diagnostics/connection-test-service.js";
import { ConnectionMonitorRuntime, type ConnectionMonitorService } from "./connections/connection-monitor.js";
import { PgBossQueueService } from "@aihub/jobs";
import type { OperationsManager } from "./operations/operations-manager.js";
import { PrismaOperationsManager } from "./operations/prisma-operations-manager.js";
import type { ChatManager } from "./chat/chat-manager.js";
import { PrismaChatManager } from "./chat/prisma-chat-manager.js";
import {
  PrismaEnterpriseIdentityManager,
  type EnterpriseIdentityManager,
} from "./identity/enterprise-session.js";
import {
  PrismaRuntimeConnectionResolver,
  HermesClient,
  SeaweedDocumentStore,
  SupermemoryClient,
} from "@aihub/document-runtime";
import type { DocumentManager } from "./documents/document-manager.js";
import { PrismaDocumentManager } from "./documents/prisma-document-manager.js";
import { SupermemoryKnowledgeRetriever } from "./chat/knowledge-retriever.js";
import type { MemoryManager } from "./memory/memory-manager.js";
import { PrismaMemoryManager } from "./memory/prisma-memory-manager.js";
import type { AgentManager } from "./agents/agent-manager.js";
import { PrismaAgentManager } from "./agents/prisma-agent-manager.js";
import type { ToolingManager } from "./tooling/tooling-manager.js";
import { PrismaToolingManager } from "./tooling/prisma-tooling-manager.js";
import type { AiOpsManager } from "./ai-ops/ai-ops-manager.js";
import { PrismaAiOpsManager } from "./ai-ops/prisma-ai-ops-manager.js";
import type { ModelManager } from "./models/model-manager.js";
import { PrismaModelManager } from "./models/prisma-model-manager.js";
import type { GuardrailManager } from "./guardrails/guardrail-manager.js";
import { PrismaGuardrailManager } from "./guardrails/prisma-guardrail-manager.js";
import type { PromptManager } from "./prompts/prompt-manager.js";
import { PrismaPromptManager } from "./prompts/prisma-prompt-manager.js";

export type BootstrapState = "REQUIRED" | "READY" | "LOCKED";

export interface RuntimeServices {
  bootstrapState: BootstrapState;
  sessionManager?: AdminSessionManager;
  connectionManager?: ConnectionManager;
  connectionTestService?: ConnectionTestService;
  connectionMonitor?: ConnectionMonitorService;
  operationsManager?: OperationsManager;
  chatManager?: ChatManager;
  identityManager?: EnterpriseIdentityManager;
  documentManager?: DocumentManager;
  memoryManager?: MemoryManager;
  modelManager?: ModelManager;
  guardrailManager?: GuardrailManager;
  promptManager?: PromptManager;
  agentManager?: AgentManager;
  toolingManager?: ToolingManager;
  aiOpsManager?: AiOpsManager;
  prisma?: AIHubPrismaClient;
}

export function getBootstrapState(): BootstrapState {
  const names = ["aihub_database_url", "aihub_master_key", "aihub_bootstrap_token"] as const;
  const available = names.map((name) => hasBootstrapSecret(name));

  if (available.every((value) => !value)) return "REQUIRED";
  if (!available.every(Boolean)) return "LOCKED";

  try {
    const databaseUrl = new URL(readBootstrapSecret("aihub_database_url"));
    if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") {
      return "LOCKED";
    }
    decodeMasterKey(readBootstrapSecret("aihub_master_key"));
    if (readBootstrapSecret("aihub_bootstrap_token").length < 32) return "LOCKED";
    return "READY";
  } catch {
    return "LOCKED";
  }
}

export function createRuntimeServices(): RuntimeServices {
  const bootstrapState = getBootstrapState();
  if (bootstrapState !== "READY") return { bootstrapState };

  try {
    const databaseUrl = readBootstrapSecret("aihub_database_url");
    const prisma = createPrismaClient(databaseUrl);
    const encryption = new EnvelopeEncryption({
      masterKey: decodeMasterKey(readBootstrapSecret("aihub_master_key")),
    });
    const authenticator = new BootstrapTokenAuthenticator(
      readBootstrapSecret("aihub_bootstrap_token"),
    );

    const connectionManager = new PrismaConnectionManager(prisma, encryption);
    const connectionTestService = new ConnectionTestService(connectionManager);
    const connectionMonitor = new ConnectionMonitorRuntime(
      prisma,
      connectionTestService,
      { error: (message, error) => console.error(message, error) },
    );
    const sessionManager = new PrismaAdminSessionManager(prisma, authenticator);
    const queue = new PgBossQueueService(databaseUrl, "api", {
      error: (message, error) => console.error(message, error),
      warn: (message, details) => console.warn(message, details),
    });
    const operationsManager = new PrismaOperationsManager(prisma, queue);
    const documentResolver = new PrismaRuntimeConnectionResolver(prisma, encryption);
    const memoryManager = new PrismaMemoryManager(prisma, queue);
    const modelManager = new PrismaModelManager(prisma);
    const guardrailManager = new PrismaGuardrailManager(prisma);
    const promptManager = new PrismaPromptManager(prisma);
    const chatManager = new PrismaChatManager(
      prisma,
      connectionManager,
      undefined,
      new SupermemoryKnowledgeRetriever(prisma, new SupermemoryClient(documentResolver)),
    );
    const documentManager = new PrismaDocumentManager(
      prisma,
      new SeaweedDocumentStore(documentResolver),
      queue,
    );
    const agentManager = new PrismaAgentManager(prisma, queue, new HermesClient(documentResolver));
    const toolingManager = new PrismaToolingManager(prisma);
    const aiOpsManager = new PrismaAiOpsManager(prisma, {
      connections: connectionManager,
      connectionMonitoring: connectionMonitor,
      models: modelManager,
      jobs: operationsManager,
      chat: chatManager,
      documents: documentManager,
      memory: memoryManager,
      agents: agentManager,
      tools: toolingManager,
    });
    return {
      bootstrapState,
      prisma,
      sessionManager,
      connectionManager,
      connectionTestService,
      connectionMonitor,
      operationsManager,
      chatManager,
      identityManager: new PrismaEnterpriseIdentityManager(
        prisma,
        connectionManager,
        encryption,
      ),
      documentManager,
      memoryManager,
      modelManager,
      guardrailManager,
      promptManager,
      agentManager,
      toolingManager,
      aiOpsManager,
    };
  } catch {
    return { bootstrapState: "LOCKED" };
  }
}
