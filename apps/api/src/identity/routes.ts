import {
  enterpriseSessionSchema,
  localPersonLoginRequestSchema,
  localPersonPasswordChangeRequestSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  EnterpriseIdentityError,
  enterpriseSessionCookie,
  enterpriseSessionToken,
  expiredEnterpriseSessionCookie,
  type EnterpriseIdentityManager,
} from "./enterprise-session.js";

export interface IdentityRouteOptions {
  manager?: EnterpriseIdentityManager;
}

function requestContext(request: FastifyRequest) {
  return {
    sourceIp: request.ip,
    userAgent: request.headers["user-agent"],
  };
}

function secureRequest(request: FastifyRequest): boolean {
  return request.protocol === "https";
}



function locked() {
  return {
    error: "PLATFORM_LOCKED",
    message: "Enterprise identity services are not ready.",
  };
}

function publicIdentityError(error: EnterpriseIdentityError) {
  return { error: error.code, message: error.message };
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  options: IdentityRouteOptions,
): Promise<void> {
  /**
   * Local sign-in for a person an administrator created.
   *
   * Deliberately answers one message for every rejection -- wrong password,
   * unknown username, disabled account, active lockout. The manager already
   * pays the same verification cost when no account matches; leaking the
   * difference here in the response body would undo that.
   */
  app.post("/auth/local/login", async (request, reply) => {
    if (!options.manager) return reply.code(423).send(locked());
    /*
     * Parsed by contract rather than by hand. The hand-rolled version had no
     * length ceiling, and a failed sign-in writes the username into
     * `AuditEvent.metadata` -- a table nothing prunes -- so an unauthenticated
     * caller could store as much text per attempt as they cared to send. The
     * administrator route next door had been bounded by its contract all along.
     */
    const parsed = localPersonLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "LOGIN_INVALID", message: "Enter a username and a password." });
    }
    const username = parsed.data.username.toLowerCase();
    const { password } = parsed.data;
    try {
      const issued = await options.manager.signInWithPassword(username, password, requestContext(request));
      void reply.header("set-cookie", enterpriseSessionCookie(issued.token, secureRequest(request)));
      return reply.code(200).send({ displayName: issued.principal.displayName });
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) {
        return reply.code(error.statusCode).send(publicIdentityError(error));
      }
      throw error;
    }
  });

  app.put("/auth/local/password", async (request, reply) => {
    if (!options.manager) return reply.code(423).send(locked());
    const parsed = localPersonPasswordChangeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_PASSWORD_CHANGE",
        message: "A valid current password and a different new password are required.",
      });
    }
    /*
     * An expired session and a wrong current password are both refusals, and
     * telling them apart matters here the same way it does for the
     * administrator change: this is the first screen after a generated
     * password is copied out of a vault, and blaming the password when the
     * cookie simply aged out sends them round the loop again with the same
     * correct password.
     *
     * Checking the session first also slides its idle window, so a submit that
     * arrives inside the window can never be refused for staleness.
     */
    const token = enterpriseSessionToken(request.headers.cookie);
    if (!(await options.manager.authenticate(token))) {
      return reply.code(401).send({
        error: "SESSION_EXPIRED",
        message: "This session expired. Sign in again to set a new password.",
      });
    }
    try {
      const issued = await options.manager.changeLocalPassword(
        token,
        parsed.data.currentPassword,
        parsed.data.newPassword,
        requestContext(request),
      );
      void reply.header("set-cookie", enterpriseSessionCookie(issued.token, secureRequest(request)));
      return enterpriseSessionSchema.parse(issued.principal.session);
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) {
        return reply.code(error.statusCode).send(publicIdentityError(error));
      }
      throw error;
    }
  });

  app.get("/session", async (request, reply) => {
    if (!options.manager) return reply.code(423).send(locked());
    const principal = await options.manager.authenticate(
      enterpriseSessionToken(request.headers.cookie),
    );
    if (!principal) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "An active enterprise session is required.",
      });
    }
    return enterpriseSessionSchema.parse(principal.session);
  });

  app.delete("/session", async (request, reply) => {
    if (!options.manager) return reply.code(423).send(locked());
    await options.manager.revoke(enterpriseSessionToken(request.headers.cookie));
    void reply.header("set-cookie", expiredEnterpriseSessionCookie(secureRequest(request)));
    return reply.code(204).send();
  });
}
