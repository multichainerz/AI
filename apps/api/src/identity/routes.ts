import { enterpriseSessionSchema, oidcStatusSchema } from "@aihub/contracts";
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
  return typeof value === "string" && value.length <= 500 && /^\/(?!\/)[^\r\n]*$/.test(value)
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
