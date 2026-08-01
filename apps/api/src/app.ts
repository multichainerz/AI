import {
  healthResponseSchema,
  platformMetaSchema,
  SERVICE_KINDS,
} from "@aihub/contracts";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import { registerConnectionRoutes } from "./connections/routes.js";
import { createRuntimeServices, type RuntimeServices } from "./runtime.js";
import { registerOperationsRoutes } from "./operations/routes.js";
import { registerAdminSessionRoutes } from "./auth/routes.js";
import { registerChatMetricsRoutes, registerChatRoutes } from "./chat/routes.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import { registerDocumentRoutes } from "./documents/routes.js";
import { registerMemoryRoutes } from "./memory/routes.js";
import { registerAdminAgentRoutes, registerAgentRoutes } from "./agents/routes.js";
import { registerAdminToolingRoutes, registerMcpGatewayRoutes } from "./tooling/routes.js";
import { registerAiOpsRoutes } from "./ai-ops/routes.js";
import { registerModelRoutes } from "./models/routes.js";
import { registerGuardrailRoutes } from "./guardrails/routes.js";
import { registerPromptRoutes } from "./prompts/routes.js";
import { registerOnboardingRoutes } from "./onboarding/routes.js";
import { registerAdminRuntimeNodeRoutes, registerRuntimeNodeRoutes } from "./runtime-nodes/routes.js";
import { registerInferenceGatewayRoutes } from "./inference/routes.js";

export interface AppOptions {
  logger?: boolean;
  runtime?: RuntimeServices;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const runtime = options.runtime ?? createRuntimeServices();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: "info",
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.body.secrets",
                "req.body.secrets.*",
                "req.body.password",
                "req.body.apiKey",
                "req.body.token",
                "req.body.passphrase",
                "req.body.serializedKit",
              ],
              censor: "[REDACTED]",
            },
          },
    // AIHub's Compose topology exposes only the adjacent Nginx proxy. Trusting
    // exactly one hop prevents client-supplied forwarding chains from becoming
    // security or audit metadata.
    trustProxy: 1,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    if (
      request.url.startsWith("/api/v1/admin/") ||
      request.url.startsWith("/api/v1/chat/") ||
      request.url.startsWith("/api/v1/session") ||
      request.url.startsWith("/api/v1/auth/oidc/") ||
      request.url.startsWith("/api/v1/documents")
      || request.url.startsWith("/api/v1/agents")
      || request.url.startsWith("/api/v1/mcp")
      || request.url.startsWith("/api/v1/runtime-nodes")
      || request.url.startsWith("/internal/v1/")
    ) {
      void reply.header("cache-control", "no-store");
    }
    return payload;
  });

  if (runtime.prisma || runtime.operationsManager || runtime.connectionMonitor) {
    app.addHook("onClose", async () => {
      try {
        await runtime.connectionMonitor?.stop();
      } finally {
        try {
          await runtime.operationsManager?.stop();
        } finally {
          await runtime.prisma?.$disconnect();
        }
      }
    });
  }

  if (runtime.operationsManager) {
    try {
      await runtime.operationsManager.start();
    } catch (error) {
      await Promise.allSettled([
        runtime.operationsManager.stop(),
        runtime.prisma?.$disconnect() ?? Promise.resolve(),
      ]);
      throw error;
    }
  }

  if (runtime.connectionMonitor) {
    await runtime.connectionMonitor.start();
  }

  app.get("/healthz", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return healthResponseSchema.parse({
      status: "ok",
      service: "aihub-api",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/readyz", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    const response = (status: "ok" | "degraded") => healthResponseSchema.parse({
      status,
      service: "aihub-api-readiness",
      timestamp: new Date().toISOString(),
    });
    if (runtime.bootstrapState !== "READY" || !runtime.prisma) {
      return reply.code(503).send(response("degraded"));
    }
    try {
      await runtime.prisma.$queryRaw`SELECT 1`;
      return response("ok");
    } catch {
      return reply.code(503).send(response("degraded"));
    }
  });

  app.get("/api/v1/platform", async () =>
    platformMetaSchema.parse({
      product: "MPM AIHub",
      version: "0.1.0",
      phase: "streamlined on-prem acceptance candidate",
      configurationMode: "dashboard",
      bootstrapState: runtime.bootstrapState,
    }),
  );

  app.get("/api/v1/connections/catalog", async () => ({
    items: SERVICE_KINDS.map((kind) => ({ kind })),
  }));

  await app.register(
    async (inference) => registerInferenceGatewayRoutes(inference, {
      ...(runtime.inferenceGateway ? { gateway: runtime.inferenceGateway } : {}),
    }),
    { prefix: "/internal/v1" },
  );

  await app.register(
    async (onboarding) =>
      registerOnboardingRoutes(onboarding, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.onboardingManager ? { manager: runtime.onboardingManager } : {}),
      }),
    { prefix: "/api/v1/admin/onboarding" },
  );

  await app.register(
    async (runtimeNodes) => registerRuntimeNodeRoutes(runtimeNodes, {
      ...(runtime.runtimeNodeManager ? { manager: runtime.runtimeNodeManager } : {}),
    }),
    { prefix: "/api/v1/runtime-nodes" },
  );

  await app.register(
    async (runtimeNodes) => registerAdminRuntimeNodeRoutes(runtimeNodes, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.runtimeNodeManager ? { manager: runtime.runtimeNodeManager } : {}),
    }),
    { prefix: "/api/v1/admin/runtime-nodes" },
  );

  await app.register(
    async (prompts) => registerPromptRoutes(prompts, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.promptManager ? { manager: runtime.promptManager } : {}),
    }),
    { prefix: "/api/v1/admin/prompts" },
  );

  await app.register(
    async (chat) =>
      registerChatRoutes(chat, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.identityManager ? { identityManager: runtime.identityManager } : {}),
        ...(runtime.chatManager ? { manager: runtime.chatManager } : {}),
      }),
    { prefix: "/api/v1/chat" },
  );

  await app.register(
    async (documents) =>
      registerDocumentRoutes(documents, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.identityManager ? { identityManager: runtime.identityManager } : {}),
        ...(runtime.documentManager ? { manager: runtime.documentManager } : {}),
      }),
    { prefix: "/api/v1/documents" },
  );

  await app.register(
    async (agents) =>
      registerAgentRoutes(agents, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.identityManager ? { identityManager: runtime.identityManager } : {}),
        ...(runtime.agentManager ? { manager: runtime.agentManager } : {}),
      }),
    { prefix: "/api/v1/agents" },
  );

  await app.register(
    async (agents) =>
      registerAdminAgentRoutes(agents, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.identityManager ? { identityManager: runtime.identityManager } : {}),
        ...(runtime.agentManager ? { manager: runtime.agentManager } : {}),
      }),
    { prefix: "/api/v1/admin/agents" },
  );

  await app.register(
    async (mcp) => registerMcpGatewayRoutes(mcp, {
      ...(runtime.toolingManager ? { manager: runtime.toolingManager } : {}),
    }),
    { prefix: "/api/v1/mcp" },
  );

  await app.register(
    async (tooling) => registerAdminToolingRoutes(tooling, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.toolingManager ? { manager: runtime.toolingManager } : {}),
    }),
    { prefix: "/api/v1/admin/tooling" },
  );

  await app.register(
    async (memory) =>
      registerMemoryRoutes(memory, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.memoryManager ? { manager: runtime.memoryManager } : {}),
      }),
    { prefix: "/api/v1/admin/memory" },
  );

  await app.register(
    async (chatMetrics) =>
      registerChatMetricsRoutes(chatMetrics, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.chatManager ? { manager: runtime.chatManager } : {}),
      }),
    { prefix: "/api/v1/admin/chat" },
  );

  await app.register(
    async (identity) =>
      registerIdentityRoutes(identity, {
        ...(runtime.identityManager ? { manager: runtime.identityManager } : {}),
      }),
    { prefix: "/api/v1" },
  );

  await app.register(
    async (adminSession) =>
      registerAdminSessionRoutes(adminSession, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      }),
    { prefix: "/api/v1/admin/session" },
  );

  await app.register(
    async (adminConnections) =>
      registerConnectionRoutes(adminConnections, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.connectionManager ? { manager: runtime.connectionManager } : {}),
        ...(runtime.connectionTestService ? { tester: runtime.connectionTestService } : {}),
        ...(runtime.connectionMonitor ? { monitor: runtime.connectionMonitor } : {}),
      }),
    { prefix: "/api/v1/admin/connections" },
  );

  await app.register(
    async (models) =>
      registerModelRoutes(models, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.modelManager ? { manager: runtime.modelManager } : {}),
      }),
    { prefix: "/api/v1/admin/models" },
  );

  await app.register(
    async (guardrails) =>
      registerGuardrailRoutes(guardrails, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.guardrailManager ? { manager: runtime.guardrailManager } : {}),
      }),
    { prefix: "/api/v1/admin/guardrails" },
  );

  await app.register(
    async (aiOps) =>
      registerAiOpsRoutes(aiOps, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.aiOpsManager ? { manager: runtime.aiOpsManager } : {}),
      }),
    { prefix: "/api/v1/admin/operations" },
  );

  await app.register(
    async (adminOperations) =>
      registerOperationsRoutes(adminOperations, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.operationsManager ? { manager: runtime.operationsManager } : {}),
      }),
    { prefix: "/api/v1/admin/operations/runtime" },
  );

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ error }, "AIHub request failed");
    await reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "AIHub could not complete the request.",
    });
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({
      error: "NOT_FOUND",
      message: "The requested AIHub API resource does not exist.",
    });
  });

  return app;
}
