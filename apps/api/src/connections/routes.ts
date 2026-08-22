import {
  connectionTestResultSchema,
  connectionMonitoringControlSchema,
  configurationRevisionListSchema,
  createServiceConnectionSchema,
  inferenceCatalogueRequestSchema,
  inferenceCatalogueResultSchema,
  inferenceDiscoveryRequestSchema,
  inferenceDiscoveryResultSchema,
  modelRefreshResultSchema,
  rollbackConfigurationRequestSchema,
  rollbackConfigurationResultSchema,
  serviceConnectionIdentifierSchema,
  serviceConnectionListSchema,
  serviceConnectionSummarySchema,
  updateServiceConnectionSchema,
  updateConnectionMonitoringControlSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance } from "fastify";
import {
  authenticateAdministrator,
  requireAdmin,
  requireAdminAny,
  type AdminSessionManager,
} from "../auth/admin-session.js";
import { ModelRefreshError, type InferenceRefreshService } from "../models/inference-refresh-service.js";
import {
  ConnectionConflictError,
  ConnectionAuthorizationError,
  ConnectionRevisionConflictError,
  InvalidConnectionConfigurationError,
  ConnectionNotFoundError,
  type ConnectionManager,
} from "./connection-manager.js";
import type { ConnectionTestService } from "./diagnostics/connection-test-service.js";
import type { ConnectionMonitoringManager } from "./connection-monitor.js";
import type { InferenceDiscoveryService } from "./diagnostics/inference-discovery-service.js";
import { InferenceCatalogueError, type InferenceCatalogueService } from "./diagnostics/inference-catalogue-service.js";

interface ConnectionRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: ConnectionManager;
  tester?: ConnectionTestService;
  discoverer?: InferenceDiscoveryService;
  cataloguer?: InferenceCatalogueService;
  monitor?: ConnectionMonitoringManager;
  refresher?: InferenceRefreshService;
}

export async function registerConnectionRoutes(
  app: FastifyInstance,
  dependencies: ConnectionRouteDependencies,
): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!dependencies.manager || !dependencies.sessionManager) {
      await reply.code(423).send({
        error: "PLATFORM_LOCKED",
        message: "OrcaSynapse installation trust is not ready.",
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

  app.get("/monitoring", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "connections:read"))) return;
    if (!dependencies.monitor) {
      return reply.code(503).send({
        error: "MONITORING_UNAVAILABLE",
        message: "Scheduled connection monitoring is not available.",
      });
    }
    return connectionMonitoringControlSchema.parse(await dependencies.monitor.getControl());
  });

  app.patch("/monitoring", async (request, reply) => {
    const principal = await requireAdminAny(request, reply, dependencies.sessionManager, [
      "connections:write",
      "operations:execute",
    ]);
    if (!principal) return;
    if (!dependencies.monitor) {
      return reply.code(503).send({
        error: "MONITORING_UNAVAILABLE",
        message: "Scheduled connection monitoring is not available.",
      });
    }
    const input = updateConnectionMonitoringControlSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: "INVALID_MONITORING_CONTROL",
        message: "Connection monitoring configuration is invalid.",
        issues: input.error.issues,
      });
    }
    return connectionMonitoringControlSchema.parse(await dependencies.monitor.updateControl(principal, input.data));
  });

  app.post("/inference/discover", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "connections:test"))) return reply;
    if (!dependencies.discoverer) {
      return reply.code(503).send({
        error: "DISCOVERY_UNAVAILABLE",
        message: "Inference discovery is not available.",
      });
    }
    const input = inferenceDiscoveryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: "INVALID_DISCOVERY_REQUEST",
        message: "A valid inference endpoint is required.",
        issues: input.error.issues,
      });
    }
    try {
      return inferenceDiscoveryResultSchema.parse(await dependencies.discoverer.discover(input.data));
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) {
        return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      }
      throw error;
    }
  });

  app.post("/inference/catalogue", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "connections:test"))) return reply;
    if (!dependencies.cataloguer) {
      return reply.code(503).send({
        error: "CATALOGUE_UNAVAILABLE",
        message: "Inference catalogue lookup is not available.",
      });
    }
    const input = inferenceCatalogueRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: "INVALID_CATALOGUE_REQUEST",
        message: "An OpenRouter API key is required.",
        issues: input.error.issues,
      });
    }
    try {
      return inferenceCatalogueResultSchema.parse(await dependencies.cataloguer.list(input.data));
    } catch (error) {
      if (error instanceof InferenceCatalogueError && error.code === "AUTH_REJECTED") {
        // 400, not 401: a 401 here is read as a dead administrator session.
        return reply.code(400).send({ error: "CATALOGUE_KEY_REJECTED", message: error.message });
      }
      if (error instanceof InferenceCatalogueError) {
        return reply.code(502).send({ error: "CATALOGUE_UPSTREAM_FAILED", message: error.message });
      }
      throw error;
    }
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
      if (error instanceof ConnectionAuthorizationError) {
        return reply.code(403).send({ error: "IDENTITY_CONFIGURATION_FORBIDDEN", message: error.message });
      }
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
      if (error instanceof ConnectionAuthorizationError) {
        return reply.code(403).send({ error: "IDENTITY_CONFIGURATION_FORBIDDEN", message: error.message });
      }
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

  app.post<{ Params: { id: string } }>("/:id/models/refresh", async (request, reply) => {
    if (!dependencies.sessionManager) {
      return reply.code(423).send({
        error: "PLATFORM_LOCKED",
        message: "OrcaSynapse administrator sessions are not ready.",
      });
    }
    const authentication = await authenticateAdministrator(request, reply, dependencies.sessionManager);
    if (authentication.outcome === "REFUSED") return;
    if (authentication.outcome === "NO_SESSION") {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "An active administrator session with the required scope is required.",
      });
    }
    const { principal } = authentication;
    if (!principal.scopes.includes("models:manage") && !principal.scopes.includes("connections:test")) {
      return reply.code(403).send({
        error: "FORBIDDEN",
        message: "The administrator session does not grant 'models:manage' or 'connections:test'.",
      });
    }
    if (!serviceConnectionIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({
        error: "INVALID_CONNECTION",
        message: "Connection identifier is invalid.",
      });
    }
    if (!dependencies.refresher) {
      return reply.code(503).send({
        error: "REFRESH_UNAVAILABLE",
        message: "Model catalogue refresh is not available.",
      });
    }
    try {
      return modelRefreshResultSchema.parse(await dependencies.refresher.refresh(principal, request.params.id));
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) {
        return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      }
      if (error instanceof ModelRefreshError && error.code === "AUTH_REJECTED") {
        return reply.code(400).send({ error: "CATALOGUE_KEY_REJECTED", message: error.message });
      }
      if (error instanceof ModelRefreshError && error.code === "NOT_CONFIGURED") {
        return reply.code(409).send({ error: "MODEL_REFRESH_NOT_CONFIGURED", message: error.message });
      }
      if (error instanceof ModelRefreshError) {
        return reply.code(502).send({ error: "CATALOGUE_UPSTREAM_FAILED", message: error.message });
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
        if (error instanceof ConnectionAuthorizationError) {
          return reply.code(403).send({ error: "IDENTITY_CONFIGURATION_FORBIDDEN", message: error.message });
        }
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
