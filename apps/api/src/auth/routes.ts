import {
  administratorSessionSchema,
  installationKeyRecoveryRequestSchema,
  installationKeySessionRequestSchema,
  localAdministratorLoginRequestSchema,
  localAdministratorPasswordChangeRequestSchema,
} from "@aihub/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  adminSessionToken,
  expiredSessionCookie,
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
  app.post("/local", async (request, reply) => {
    const parsed = localAdministratorLoginRequestSchema.safeParse(request.body);
    if (!parsed.success || !dependencies.sessionManager?.createLocalPasswordSession) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "The username or password is incorrect.",
      });
    }
    const issued = await dependencies.sessionManager.createLocalPasswordSession(
      parsed.data.username,
      parsed.data.password,
      { sourceIp: request.ip, userAgent: request.headers["user-agent"] },
    );
    if (!issued) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "The username or password is incorrect.",
      });
    }
    return reply
      .header("set-cookie", sessionCookie(issued.token, requestUsesTls(request)))
      .code(201)
      .send(administratorSessionSchema.parse(issued.principal));
  });

  app.post("/installation-key", async (request, reply) => {
    if (!dependencies.sessionManager) {
      return reply.code(423).send({
        error: "PLATFORM_LOCKED",
        message: "AIHub installation trust is not ready.",
      });
    }
    const parsed = installationKeySessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_SESSION_REQUEST",
        message: "A valid Installation Key is required.",
      });
    }
    const issued = await dependencies.sessionManager.createInstallationKeySession(parsed.data.installationKey, {
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

  app.put("/password", async (request, reply) => {
    const parsed = localAdministratorPasswordChangeRequestSchema.safeParse(request.body);
    if (!parsed.success || !dependencies.sessionManager?.changeLocalPassword) {
      return reply.code(400).send({
        error: "INVALID_PASSWORD_CHANGE",
        message: "A valid current password and a different new password are required.",
      });
    }
    const issued = await dependencies.sessionManager.changeLocalPassword(
      adminSessionToken(request),
      parsed.data.currentPassword,
      parsed.data.newPassword,
      { sourceIp: request.ip, userAgent: request.headers["user-agent"] },
    );
    if (!issued) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "The password could not be changed with the supplied credentials.",
      });
    }
    return reply
      .header("set-cookie", sessionCookie(issued.token, requestUsesTls(request)))
      .send(administratorSessionSchema.parse(issued.principal));
  });

  app.put("/recovery", async (request, reply) => {
    const parsed = installationKeyRecoveryRequestSchema.safeParse(request.body);
    if (!parsed.success || !dependencies.sessionManager?.recoverLocalAdministrator) {
      return reply.code(400).send({
        error: "INVALID_RECOVERY_REQUEST",
        message: "A valid local username and new password are required.",
      });
    }
    const issued = await dependencies.sessionManager.recoverLocalAdministrator(
      adminSessionToken(request),
      parsed.data.username,
      parsed.data.newPassword,
      { sourceIp: request.ip, userAgent: request.headers["user-agent"] },
    );
    if (!issued) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Local administrator recovery failed.",
      });
    }
    return reply
      .header("set-cookie", sessionCookie(issued.token, requestUsesTls(request)))
      .send(administratorSessionSchema.parse(issued.principal));
  });

  app.get("/", async (request, reply) => {
    const principal = await dependencies.sessionManager?.authenticate(adminSessionToken(request));
    if (!principal) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "An active administrator session is required.",
      });
    }
    return administratorSessionSchema.parse(principal);
  });

  app.delete("/", async (request, reply) => {
    await dependencies.sessionManager?.revoke(adminSessionToken(request));
    return reply
      .header("set-cookie", expiredSessionCookie(requestUsesTls(request)))
      .code(204)
      .send();
  });
}
