import { createHash } from "node:crypto";
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
const HERMES_CORPUS_RECONCILER_PATH = new URL("../../../../scripts/hermes-corpus-reconciler.py", import.meta.url);
const HERMES_ARTIFACT_PUBLISHER_PATH = new URL("../../../../scripts/hermes-artifact-publisher.py", import.meta.url);

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

/**
 * Node identifiers reach a `uuid` column, so a malformed one is refused here.
 *
 * Bodies are schema-validated but path parameters were not, and PostgreSQL
 * answers a bad cast with 22P02 rather than "not found". That surfaced through
 * `sendError`'s rethrow as a **500 on unauthenticated routes**, where every
 * other bad-credential path fails closed with a 401 — an error-log amplifier
 * anyone could reach without a valid signature.
 */
const NODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rejectMalformedNodeId(nodeId: string, reply: FastifyReply): boolean {
  if (NODE_ID_PATTERN.test(nodeId)) return false;
  void reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: "This runtime node is not recognized." });
  return true;
}

/**
 * The same guard for the administrator routes, which it was never wired into.
 *
 * `POST /:nodeId/actions` and `DELETE /:nodeId` validate their bodies and then
 * hand the path parameter straight to a `uuid` column, so they had the 500 the
 * note above describes -- reachable with a valid session and a mistyped id.
 *
 * The answer differs from the unauthenticated one on purpose. There, the id
 * arrives as part of a signed request and a malformed one is a failed
 * credential, so 401 is the truth. Here the caller has already proved who they
 * are and what is wrong is the request, which is what the sibling admin routes
 * in tooling/routes.ts say with 400 and their own error code. Answering 401
 * would tell an administrator holding a perfectly good session that it was
 * refused, and an operator sent to re-authenticate over a typo'd id learns
 * nothing except to distrust the answer.
 */
function rejectMalformedAdminNodeId(nodeId: string, reply: FastifyReply, error: string): boolean {
  if (NODE_ID_PATTERN.test(nodeId)) return false;
  void reply.code(400).send({ error, message: "A runtime node id must be a UUID." });
  return true;
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

  app.get("/hermes-corpus-reconciler.py", async (_request, reply) => {
    const reconciler = await readFile(HERMES_CORPUS_RECONCILER_PATH, "utf8");
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", "inline; filename=hermes-corpus-reconciler.py")
      .type("text/x-python; charset=utf-8")
      .send(reconciler);
  });

  /*
   * The digest of the file above, so the node can check it received all of it.
   *
   * **This is an integrity check, not an authentication boundary, and the
   * difference matters enough to write down.** It travels the same unauthenticated
   * `/install` channel as the file it describes, so anyone who could substitute
   * the reconciler could substitute this too. It is worth serving anyway because
   * the check it replaces was `grep -Fq` for a magic string, which a truncated
   * download passes as long as the string landed in the bytes that arrived --
   * and the result is then installed 0755 and run as root by systemd.
   *
   * What actually authenticates this channel is that the node already trusts it
   * completely: `install-agentic-node.sh` is fetched the same way and piped into
   * `sudo bash`. Adding signing here without signing that would move the problem,
   * not solve it.
   */
  app.get("/hermes-corpus-reconciler.py.sha256", async (_request, reply) => {
    const reconciler = await readFile(HERMES_CORPUS_RECONCILER_PATH);
    return reply
      .header("cache-control", "no-store")
      .type("text/plain; charset=utf-8")
      .send(`${createHash("sha256").update(reconciler).digest("hex")}\n`);
  });

  app.get("/hermes-artifact-publisher.py", async (_request, reply) => {
    const publisher = await readFile(HERMES_ARTIFACT_PUBLISHER_PATH, "utf8");
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", "inline; filename=hermes-artifact-publisher.py")
      .type("text/x-python; charset=utf-8")
      .send(publisher);
  });

  // Same integrity-not-authentication caveat as the reconciler digest above.
  app.get("/hermes-artifact-publisher.py.sha256", async (_request, reply) => {
    const publisher = await readFile(HERMES_ARTIFACT_PUBLISHER_PATH);
    return reply
      .header("cache-control", "no-store")
      .type("text/plain; charset=utf-8")
      .send(`${createHash("sha256").update(publisher).digest("hex")}\n`);
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
    if (rejectMalformedNodeId(request.params.nodeId, reply)) return reply;
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
    if (rejectMalformedNodeId(request.params.nodeId, reply)) return reply;
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
    if (rejectMalformedAdminNodeId(request.params.nodeId, reply, "INVALID_NODE_ACTION")) return reply;
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
    if (rejectMalformedAdminNodeId(request.params.nodeId, reply, "INVALID_NODE_REMOVAL")) return reply;
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
