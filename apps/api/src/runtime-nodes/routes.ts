import {
  createHermesNodeInvitationSchema,
  enrollHermesNodeSchema,
  hermesNodeEnrollmentBundleSchema,
  hermesNodeEnrollmentResultSchema,
  hermesNodeHeartbeatResultSchema,
  hermesNodeHeartbeatSchema,
  hermesNodeInvitationSchema,
  hermesRuntimeNodeListSchema,
  hermesRuntimeNodeSchema,
  mutateHermesRuntimeNodeSchema,
  removeHermesRuntimeNodeSchema,
  resolveHermesNodeInvitationSchema,
  runtimeDesiredStateSchema,
} from "@orcasynapse/contracts";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import {
  RuntimeNodeAuthenticationError,
  RuntimeNodeConflictError,
  RuntimeNodeEnrollmentError,
  RuntimeNodeNotFoundError,
  type HermesRuntimeNodeManager,
  type NodeSignatureHeaders,
} from "./runtime-node-manager.js";

export interface RuntimeNodeRouteOptions {
  sessionManager?: AdminSessionManager;
  manager?: HermesRuntimeNodeManager;
}

const AGENTIC_NODE_INSTALLER_PATH = new URL("../../../../scripts/install-agentic-node.sh", import.meta.url);
const AGENTIC_NODE_REMOVER_PATH = new URL("../../../../scripts/remove-agentic-node.sh", import.meta.url);

function managerOrLocked(options: RuntimeNodeRouteOptions, reply: FastifyReply): HermesRuntimeNodeManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Hermes runtime-node services are not ready." });
  return null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function signatureHeaders(request: FastifyRequest): NodeSignatureHeaders {
  return {
    timestamp: headerValue(request.headers["x-orcasynapse-node-timestamp"]),
    nonce: headerValue(request.headers["x-orcasynapse-node-nonce"]),
    signature: headerValue(request.headers["x-orcasynapse-node-signature"]),
  };
}

async function sendError(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof RuntimeNodeNotFoundError) {
    return reply.code(404).send({ error: "NODE_NOT_FOUND", message: error.message });
  }
  if (error instanceof RuntimeNodeConflictError) {
    return reply.code(409).send({ error: "NODE_CONFLICT", message: error.message });
  }
  if (error instanceof RuntimeNodeAuthenticationError) {
    return reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: error.message });
  }
  if (error instanceof RuntimeNodeEnrollmentError) {
    const status = error.code === "EXPIRED" ? 410 : error.code === "CONSUMED" ? 409 : 401;
    return reply.code(status).send({ error: `ENROLLMENT_${error.code}`, message: error.message });
  }
  throw error;
}

export async function registerRuntimeNodeInstallerRoutes(
  app: FastifyInstance,
  options: RuntimeNodeRouteOptions,
): Promise<void> {
  app.get("/agentic-node.sh", async (_request, reply) => {
    const manager = options.manager;
    if (!manager) {
      return reply.code(404).send({
        error: "AGENTIC_INSTALLER_UNAVAILABLE",
        message: "No Agentic System installer is currently available.",
      });
    }

    const readiness = await manager.installerReadiness();
    if (!readiness.ready) {
      return reply.code(404).send({
        error: "AGENTIC_INSTALLER_UNAVAILABLE",
        message: "No Agentic System installer is currently available.",
      });
    }

    const installer = await readFile(AGENTIC_NODE_INSTALLER_PATH, "utf8");
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", "inline; filename=install-agentic-node.sh")
      .type("text/x-shellscript; charset=utf-8")
      .send(installer);
  });

  app.get("/remove-agentic-node.sh", async (_request, reply) => {
    const remover = await readFile(AGENTIC_NODE_REMOVER_PATH, "utf8");
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", "inline; filename=remove-agentic-node.sh")
      .type("text/x-shellscript; charset=utf-8")
      .send(remover);
  });
}

export async function registerRuntimeNodeRoutes(app: FastifyInstance, options: RuntimeNodeRouteOptions): Promise<void> {
  app.post("/bootstrap", async (request, reply) => {
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    const input = resolveHermesNodeInvitationSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_ENROLLMENT", message: input.error.issues[0]?.message });
    }
    try {
      return hermesNodeEnrollmentBundleSchema.parse(await manager.resolveInvitation(input.data.token));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/enroll", async (request, reply) => {
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    const input = enrollHermesNodeSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_ENROLLMENT", message: input.error.issues[0]?.message });
    }
    try {
      return hermesNodeEnrollmentResultSchema.parse(await manager.enroll(input.data, request.ip));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Params: { nodeId: string } }>("/:nodeId/heartbeat", async (request, reply) => {
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    const input = hermesNodeHeartbeatSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_HEARTBEAT", message: input.error.issues[0]?.message });
    }
    try {
      return hermesNodeHeartbeatResultSchema.parse(
        await manager.heartbeat(request.params.nodeId, signatureHeaders(request), input.data),
      );
    } catch (error) {
      return sendError(error, reply);
    }
  });

  // GET, but signed like every other node request: the node proves who it is
  // before the control plane will say anything about what it should be running.
  app.get<{ Params: { nodeId: string } }>("/:nodeId/desired-state", async (request, reply) => {
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    try {
      return runtimeDesiredStateSchema.parse(
        await manager.desiredState(request.params.nodeId, signatureHeaders(request)),
      );
    } catch (error) {
      return sendError(error, reply);
    }
  });

}

export async function registerAdminRuntimeNodeRoutes(app: FastifyInstance, options: RuntimeNodeRouteOptions): Promise<void> {
  app.get("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    return hermesRuntimeNodeListSchema.parse({ items: await manager.list() });
  });

  app.post("/invitations", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = createHermesNodeInvitationSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_NODE_INVITATION", message: input.error.issues[0]?.message });
    }
    try {
      return reply.code(201).send(hermesNodeInvitationSchema.parse(await manager.createInvitation(principal, input.data)));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Params: { nodeId: string } }>("/:nodeId/actions", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = mutateHermesRuntimeNodeSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_NODE_ACTION", message: input.error.issues[0]?.message });
    }
    try {
      return hermesRuntimeNodeSchema.parse(await manager.mutate(principal, request.params.nodeId, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.delete<{ Params: { nodeId: string } }>("/:nodeId", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = removeHermesRuntimeNodeSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_NODE_REMOVAL", message: input.error.issues[0]?.message });
    }
    try {
      await manager.remove(principal, request.params.nodeId, input.data);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
