import {
  agentMemoryQuerySchema,
  agentMemoryRecordListSchema,
  changeMemoryPolicyStateSchema,
  createMemoryPolicySchema,
  deleteAgentMemorySchema,
  forgetMatchingAgentMemorySchema,
  forgetMatchingResultSchema,
  memoryPolicyListSchema,
  memoryPolicySchema,
  purgeAgentMemorySchema,
  updateMemoryPolicySchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import {
  AgentMemoryNotFoundError,
  ForgetMatchingUnavailableError,
  MemoryPolicyConflictError,
  MemoryPolicyNotFoundError,
  type MemoryManager,
} from "./memory-manager.js";

interface MemoryRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: MemoryManager;
}

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof MemoryPolicyNotFoundError || error instanceof AgentMemoryNotFoundError) {
    return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
  }
  if (error instanceof MemoryPolicyConflictError) {
    return reply.code(409).send({ error: "MEMORY_POLICY_CONFLICT", message: error.message });
  }
  // 503, not 200-with-nothing-matched: an operator told nothing matched will
  // read that as "the topic is not stored", which would be a false assurance.
  if (error instanceof ForgetMatchingUnavailableError) {
    return reply.code(503).send({ error: "FORGET_MATCHING_UNAVAILABLE", message: error.message });
  }
  throw error;
}

export async function registerMemoryRoutes(app: FastifyInstance, dependencies: MemoryRouteDependencies): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  app.get("/policies", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "memory:read"))) return;
    return memoryPolicyListSchema.parse(await dependencies.manager!.list());
  });

  app.post("/policies", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "memory:manage");
    if (!principal) return;
    const input = createMemoryPolicySchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_MEMORY_POLICY", message: input.error.issues[0]?.message });
    }
    try {
      return reply.code(201).send(memoryPolicySchema.parse(await dependencies.manager!.create(principal, input.data)));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/policies/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "memory:manage");
    if (!principal) return;
    const input = updateMemoryPolicySchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_MEMORY_POLICY", message: input.error.issues[0]?.message });
    }
    try {
      return memoryPolicySchema.parse(await dependencies.manager!.update(principal, request.params.id, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  for (const action of ["activate", "suspend"] as const) {
    app.post<{ Params: { id: string } }>(`/policies/:id/${action}`, async (request, reply) => {
      const principal = await requireAdmin(request, reply, dependencies.sessionManager, "memory:manage");
      if (!principal) return;
      const input = changeMemoryPolicyStateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send({ error: "INVALID_MEMORY_DECISION", message: input.error.issues[0]?.message });
      }
      try {
        const policy = action === "activate"
          ? await dependencies.manager!.activate(principal, request.params.id, input.data)
          : await dependencies.manager!.suspend(principal, request.params.id, input.data);
        return memoryPolicySchema.parse(policy);
      } catch (error) {
        return sendError(error, reply);
      }
    });
  }

  app.get("/records", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "memory:read"))) return;
    const query = agentMemoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "INVALID_MEMORY_QUERY", message: query.error.issues[0]?.message });
    }
    void reply.header("cache-control", "no-store");
    return agentMemoryRecordListSchema.parse(await dependencies.manager!.records(query.data));
  });

  app.delete<{ Params: { id: string } }>("/records/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "memory:manage");
    if (!principal) return;
    const input = deleteAgentMemorySchema.safeParse(request.body ?? {});
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_MEMORY_DELETION", message: input.error.issues[0]?.message });
    }
    try {
      await dependencies.manager!.forget({ id: principal.id }, request.params.id, input.data.reason);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/records/forget-matching", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "memory:manage");
    if (!principal) return;
    const input = forgetMatchingAgentMemorySchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_MEMORY_FORGET", message: input.error.issues[0]?.message });
    }
    try {
      return forgetMatchingResultSchema.parse(
        await dependencies.manager!.forgetMatching({ id: principal.id }, input.data),
      );
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/records/purge", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "memory:manage");
    if (!principal) return;
    const input = purgeAgentMemorySchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_MEMORY_PURGE", message: input.error.issues[0]?.message });
    }
    return { removed: await dependencies.manager!.purge(principal, input.data) };
  });
}
