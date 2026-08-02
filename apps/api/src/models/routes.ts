import {
  changeModelDeploymentStateSchema,
  createModelDeploymentSchema,
  modelDeploymentListSchema,
  modelDeploymentIdentifierSchema,
  modelDeploymentSchema,
  updateModelDeploymentSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import { ModelConflictError, ModelNotFoundError, type ModelManager } from "./model-manager.js";

interface ModelRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: ModelManager;
}

export async function registerModelRoutes(app: FastifyInstance, dependencies: ModelRouteDependencies): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  app.get("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "models:read"))) return;
    return modelDeploymentListSchema.parse(await dependencies.manager!.list());
  });

  app.post("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "models:manage");
    if (!principal) return;
    const input = createModelDeploymentSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_MODEL_ROUTE", message: "Model route configuration is invalid.", issues: input.error.issues });
    try {
      return reply.code(201).send(modelDeploymentSchema.parse(await dependencies.manager!.create(principal, input.data)));
    } catch (error) {
      if (error instanceof ModelConflictError) return reply.code(409).send({ error: "MODEL_CONFLICT", message: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "models:manage");
    if (!principal) return;
    if (!modelDeploymentIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_MODEL_ROUTE", message: "Model route identifier is invalid." });
    }
    const input = updateModelDeploymentSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_MODEL_ROUTE", message: "Model route update is invalid.", issues: input.error.issues });
    try {
      return modelDeploymentSchema.parse(await dependencies.manager!.update(principal, request.params.id, input.data));
    } catch (error) {
      if (error instanceof ModelNotFoundError) return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      if (error instanceof ModelConflictError) return reply.code(409).send({ error: "MODEL_CONFLICT", message: error.message });
      throw error;
    }
  });

  for (const action of ["activate", "suspend"] as const) {
    app.post<{ Params: { id: string } }>(`/:id/${action}`, async (request, reply) => {
      const principal = await requireAdmin(request, reply, dependencies.sessionManager, "models:manage");
      if (!principal) return;
      if (!modelDeploymentIdentifierSchema.safeParse(request.params.id).success) {
        return reply.code(400).send({ error: "INVALID_MODEL_ROUTE", message: "Model route identifier is invalid." });
      }
      const input = changeModelDeploymentStateSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: "INVALID_MODEL_DECISION", message: "Model route decision is invalid.", issues: input.error.issues });
      try {
        const result = action === "activate"
          ? await dependencies.manager!.activate(principal, request.params.id, input.data)
          : await dependencies.manager!.suspend(principal, request.params.id, input.data);
        return modelDeploymentSchema.parse(result);
      } catch (error) {
        if (error instanceof ModelNotFoundError) return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
        if (error instanceof ModelConflictError) return reply.code(409).send({ error: "MODEL_CONFLICT", message: error.message });
        throw error;
      }
    });
  }
}
