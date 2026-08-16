import {
  healthResponseSchema,
  ORCASYNAPSE_VERSION,
  platformMetaSchema,
} from "@orcasynapse/contracts";
import helmet from "@fastify/helmet";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { registerConnectionRoutes } from "./connections/routes.js";
import { createRuntimeServices, type RuntimeServices } from "./runtime.js";
import { registerOperationsRoutes } from "./operations/routes.js";
import { registerAdminSessionRoutes } from "./auth/routes.js";
import { registerChatMetricsRoutes, registerChatRoutes } from "./chat/routes.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import { registerAdminAgentRoutes, registerAgentRoutes } from "./agents/routes.js";
import { registerConfigurationSetRoutes } from "./configuration-sets/routes.js";
import { registerAdminToolingRoutes, registerMcpGatewayRoutes } from "./tooling/routes.js";
import { registerAiOpsRoutes } from "./ai-ops/routes.js";
import { registerModelRoutes } from "./models/routes.js";
import { registerGuardrailRoutes } from "./guardrails/routes.js";
import { registerPromptRoutes } from "./prompts/routes.js";
import { registerAuditRoutes } from "./audit/routes.js";
import { registerOnboardingRoutes } from "./onboarding/routes.js";
import {
  registerAdminRuntimeNodeRoutes,
  registerRuntimeNodeInstallerRoutes,
  registerRuntimeNodeRoutes,
} from "./runtime-nodes/routes.js";
import { registerInferenceGatewayRoutes } from "./inference/routes.js";
import { registerAdminCorpusRoutes, registerRuntimeCorpusRoutes } from "./corpus/routes.js";
import { checkForPlatformUpdate } from "./platform-updates.js";
import { registerAdminUpdateRoutes } from "./updates/routes.js";

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
                "req.body.currentPassword",
                "req.body.newPassword",
                "req.body.installationKey",
                "req.body.apiKey",
                "req.body.token",
                "req.body.passphrase",
                "req.body.serializedKit",
              ],
              censor: "[REDACTED]",
            },
          },
    // OrcaSynapse's Compose topology exposes only the adjacent Nginx proxy. Trusting
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
      request.url.startsWith("/api/v1/agents")
      || request.url.startsWith("/api/v1/mcp")
      || request.url.startsWith("/api/v1/runtime-nodes")
      || request.url.startsWith("/internal/v1/")
      || request.url.startsWith("/install/")
    ) {
      void reply.header("cache-control", "no-store");
    }
    return payload;
  });

  if (runtime.database || runtime.operationsManager || runtime.connectionMonitor) {
    app.addHook("onClose", async () => {
      try {
        await runtime.siemForwarder?.stop();
        await runtime.connectionMonitor?.stop();
      } finally {
        try {
          await runtime.operationsManager?.stop();
        } finally {
          await runtime.closeDatabase?.();
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
        runtime.closeDatabase?.() ?? Promise.resolve(),
      ]);
      throw error;
    }
  }

  if (runtime.connectionMonitor) {
    await runtime.connectionMonitor.start();
  }

  if (runtime.siemForwarder) {
    await runtime.siemForwarder.start();
  }

  app.get("/healthz", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return healthResponseSchema.parse({
      status: "ok",
      service: "orcasynapse-api",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/readyz", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    const response = (status: "ok" | "degraded") => healthResponseSchema.parse({
      status,
      service: "orcasynapse-api-readiness",
      timestamp: new Date().toISOString(),
    });
    if (runtime.bootstrapState !== "READY" || !runtime.database) {
      return reply.code(503).send(response("degraded"));
    }
    try {
      await runtime.database.execute(sql`SELECT 1`);
      return response("ok");
    } catch {
      return reply.code(503).send(response("degraded"));
    }
  });

  app.get("/api/v1/platform", async () =>
    platformMetaSchema.parse({
      product: "OrcaSynapse",
      version: ORCASYNAPSE_VERSION,
      phase: "streamlined on-prem acceptance candidate",
      configurationMode: "dashboard",
      bootstrapState: runtime.bootstrapState,
    }),
  );

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
    async (runtimeInstaller) => registerRuntimeNodeInstallerRoutes(runtimeInstaller, {
      ...(runtime.runtimeNodeManager ? { manager: runtime.runtimeNodeManager } : {}),
    }),
    { prefix: "/install" },
  );

  await app.register(
    async (runtimeNodes) => registerRuntimeNodeRoutes(runtimeNodes, {
      ...(runtime.runtimeNodeManager ? { manager: runtime.runtimeNodeManager } : {}),
    }),
    { prefix: "/api/v1/runtime-nodes" },
  );

  /*
   * The release question, and only that. This route needs no session, so it
   * never carries the approved target — that record names the administrator who
   * approved it. `/api/v1/admin/updates` answers the same question with the
   * target attached, for a caller that has proved who it is.
   */
  app.get("/api/v1/platform/update", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    try {
      return await checkForPlatformUpdate(ORCASYNAPSE_VERSION);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The release service returned an unknown error.";
      return reply.code(503).send({
        error: "UPDATE_CHECK_UNAVAILABLE",
        message: `OrcaSynapse could not check for updates. ${detail}`,
      });
    }
  });

  await app.register(
    async (updates) => registerAdminUpdateRoutes(updates, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.releaseTargetManager ? { manager: runtime.releaseTargetManager } : {}),
    }),
    { prefix: "/api/v1/admin/updates" },
  );

  await app.register(
    async (runtimeCorpus) => registerRuntimeCorpusRoutes(runtimeCorpus, {
      ...(runtime.corpusManager ? { manager: runtime.corpusManager } : {}),
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
    async (corpus) => registerAdminCorpusRoutes(corpus, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.corpusManager ? { manager: runtime.corpusManager } : {}),
    }),
    { prefix: "/api/v1/admin/corpus" },
  );

  await app.register(
    async (prompts) => registerPromptRoutes(prompts, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.promptManager ? { manager: runtime.promptManager } : {}),
    }),
    { prefix: "/api/v1/admin/prompts" },
  );

  await app.register(
    async (audit) => registerAuditRoutes(audit, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.auditManager ? { manager: runtime.auditManager } : {}),
    }),
    { prefix: "/api/v1/admin/audit" },
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
    async (sets) => registerConfigurationSetRoutes(sets, {
      ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
      ...(runtime.configurationSetManager ? { manager: runtime.configurationSetManager } : {}),
    }),
    { prefix: "/api/v1/admin/configuration" },
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
        ...(runtime.inferenceDiscoveryService ? { discoverer: runtime.inferenceDiscoveryService } : {}),
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
    // Sibling of, not a sub-resource of, /admin/operations. That module is the
    // AI-operations surface; this one reports worker and workload runtime state.
    { prefix: "/api/v1/admin/runtime" },
  );

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ error }, "OrcaSynapse request failed");
    await reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "OrcaSynapse could not complete the request.",
    });
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({
      error: "NOT_FOUND",
      message: "The requested OrcaSynapse API resource does not exist.",
    });
  });

  return app;
}
