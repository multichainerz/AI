import {
  enterpriseSessionSchema,
  localPersonPasswordChangeRequestSchema,
  oidcStatusSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sessionCookie } from "../auth/admin-session.js";
import {
  EnterpriseIdentityError,
  enterpriseSessionCookie,
  enterpriseSessionToken,
  expiredEnterpriseSessionCookie,
  expiredOidcStateCookie,
  oidcStateCookie,
  oidcStateToken,
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

function safeReturnTo(value: unknown): string {
  // The second character must be neither `/` nor `\`. Blocking only `//` is not
  // enough: browsers treat `/\host` as scheme-relative for special schemes, so
  // `/\evil.example` resolved to `https://evil.example/` — an off-site redirect
  // handed to the user at the moment they complete a genuine corporate SSO,
  // which is the most convincing possible setup for a credential-replay page.
  //
  // Every C0 control and DEL is refused rather than CR and LF alone. URL
  // parsing strips tab as well as CR and LF before resolving, while Node only
  // refuses CR and LF in a header value, so `/<tab>/evil.example` passed this
  // check, survived as a Location header, and resolved to the same off-site
  // target.
  return typeof value === "string" && value.length <= 500 && /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/.test(value)
    ? value
    : "/";
}

function queryString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
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
  app.get("/auth/oidc/status", async (_request, reply) => {
    if (!options.manager) return reply.code(423).send(locked());
    return oidcStatusSchema.parse(await options.manager.status());
  });

  app.get("/auth/oidc/start", async (request, reply) => {
    if (!options.manager) return reply.code(423).send(locked());
    const query = request.query as Record<string, unknown>;
    try {
      const started = await options.manager.startLogin(
        safeReturnTo(query.returnTo),
        requestContext(request),
      );
      void reply.header("set-cookie", oidcStateCookie(started.stateToken, secureRequest(request)));
      return reply.redirect(started.authorizationUrl);
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) {
        return reply.code(error.statusCode).send(publicIdentityError(error));
      }
      throw error;
    }
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    const secure = secureRequest(request);
    void reply.header("set-cookie", expiredOidcStateCookie(secure));
    if (!options.manager) return reply.code(423).send(locked());
    const query = request.query as Record<string, unknown>;
    const providerError = queryString(query.error, 160);
    if (providerError) {
      return reply.code(401).send({
        error: "OIDC_PROVIDER_ERROR",
        message: "The identity provider did not complete enterprise sign-in.",
      });
    }
    const code = queryString(query.code, 8_192);
    const state = queryString(query.state, 128);
    if (!code || !state) {
      return reply.code(400).send({
        error: "OIDC_CALLBACK_INVALID",
        message: "The enterprise sign-in callback is incomplete.",
      });
    }
    try {
      const issued = await options.manager.completeLogin(
        code,
        state,
        oidcStateToken(request.headers.cookie),
        requestContext(request),
      );
      void reply.header("set-cookie", [
        expiredOidcStateCookie(secure),
        enterpriseSessionCookie(issued.token, secure),
        ...(issued.administratorSession ? [sessionCookie(issued.administratorSession.token, secure)] : []),
      ]);
      return reply.redirect(safeReturnTo(issued.returnTo));
    } catch (error) {
      if (error instanceof EnterpriseIdentityError) {
        return reply.code(error.statusCode).send(publicIdentityError(error));
      }
      throw error;
    }
  });

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
    const body = request.body as Record<string, unknown>;
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) {
      return reply.code(400).send({ error: "LOGIN_INVALID", message: "Enter a username and a password." });
    }
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
