import { runtimeOperationsSnapshotSchema } from "@orcasynapse/contracts";
import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import type { OperationsManager } from "./operations-manager.js";

interface OperationsRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: OperationsManager;
}

export async function registerOperationsRoutes(
  app: FastifyInstance,
  dependencies: OperationsRouteDependencies,
): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.manager || !dependencies.sessionManager) {
      return reply.code(423).send({
        error: "PLATFORM_LOCKED",
        message: "OrcaSynapse runtime operations are not ready.",
      });
    }
  });

  app.get("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "operations:read"))) return reply;
    return runtimeOperationsSnapshotSchema.parse(await dependencies.manager!.snapshot());
  });
}
