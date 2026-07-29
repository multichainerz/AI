import {
  administratorSessionSchema,
  bootstrapSessionRequestSchema,
} from "@aihub/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  adminSessionToken,
  expiredSessionCookie,
  requireAdmin,
  sessionCookie,
  type AdminSessionManager,
} from "./admin-session.js";

interface AdminSessionRouteDependencies {
  sessionManager?: AdminSessionManager;
}

function requestUsesTls(request: FastifyRequest): boolean {
  return request.protocol === "https";
}

export async function registerAdminSessionRoutes(
  app: FastifyInstance,
  dependencies: AdminSessionRouteDependencies,
): Promise<void> {
  app.post("/bootstrap", async (request, reply) => {
    if (!dependencies.sessionManager) {
      return reply.code(423).send({
        error: "PLATFORM_LOCKED",
        message: "AIHub bootstrap trust is not ready.",
      });
    }
    const parsed = bootstrapSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_SESSION_REQUEST",
        message: "A valid bootstrap administrator token is required.",
      });
    }
    const issued = await dependencies.sessionManager.createBootstrapSession(parsed.data.token, {
      sourceIp: request.ip,
      userAgent: request.headers["user-agent"],
    });
    if (!issued) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Administrator authentication failed.",
      });
    }
    return reply
      .header("set-cookie", sessionCookie(issued.token, requestUsesTls(request)))
      .code(201)
      .send(administratorSessionSchema.parse(issued.principal));
  });

  app.get("/", async (request, reply) => {
    const principal = await requireAdmin(
      request,
      reply,
      dependencies.sessionManager,
      "connections:read",
    );
    return principal ? administratorSessionSchema.parse(principal) : reply;
  });

  app.delete("/", async (request, reply) => {
    await dependencies.sessionManager?.revoke(adminSessionToken(request));
    return reply
      .header("set-cookie", expiredSessionCookie(requestUsesTls(request)))
      .code(204)
      .send();
  });
}
