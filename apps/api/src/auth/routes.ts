import {
  administratorSessionSchema,
  installationKeyRecoveryRequestSchema,
  installationKeySessionRequestSchema,
  localAdministratorLoginRequestSchema,
  localAdministratorPasswordChangeRequestSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

/** The manager with the capabilities a handler asked for made non-optional. */
type SessionManagerWith<K extends keyof AdminSessionManager> =
  AdminSessionManager & Required<Pick<AdminSessionManager, K>>;

/**
 * The session manager, or null once the locked reply has been sent.
 *
 * `sessionManager` is absent for one reason and one only: the process started
 * without a usable database URL, master key or Installation Key, so
 * bootstrapState is LOCKED and nothing here can verify anything. That is a
 * property of the installation, not of what the caller typed -- and yet these
 * four routes each described it differently. `/local` answered 401 "The
 * username or password is incorrect.", `/password` and `/recovery` answered 400
 * "a valid ... is required", and only `/installation-key` said 423
 * PLATFORM_LOCKED. The operator reading those is on the first screen of a fresh
 * install, pasting a password the installer generated for them: three of the
 * four answers send them off to re-check a password that was never wrong, and
 * the one that would send them to look at the service is the one they were
 * least likely to reach first.
 *
 * Handing back a manager whose named capabilities are non-optional is what
 * keeps the fix from being undone: a handler cannot reach an operation without
 * having asked for it here, so there is no second reference to
 * `dependencies.sessionManager` for the absent case to fall through.
 */
function sessionManagerOrLocked<K extends keyof AdminSessionManager>(
  dependencies: AdminSessionRouteDependencies,
  reply: FastifyReply,
  ...capabilities: readonly K[]
): SessionManagerWith<K> | null {
  const manager = dependencies.sessionManager;
  if (manager && capabilities.every((capability) => manager[capability])) {
    return manager as SessionManagerWith<K>;
  }
  void reply.code(423).send({
    error: "PLATFORM_LOCKED",
    message: "OrcaSynapse installation trust is not ready.",
  });
  return null;
}

export async function registerAdminSessionRoutes(
  app: FastifyInstance,
  dependencies: AdminSessionRouteDependencies,
): Promise<void> {
  app.post("/local", async (request, reply) => {
    const manager = sessionManagerOrLocked(dependencies, reply, "createLocalPasswordSession");
    if (!manager) return reply;
    const parsed = localAdministratorLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // A body that does not parse is still a failed sign-in and is answered
      // like one, so a probe cannot tell a rejected shape from a rejected
      // credential.
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "The username or password is incorrect.",
      });
    }
    const issued = await manager.createLocalPasswordSession(
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
    const manager = sessionManagerOrLocked(dependencies, reply, "createInstallationKeySession");
    if (!manager) return reply;
    const parsed = installationKeySessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_SESSION_REQUEST",
        message: "A valid Installation Key is required.",
      });
    }
    const issued = await manager.createInstallationKeySession(parsed.data.installationKey, {
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
    const manager = sessionManagerOrLocked(dependencies, reply, "changeLocalPassword");
    if (!manager) return reply;
    const parsed = localAdministratorPasswordChangeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_PASSWORD_CHANGE",
        message: "A valid current password and a different new password are required.",
      });
    }
    /*
     * An expired session and a wrong current password are both refusals, and
     * telling them apart matters here more than anywhere else in the product.
     * This is the first screen a new installation shows, the operator is
     * copying a generated password out of a vault, and being told the password
     * is wrong when the session simply timed out sends them round the loop
     * again with the same correct password.
     *
     * Checking the session first also slides its idle window, so a submit that
     * arrives inside the window can never be refused for staleness.
     */
    if (!(await manager.authenticate(adminSessionToken(request)))) {
      return reply.code(401).send({
        error: "SESSION_EXPIRED",
        message: "This administrator session expired. Sign in again to set a new password.",
      });
    }
    const issued = await manager.changeLocalPassword(
      adminSessionToken(request),
      parsed.data.currentPassword,
      parsed.data.newPassword,
      { sourceIp: request.ip, userAgent: request.headers["user-agent"] },
    );
    if (!issued) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "The current password is incorrect.",
      });
    }
    return reply
      .header("set-cookie", sessionCookie(issued.token, requestUsesTls(request)))
      .send(administratorSessionSchema.parse(issued.principal));
  });

  app.put("/recovery", async (request, reply) => {
    const manager = sessionManagerOrLocked(dependencies, reply, "recoverLocalAdministrator");
    if (!manager) return reply;
    const parsed = installationKeyRecoveryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_RECOVERY_REQUEST",
        message: "A valid local username and new password are required.",
      });
    }
    const issued = await manager.recoverLocalAdministrator(
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
