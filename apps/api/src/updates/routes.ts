import {
  approveReleaseTargetSchema,
  platformReleaseTargetSchema,
  platformUpdateActivitySchema,
  platformUpdateSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import {
  ReleaseTargetConflictError,
  ReleaseTargetUnavailableError,
  ReleaseTargetValidationError,
  type PlatformReleaseTargetManager,
} from "./release-target-manager.js";

export interface PlatformUpdateRouteOptions {
  sessionManager?: AdminSessionManager;
  manager?: PlatformReleaseTargetManager;
}

function managerOrLocked(
  options: PlatformUpdateRouteOptions,
  reply: FastifyReply,
): PlatformReleaseTargetManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse update services are not ready." });
  return null;
}

async function sendError(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof ReleaseTargetValidationError) {
    return reply.code(400).send({ error: "INVALID_RELEASE_TARGET", message: error.message });
  }
  if (error instanceof ReleaseTargetConflictError) {
    return reply.code(409).send({ error: "RELEASE_TARGET_CONFLICT", message: error.message });
  }
  if (error instanceof ReleaseTargetUnavailableError) {
    return reply.code(503).send({
      error: "UPDATE_CHECK_UNAVAILABLE",
      message: `OrcaSynapse could not reach the release service. ${error.message}`,
    });
  }
  throw error;
}

/**
 * Approving a release, from the dashboard, without a shell on either host.
 *
 * What these routes write is intent and nothing more: the container has no
 * host-root or Docker control and gains none here. Root agents on VM1 and VM2
 * read the approved target and apply it — the host pulls, the container never
 * pushes.
 *
 * The check lives here rather than beside the unauthenticated
 * `/api/v1/platform/update` because the response carries who approved the
 * target and when, which is not public. Reading needs only `readiness:read`,
 * which every administrator role holds; approving needs `readiness:approve`,
 * which is the deliberate act.
 */
export async function registerAdminUpdateRoutes(
  app: FastifyInstance,
  options: PlatformUpdateRouteOptions,
): Promise<void> {
  app.get("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    void reply.header("cache-control", "no-store");
    try {
      return platformUpdateSchema.parse(await manager.snapshot());
    } catch (error) {
      return sendError(error, reply);
    }
  });

  /*
   * What the host agent has been doing. `readiness:read` like the check above:
   * it reports on this deployment's own maintenance, not on anything an
   * operator could act on, and every administrator role can already read the
   * approval it describes the outcome of.
   *
   * A route of its own rather than a field on the check, because the check
   * reaches GitHub and this reads two local rows. An operator watching an
   * upgrade land is refreshing during the window when this deployment is least
   * able to make an outbound request, and the answer they need is entirely
   * local.
   */
  app.get("/activity", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    void reply.header("cache-control", "no-store");
    try {
      return platformUpdateActivitySchema.parse(await manager.activity());
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/target", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:approve");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = approveReleaseTargetSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_RELEASE_TARGET", message: input.error.issues[0]?.message });
    }
    try {
      return platformReleaseTargetSchema.parse(await manager.approve(principal, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.delete("/target", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:approve");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    try {
      await manager.clear(principal);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
