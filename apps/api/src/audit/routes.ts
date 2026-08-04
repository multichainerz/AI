import { auditEventListSchema, auditEventQuerySchema, auditForwardingStateSchema } from "@orcasynapse/contracts";
import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import type { AuditManager } from "./audit-manager.js";

interface AuditRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: AuditManager;
}

export async function registerAuditRoutes(app: FastifyInstance, dependencies: AuditRouteDependencies): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  app.get("/events", async (request, reply) => {
    // audit:read is the scope the AUDITOR role exists for; this is the only
    // route that grants it meaning.
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "audit:read"))) return;
    const query = auditEventQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: "INVALID_AUDIT_QUERY",
        message: "The audit query is invalid.",
        issues: query.error.issues,
      });
    }
    void reply.header("cache-control", "no-store");
    return auditEventListSchema.parse(await dependencies.manager!.list(query.data));
  });

  app.get("/forwarding", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "audit:read"))) return;
    void reply.header("cache-control", "no-store");
    return auditForwardingStateSchema.parse(await dependencies.manager!.forwarding());
  });
}
