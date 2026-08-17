import { usageQuerySchema, usageReportSchema } from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import type { UsageManager } from "./usage-manager.js";

export interface UsageRouteOptions {
  sessionManager?: AdminSessionManager;
  manager?: UsageManager;
}

function managerOrLocked(options: UsageRouteOptions, reply: FastifyReply): UsageManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Gateway usage services are not ready." });
  return null;
}

export async function registerUsageRoutes(app: FastifyInstance, options: UsageRouteOptions): Promise<void> {
  app.get("/usage", async (request, reply) => {
    /*
     * `operations:read` for the report, `audit:read` for the one breakdown that
     * names people.
     *
     * The split is the same shape the corpus routes already make between
     * metadata and content, and it exists for a reason specific to this
     * screen: `operations:read` is held by OPERATIONS_ADMIN, and "which model
     * cost what" and "which named person spent it" are different questions
     * with different audiences. The second is the audit trail's question, so it
     * is behind the audit trail's scope.
     *
     * A caller without it receives `byUser: null` rather than an empty
     * breakdown or a 403 on the whole report -- absence of permission and
     * absence of data must not render the same, and refusing the report
     * outright would take the other three breakdowns away with it.
     */
    const principal = await requireAdmin(request, reply, options.sessionManager, "operations:read");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;

    const query = usageQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: query.error.issues[0]?.message ?? "The usage window is invalid.",
      });
    }

    return usageReportSchema.parse(await manager.report({
      window: query.data.window,
      includeUsers: principal.scopes.includes("audit:read"),
    }));
  });
}
