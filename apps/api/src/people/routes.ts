import {
  createPersonSchema,
  personIdentifierSchema,
  personListSchema,
  personSchema,
  resetPersonPasswordSchema,
  updatePersonSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import { PersonConflictError, PersonNotFoundError, type DrizzlePersonManager } from "./drizzle-person-manager.js";

interface PersonRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: DrizzlePersonManager;
}

/**
 * Behind `sessions:manage`, which is the scope that already governs who may act
 * on somebody else's access. No new scope, and every route resolves its session
 * through `requireAdmin`: administrators are deployment-wide, so there is no
 * division-scoped path into people administration.
 */
export async function registerPersonRoutes(
  app: FastifyInstance,
  dependencies: PersonRouteDependencies,
): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  function sendError(reply: FastifyReply, error: unknown): boolean {
    if (error instanceof PersonNotFoundError) {
      void reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      return true;
    }
    if (error instanceof PersonConflictError) {
      void reply.code(409).send({ error: "PERSON_CONFLICT", message: error.message });
      return true;
    }
    return false;
  }

  app.get("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "sessions:manage"))) return;
    return personListSchema.parse(await dependencies.manager!.list());
  });

  app.post("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "sessions:manage");
    if (!principal) return;
    const input = createPersonSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_PERSON", message: "Person is invalid.", issues: input.error.issues });
    try {
      return reply.code(201).send(personSchema.parse(await dependencies.manager!.create(principal, input.data)));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "sessions:manage");
    if (!principal) return;
    if (!personIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_PERSON", message: "Person identifier is invalid." });
    }
    const input = updatePersonSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_PERSON", message: "Person update is invalid.", issues: input.error.issues });
    try {
      return personSchema.parse(await dependencies.manager!.update(principal, request.params.id, input.data));
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/:id/password", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "sessions:manage");
    if (!principal) return;
    if (!personIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_PERSON", message: "Person identifier is invalid." });
    }
    const input = resetPersonPasswordSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_PERSON", message: "Password is invalid.", issues: input.error.issues });
    try {
      await dependencies.manager!.resetPassword(principal, request.params.id, input.data.password);
      return reply.code(204).send();
    } catch (error) {
      if (sendError(reply, error)) return;
      throw error;
    }
  });
}
