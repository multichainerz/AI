import {
  changePromptTemplateStateSchema,
  createPromptTemplateSchema,
  promptIdentifierSchema,
  promptTemplateListSchema,
  promptTemplateSchema,
  updatePromptTemplateSchema,
} from "@aihub/contracts";
import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import { PromptConflictError, PromptNotFoundError, type PromptManager } from "./prompt-manager.js";

interface PromptRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: PromptManager;
}

export async function registerPromptRoutes(app: FastifyInstance, dependencies: PromptRouteDependencies): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "AIHub bootstrap trust is not ready." });
    }
  });

  app.get("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "prompts:read"))) return;
    return promptTemplateListSchema.parse(await dependencies.manager!.list());
  });

  app.post("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "prompts:manage");
    if (!principal) return;
    const input = createPromptTemplateSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_PROMPT", message: "Prompt configuration is invalid.", issues: input.error.issues });
    try {
      return reply.code(201).send(promptTemplateSchema.parse(await dependencies.manager!.create(principal, input.data)));
    } catch (error) {
      if (error instanceof PromptConflictError) return reply.code(409).send({ error: "PROMPT_CONFLICT", message: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "prompts:manage");
    if (!principal) return;
    if (!promptIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_PROMPT", message: "Prompt identifier is invalid." });
    }
    const input = updatePromptTemplateSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_PROMPT", message: "Prompt update is invalid.", issues: input.error.issues });
    try {
      return promptTemplateSchema.parse(await dependencies.manager!.update(principal, request.params.id, input.data));
    } catch (error) {
      if (error instanceof PromptNotFoundError) return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      if (error instanceof PromptConflictError) return reply.code(409).send({ error: "PROMPT_CONFLICT", message: error.message });
      throw error;
    }
  });

  for (const action of ["activate", "suspend"] as const) {
    app.post<{ Params: { id: string } }>(`/:id/${action}`, async (request, reply) => {
      const principal = await requireAdmin(request, reply, dependencies.sessionManager, "prompts:manage");
      if (!principal) return;
      if (!promptIdentifierSchema.safeParse(request.params.id).success) {
        return reply.code(400).send({ error: "INVALID_PROMPT", message: "Prompt identifier is invalid." });
      }
      const input = changePromptTemplateStateSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: "INVALID_PROMPT_DECISION", message: "Prompt decision is invalid.", issues: input.error.issues });
      try {
        const result = action === "activate"
          ? await dependencies.manager!.activate(principal, request.params.id, input.data)
          : await dependencies.manager!.suspend(principal, request.params.id, input.data);
        return promptTemplateSchema.parse(result);
      } catch (error) {
        if (error instanceof PromptNotFoundError) return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
        if (error instanceof PromptConflictError) return reply.code(409).send({ error: "PROMPT_CONFLICT", message: error.message });
        throw error;
      }
    });
  }
}
