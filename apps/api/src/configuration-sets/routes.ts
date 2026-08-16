import {
  createSkillSetSchema,
  createToolSetSchema,
  skillSetListSchema,
  skillSetSchema,
  toolSetListSchema,
  toolSetSchema,
  configurationSetIdentifierSchema,
  updateSkillSetSchema,
  updateToolSetSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import {
  ConfigurationSetConflictError,
  ConfigurationSetNotFoundError,
  type ConfigurationSetManager,
} from "./configuration-set-manager.js";

interface ConfigurationSetRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: ConfigurationSetManager;
}

/**
 * Tool sets read behind `tools:read` and write behind `tools:manage`; skill
 * sets behind `corpus:metadata:read` and `corpus:write`, which are the scopes
 * the Tools and Skills screens already hold. No new scope: a set is a different
 * shape of the same decision those screens already make, and the plan's scope
 * model is explicit that division work adds no scope and no role.
 */
export async function registerConfigurationSetRoutes(
  app: FastifyInstance,
  dependencies: ConfigurationSetRouteDependencies,
): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  function sendError(reply: FastifyReply, error: unknown): boolean {
    if (error instanceof ConfigurationSetNotFoundError) {
      void reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      return true;
    }
    if (error instanceof ConfigurationSetConflictError) {
      void reply.code(409).send({ error: "CONFIGURATION_SET_CONFLICT", message: error.message });
      return true;
    }
    return false;
  }

  app.get<{ Querystring: { includeRetired?: string } }>("/tool-sets", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "tools:read"))) return;
    const includeRetired = request.query.includeRetired === "true";
    return toolSetListSchema.parse(await dependencies.manager!.listToolSets(includeRetired));
  });

  app.post("/tool-sets", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "tools:manage");
    if (!principal) return;
    const input = createToolSetSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_TOOL_SET", message: "Tool set is invalid.", issues: input.error.issues });
    try {
      return reply.code(201).send(toolSetSchema.parse(await dependencies.manager!.createToolSet(principal, input.data)));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/tool-sets/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "tools:manage");
    if (!principal) return;
    if (!configurationSetIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_TOOL_SET", message: "Tool set identifier is invalid." });
    }
    const input = updateToolSetSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_TOOL_SET", message: "Tool set update is invalid.", issues: input.error.issues });
    try {
      return toolSetSchema.parse(await dependencies.manager!.updateToolSet(principal, request.params.id, input.data));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/tool-sets/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "tools:manage");
    if (!principal) return;
    if (!configurationSetIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_TOOL_SET", message: "Tool set identifier is invalid." });
    }
    try {
      await dependencies.manager!.deleteToolSet(principal, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.get<{ Querystring: { includeRetired?: string } }>("/skill-sets", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "corpus:metadata:read"))) return;
    const includeRetired = request.query.includeRetired === "true";
    return skillSetListSchema.parse(await dependencies.manager!.listSkillSets(includeRetired));
  });

  app.post("/skill-sets", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "corpus:write");
    if (!principal) return;
    const input = createSkillSetSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_SKILL_SET", message: "Skill set is invalid.", issues: input.error.issues });
    try {
      return reply.code(201).send(skillSetSchema.parse(await dependencies.manager!.createSkillSet(principal, input.data)));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/skill-sets/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "corpus:write");
    if (!principal) return;
    if (!configurationSetIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_SKILL_SET", message: "Skill set identifier is invalid." });
    }
    const input = updateSkillSetSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_SKILL_SET", message: "Skill set update is invalid.", issues: input.error.issues });
    try {
      return skillSetSchema.parse(await dependencies.manager!.updateSkillSet(principal, request.params.id, input.data));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/skill-sets/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "corpus:write");
    if (!principal) return;
    if (!configurationSetIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_SKILL_SET", message: "Skill set identifier is invalid." });
    }
    try {
      await dependencies.manager!.deleteSkillSet(principal, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });
}
