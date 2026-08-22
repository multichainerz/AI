import {
  aiOpsOverviewSchema,
  createOperationalIncidentSchema,
  incidentDecisionSchema,
  operationalIncidentListSchema,
  operationalIncidentSchema,
  operationalIncidentIdentifierSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import { AiOpsConflictError, AiOpsNotFoundError, type AiOpsManager } from "./ai-ops-manager.js";

interface AiOpsRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: AiOpsManager;
}

function managerOrLocked(options: AiOpsRouteDependencies, reply: FastifyReply): AiOpsManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "AI operations services are not ready." });
  return null;
}

async function conflictResponse(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof AiOpsNotFoundError) {
    return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
  }
  if (error instanceof AiOpsConflictError) {
    return reply.code(409).send({ error: "CONFLICT", message: error.message });
  }
  throw error;
}

export async function registerAiOpsRoutes(app: FastifyInstance, options: AiOpsRouteDependencies): Promise<void> {
  app.get("/overview", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "operations:read");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    return aiOpsOverviewSchema.parse(await manager.overview());
  });

  app.get("/incidents", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "operations:read");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    return operationalIncidentListSchema.parse(await manager.listIncidents());
  });

  app.post("/incidents", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "operations:execute");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    const input = createOperationalIncidentSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_INCIDENT", message: "The incident record is invalid." });
    return reply.code(201).send(operationalIncidentSchema.parse(await manager.createIncident(principal, input.data)));
  });

  for (const action of ["acknowledge", "resolve"] as const) {
    app.post<{ Params: { incidentId: string } }>(`/incidents/:incidentId/${action}`, async (request, reply) => {
      const principal = await requireAdmin(request, reply, options.sessionManager, "operations:execute");
      if (!principal) return reply;
      const manager = managerOrLocked(options, reply);
      if (!manager) return reply;
      const incidentId = operationalIncidentIdentifierSchema.safeParse(request.params.incidentId);
      if (!incidentId.success) return reply.code(400).send({ error: "INVALID_INCIDENT", message: "The incident identifier is invalid." });
      const input = incidentDecisionSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: "INVALID_DECISION", message: "The incident decision is invalid." });
      try {
        const result = action === "acknowledge"
          ? await manager.acknowledgeIncident(principal, incidentId.data, input.data)
          : await manager.resolveIncident(principal, incidentId.data, input.data);
        return operationalIncidentSchema.parse(result);
      } catch (error) {
        return conflictResponse(error, reply);
      }
    });
  }

}
