import {
  assignProfileDivisionSchema,
  createDivisionSchema,
  divisionIdentifierSchema,
  divisionListSchema,
  divisionSchema,
  updateDivisionSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import {
  DivisionConflictError,
  DivisionNotFoundError,
  type DivisionManager,
} from "./division-manager.js";

interface DivisionRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: DivisionManager;
}

/**
 * Reads behind `agents:read`, writes behind `agents:manage`.
 *
 * No new scope: a division decides which profiles a user reaches, which is the
 * same decision the Agents screens already make. The plan's scope model is
 * explicit that this work adds no scope and no role — that separation is what
 * lets an administrator create a division without a release.
 *
 * Every route resolves its session through `requireAdmin`, so there is no
 * division-scoped path into division administration.
 */
export async function registerDivisionRoutes(
  app: FastifyInstance,
  dependencies: DivisionRouteDependencies,
): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  function sendError(reply: FastifyReply, error: unknown): boolean {
    if (error instanceof DivisionNotFoundError) {
      void reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      return true;
    }
    if (error instanceof DivisionConflictError) {
      void reply.code(409).send({ error: "DIVISION_CONFLICT", message: error.message });
      return true;
    }
    return false;
  }

  app.get<{ Querystring: { includeSuspended?: string } }>("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "agents:read"))) return;
    return divisionListSchema.parse(await dependencies.manager!.list(request.query.includeSuspended === "true"));
  });

  app.post("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "agents:manage");
    if (!principal) return;
    const input = createDivisionSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_DIVISION", message: "Division is invalid.", issues: input.error.issues });
    try {
      return reply.code(201).send(divisionSchema.parse(await dependencies.manager!.create(principal, input.data)));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "agents:manage");
    if (!principal) return;
    if (!divisionIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_DIVISION", message: "Division identifier is invalid." });
    }
    const input = updateDivisionSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_DIVISION", message: "Division update is invalid.", issues: input.error.issues });
    try {
      return divisionSchema.parse(await dependencies.manager!.update(principal, request.params.id, input.data));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "agents:manage");
    if (!principal) return;
    if (!divisionIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_DIVISION", message: "Division identifier is invalid." });
    }
    try {
      await dependencies.manager!.remove(principal, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  /** Assigning a profile lives here rather than on the agents routes, because
   * it is a division decision and the audit trail should read as one. */
  app.put<{ Params: { profileId: string } }>("/profiles/:profileId", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "agents:manage");
    if (!principal) return;
    if (!divisionIdentifierSchema.safeParse(request.params.profileId).success) {
      return reply.code(400).send({ error: "INVALID_DIVISION", message: "Agent profile identifier is invalid." });
    }
    const input = assignProfileDivisionSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_DIVISION", message: "Assignment is invalid.", issues: input.error.issues });
    try {
      await dependencies.manager!.assignProfile(
        principal, request.params.profileId, input.data.divisionId, input.data.expectedRevision,
      );
      return reply.code(204).send();
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });
}
