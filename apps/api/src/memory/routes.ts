import { memoryMetricsSchema, memoryPublicationListSchema } from "@aihub/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { adminSessionToken, type AdminSessionManager } from "../auth/admin-session.js";
import { MemoryPublicationConflictError, type MemoryManager } from "./memory-manager.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MemoryRouteOptions {
  sessionManager?: AdminSessionManager;
  manager?: MemoryManager;
}

async function principal(request: FastifyRequest, options: MemoryRouteOptions, scope: "memory:read" | "memory:manage") {
  return options.sessionManager?.authenticate(adminSessionToken(request), scope);
}

export async function registerMemoryRoutes(app: FastifyInstance, options: MemoryRouteOptions): Promise<void> {
  app.get("/publications", async (request, reply) => {
    const actor = await principal(request, options, "memory:read");
    if (!actor) return reply.code(401).send({ error: "UNAUTHORIZED", message: "A scoped administrator session is required." });
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Memory services are not ready." });
    return memoryPublicationListSchema.parse(await options.manager.list());
  });

  app.get("/metrics", async (request, reply) => {
    const actor = await principal(request, options, "memory:read");
    if (!actor) return reply.code(401).send({ error: "UNAUTHORIZED", message: "A scoped administrator session is required." });
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Memory services are not ready." });
    return memoryMetricsSchema.parse(await options.manager.metrics());
  });

  app.post("/documents/:documentId/reindex", async (request, reply) => {
    const actor = await principal(request, options, "memory:manage");
    if (!actor) return reply.code(401).send({ error: "UNAUTHORIZED", message: "A scoped administrator session is required." });
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Memory services are not ready." });
    const id = (request.params as { documentId?: unknown }).documentId;
    if (typeof id !== "string" || !UUID.test(id)) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: "Document ID is invalid." });
    }
    try {
      await options.manager.reindex(id, actor.id);
      return reply.code(202).send({ accepted: true, message: "Memory synchronization was queued." });
    } catch (error) {
      if (error instanceof MemoryPublicationConflictError) {
        return reply.code(409).send({ error: "MEMORY_CONFLICT", message: error.message });
      }
      throw error;
    }
  });
}
