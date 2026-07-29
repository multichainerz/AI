import {
  connectionTestResultSchema,
  configurationRevisionListSchema,
  createServiceConnectionSchema,
  rollbackConfigurationRequestSchema,
  rollbackConfigurationResultSchema,
  serviceConnectionIdentifierSchema,
  serviceConnectionListSchema,
  serviceConnectionSummarySchema,
  updateServiceConnectionSchema,
} from "@aihub/contracts";
import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import {
  ConnectionConflictError,
  ConnectionRevisionConflictError,
  InvalidConnectionConfigurationError,
  ConnectionNotFoundError,
  type ConnectionManager,
} from "./connection-manager.js";
import type { ConnectionTestService } from "./diagnostics/connection-test-service.js";

interface ConnectionRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: ConnectionManager;
  tester?: ConnectionTestService;
}

export async function registerConnectionRoutes(
  app: FastifyInstance,
  dependencies: ConnectionRouteDependencies,
): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!dependencies.manager || !dependencies.sessionManager) {
      await reply.code(423).send({
        error: "PLATFORM_LOCKED",
        message: "AIHub bootstrap trust is not ready.",
      });
      return reply;
    }
  });

  app.get("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "connections:read"))) {
      return reply;
    }
    const items = await dependencies.manager!.list();
    return serviceConnectionListSchema.parse({ items });
  });

  app.post("/", async (request, reply) => {
    const principal = await requireAdmin(
      request,
      reply,
      dependencies.sessionManager,
      "connections:write",
    );
    if (!principal) return reply;
    const parsed = createServiceConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_CONNECTION",
        message: "Connection configuration is invalid.",
        issues: parsed.error.issues,
      });
    }

    try {
      const connection = await dependencies.manager!.create(parsed.data, principal);
      return reply.code(201).send(serviceConnectionSummarySchema.parse(connection));
    } catch (error) {
      if (error instanceof ConnectionConflictError) {
        return reply.code(409).send({ error: "CONNECTION_EXISTS", message: error.message });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const principal = await requireAdmin(
      request,
      reply,
      dependencies.sessionManager,
      "connections:write",
    );
    if (!principal) return reply;
    if (!serviceConnectionIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({
        error: "INVALID_CONNECTION",
        message: "Connection identifier is invalid.",
      });
    }
    const parsed = updateServiceConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_CONNECTION",
        message: "Connection update is invalid.",
        issues: parsed.error.issues,
      });
    }

    try {
      const connection = await dependencies.manager!.update(
        request.params.id,
        parsed.data,
        principal,
      );
      return serviceConnectionSummarySchema.parse(connection);
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) {
        return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      }
      if (error instanceof InvalidConnectionConfigurationError) {
        return reply.code(400).send({
          error: "INVALID_CONNECTION",
          message: "Connection configuration is invalid for this service type.",
        });
      }
      if (error instanceof ConnectionRevisionConflictError) {
        return reply.code(409).send({ error: "REVISION_CONFLICT", message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/:id/test", async (request, reply) => {
    const principal = await requireAdmin(
      request,
      reply,
      dependencies.sessionManager,
      "connections:test",
    );
    if (!principal) return reply;
    if (!serviceConnectionIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({
        error: "INVALID_CONNECTION",
        message: "Connection identifier is invalid.",
      });
    }
    if (!dependencies.tester) {
      return reply.code(503).send({
        error: "DIAGNOSTICS_UNAVAILABLE",
        message: "Connection diagnostics are not available.",
      });
    }

    try {
      const result = await dependencies.tester.test(request.params.id, principal);
      return connectionTestResultSchema.parse(result);
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) {
        return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/:id/revisions", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "connections:read"))) {
      return reply;
    }
    if (!serviceConnectionIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({
        error: "INVALID_CONNECTION",
        message: "Connection identifier is invalid.",
      });
    }
    try {
      return configurationRevisionListSchema.parse(
        await dependencies.manager!.listRevisions(request.params.id),
      );
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) {
        return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string; revision: string } }>(
    "/:id/revisions/:revision/rollback",
    async (request, reply) => {
      const principal = await requireAdmin(
        request,
        reply,
        dependencies.sessionManager,
        "connections:write",
      );
      if (!principal) return reply;
      const targetRevision = Number(request.params.revision);
      const parsed = rollbackConfigurationRequestSchema.safeParse(request.body);
      if (
        !serviceConnectionIdentifierSchema.safeParse(request.params.id).success ||
        !Number.isSafeInteger(targetRevision) ||
        targetRevision < 1 ||
        !parsed.success
      ) {
        return reply.code(400).send({
          error: "INVALID_ROLLBACK",
          message: "A valid target and expected active revision are required.",
        });
      }
      try {
        const result = await dependencies.manager!.rollback(
          request.params.id,
          targetRevision,
          parsed.data.expectedActiveRevision,
          principal,
        );
        return rollbackConfigurationResultSchema.parse(result);
      } catch (error) {
        if (error instanceof ConnectionNotFoundError) {
          return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
        }
        if (error instanceof ConnectionRevisionConflictError) {
          return reply.code(409).send({ error: "REVISION_CONFLICT", message: error.message });
        }
        if (error instanceof InvalidConnectionConfigurationError) {
          return reply.code(422).send({ error: "INVALID_REVISION", message: error.message });
        }
        throw error;
      }
    },
  );
}
