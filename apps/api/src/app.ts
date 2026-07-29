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
              ],
              censor: "[REDACTED]",
            },
          },
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1/admin/")) {
      void reply.header("cache-control", "no-store");
    }
    return payload;
  });

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

  app.get("/healthz", async () =>
    healthResponseSchema.parse({
      status: "ok",
      service: "aihub-api",
      timestamp: new Date().toISOString(),
    }),
  );

  app.get("/api/v1/platform", async () =>
    platformMetaSchema.parse({
      product: "MPM AIHub",
      version: "0.1.0",
      phase: "Foundation",
      configurationMode: "dashboard",
      bootstrapState: runtime.bootstrapState,
    }),
  );

  app.get("/api/v1/connections/catalog", async () => ({
    items: SERVICE_KINDS.map((kind) => ({ kind })),
  }));

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
      }),
    { prefix: "/api/v1/admin/connections" },
  );

  await app.register(
    async (adminOperations) =>
      registerOperationsRoutes(adminOperations, {
        ...(runtime.sessionManager ? { sessionManager: runtime.sessionManager } : {}),
        ...(runtime.operationsManager ? { manager: runtime.operationsManager } : {}),
      }),
    { prefix: "/api/v1/admin/operations/jobs" },
  );

  if (runtime.prisma || runtime.operationsManager) {
    app.addHook("onClose", async () => {
      try {
        await runtime.operationsManager?.stop();
      } finally {
        await runtime.prisma?.$disconnect();
      }
    });
  }

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
