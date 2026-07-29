import {
  deadLetterRedriveRequestSchema,
  jobActionResultSchema,
  jobIdentifierSchema,
  jobOperationsSnapshotSchema,
  jobProbeResultSchema,
  jobQueueNameSchema,
} from "@aihub/contracts";
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
  app.addHook("preHandler", async (request, reply) => {
    if (!dependencies.manager || !dependencies.sessionManager) {
      return reply.code(423).send({
        error: "PLATFORM_LOCKED",
        message: "AIHub job operations are not ready.",
      });
    }
  });

  app.get("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "operations:read"))) {
      return reply;
    }
    return jobOperationsSnapshotSchema.parse(await dependencies.manager!.snapshot());
  });

  app.post("/probe", async (request, reply) => {
    const principal = await requireAdmin(
      request,
      reply,
      dependencies.sessionManager,
      "operations:execute",
    );
    if (!principal) return reply;
    const result = await dependencies.manager!.sendProbe(principal.subject, principal);
    return reply.code(202).send(jobProbeResultSchema.parse(result));
  });

  app.post<{ Params: { queue: string; jobId: string } }>(
    "/queues/:queue/jobs/:jobId/retry",
    async (request, reply) => {
      const principal = await requireAdmin(
        request,
        reply,
        dependencies.sessionManager,
        "operations:execute",
      );
      if (!principal) return reply;
      const queue = jobQueueNameSchema.safeParse(request.params.queue);
      const jobId = jobIdentifierSchema.safeParse(request.params.jobId);
      if (!queue.success || !jobId.success) {
        return reply.code(400).send({
          error: "INVALID_JOB",
          message: "Queue name or job identifier is invalid.",
        });
      }
      await dependencies.manager!.retry(queue.data, jobId.data, principal);
      return reply.code(202).send(
        jobActionResultSchema.parse({ accepted: true, message: "Job retry was requested." }),
      );
    },
  );

  app.post("/dead-letter/redrive", async (request, reply) => {
    const principal = await requireAdmin(
      request,
      reply,
      dependencies.sessionManager,
      "operations:execute",
    );
    if (!principal) return reply;
    const parsed = deadLetterRedriveRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REDRIVE",
        message: "Dead-letter redrive request is invalid.",
      });
    }
    const moved = await dependencies.manager!.redriveDeadLetters(parsed.data.limit, principal);
    return reply.code(202).send(
      jobActionResultSchema.parse({
        accepted: true,
        message: `${moved} dead-letter job${moved === 1 ? "" : "s"} redriven.`,
      }),
    );
  });
}
