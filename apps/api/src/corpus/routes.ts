import {
  createHermesCorpusMutationSchema,
  decideHermesCorpusMutationSchema,
  hermesCorpusEntryKindSchema,
  hermesCorpusEntryListSchema,
  hermesCorpusMutationListSchema,
  hermesCorpusMutationReceiptSchema,
  hermesCorpusMutationResultSchema,
  hermesCorpusMutationSchema,
  hermesCorpusOverviewSchema,
  hermesCorpusRevisionListSchema,
  hermesCorpusSignedDesiredStateSchema,
  hermesCorpusSnapshotReceiptSchema,
  hermesCorpusSnapshotUploadSchema,
  type AdminScope,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import { RuntimeNodeAuthenticationError, type NodeSignatureHeaders } from "../runtime-nodes/runtime-node-manager.js";
import {
  CorpusConflictError,
  CorpusNotFoundError,
  CorpusValidationError,
  type HermesCorpusManager,
} from "./corpus-manager.js";

export interface CorpusRouteOptions {
  sessionManager?: AdminSessionManager;
  manager?: HermesCorpusManager;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function managerOrLocked(options: CorpusRouteOptions, reply: FastifyReply): HermesCorpusManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Hermes corpus services are not ready." });
  return null;
}

async function sendError(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof CorpusNotFoundError) return reply.code(404).send({ error: "CORPUS_NOT_FOUND", message: error.message });
  if (error instanceof CorpusConflictError) return reply.code(409).send({ error: "CORPUS_CONFLICT", message: error.message });
  if (error instanceof CorpusValidationError) return reply.code(400).send({ error: "INVALID_CORPUS_REQUEST", message: error.message });
  if (error instanceof RuntimeNodeAuthenticationError) return reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: error.message });
  throw error;
}

async function admin(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CorpusRouteOptions,
  scope: AdminScope,
) {
  return requireAdmin(request, reply, options.sessionManager, scope);
}

export async function registerRuntimeCorpusRoutes(app: FastifyInstance, options: CorpusRouteOptions): Promise<void> {
  // The VM2 companion caps mirrored text at 640 KiB, but a 1,000-file
  // snapshot can carry enough path/hash metadata to exceed Fastify's 1 MiB
  // default. Keep the signed protocol bounded while accepting its real worst
  // case without turning a complete scan into a false outage.
  app.post<{ Params: { nodeId: string } }>("/:nodeId/corpus/snapshot", { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    if (!UUID_PATTERN.test(request.params.nodeId)) return reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: "This runtime node is not recognized." });
    const input = hermesCorpusSnapshotUploadSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_CORPUS_SNAPSHOT", message: input.error.issues[0]?.message });
    try {
      return hermesCorpusSnapshotReceiptSchema.parse(await manager.uploadSnapshot(request.params.nodeId, signatureHeaders(request), input.data));
    } catch (error) { return sendError(error, reply); }
  });

  app.get<{ Params: { nodeId: string } }>("/:nodeId/corpus/desired-state", async (request, reply) => {
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    if (!UUID_PATTERN.test(request.params.nodeId)) return reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: "This runtime node is not recognized." });
    try {
      return hermesCorpusSignedDesiredStateSchema.parse(await manager.desiredState(request.params.nodeId, signatureHeaders(request)));
    } catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: { nodeId: string } }>("/:nodeId/corpus/mutation-result", async (request, reply) => {
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    if (!UUID_PATTERN.test(request.params.nodeId)) return reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: "This runtime node is not recognized." });
    const input = hermesCorpusMutationResultSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_CORPUS_RESULT", message: input.error.issues[0]?.message });
    try {
      return hermesCorpusMutationReceiptSchema.parse(await manager.completeMutation(request.params.nodeId, signatureHeaders(request), input.data));
    } catch (error) { return sendError(error, reply); }
  });
}

export async function registerAdminCorpusRoutes(app: FastifyInstance, options: CorpusRouteOptions): Promise<void> {
  app.get("/overview", async (request, reply) => {
    const principal = await admin(request, reply, options, "corpus:metadata:read");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    return manager ? hermesCorpusOverviewSchema.parse(await manager.overview()) : reply;
  });

  app.get<{ Querystring: { nodeId?: string; q?: string; kind?: string; includeDeleted?: string; includeContent?: string } }>("/entries", async (request, reply) => {
    const includeContent = request.query.includeContent !== "false";
    const principal = await admin(request, reply, options, includeContent ? "corpus:content:read" : "corpus:metadata:read");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    if (!request.query.nodeId || !UUID_PATTERN.test(request.query.nodeId)) return reply.code(400).send({ error: "INVALID_CORPUS_QUERY", message: "A valid runtime node is required." });
    const kind = request.query.kind ? hermesCorpusEntryKindSchema.safeParse(request.query.kind) : null;
    if (kind && !kind.success) return reply.code(400).send({ error: "INVALID_CORPUS_QUERY", message: "The corpus kind is invalid." });
    return hermesCorpusEntryListSchema.parse({ items: await manager.entries({
      nodeId: request.query.nodeId,
      ...(request.query.q ? { query: request.query.q } : {}),
      ...(kind?.success ? { kind: kind.data } : {}),
      includeDeleted: request.query.includeDeleted === "true",
      includeContent,
    }) });
  });

  app.get<{ Params: { entryId: string }; Querystring: { includeContent?: string } }>("/entries/:entryId/revisions", async (request, reply) => {
    const includeContent = request.query.includeContent !== "false";
    const principal = await admin(request, reply, options, includeContent ? "corpus:content:read" : "corpus:metadata:read");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    if (!UUID_PATTERN.test(request.params.entryId)) return reply.code(404).send({ error: "CORPUS_NOT_FOUND", message: "The corpus entry does not exist." });
    try { return hermesCorpusRevisionListSchema.parse({ items: await manager.revisions(request.params.entryId, includeContent) }); }
    catch (error) { return sendError(error, reply); }
  });

  app.get<{ Querystring: { nodeId?: string } }>("/mutations", async (request, reply) => {
    const principal = await admin(request, reply, options, "corpus:content:read");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    if (request.query.nodeId && !UUID_PATTERN.test(request.query.nodeId)) return reply.code(400).send({ error: "INVALID_CORPUS_QUERY", message: "The runtime node is invalid." });
    return hermesCorpusMutationListSchema.parse({ items: await manager.mutations(request.query.nodeId) });
  });

  app.post("/mutations", async (request, reply) => {
    const input = createHermesCorpusMutationSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_CORPUS_MUTATION", message: input.error.issues[0]?.message });
    const destructive = ["MEMORY_REMOVE", "SKILL_DELETE", "SKILL_REMOVE_FILE"].includes(input.data.operation);
    const principal = await admin(request, reply, options, destructive ? "corpus:delete" : "corpus:write");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    try { return hermesCorpusMutationSchema.parse(await manager.createMutation(principal, input.data)); }
    catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: { mutationId: string } }>("/mutations/:mutationId/decision", async (request, reply) => {
    const principal = await admin(request, reply, options, "corpus:approve");
    if (!principal) return reply;
    const manager = managerOrLocked(options, reply);
    if (!manager) return reply;
    const input = decideHermesCorpusMutationSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_CORPUS_DECISION", message: input.error.issues[0]?.message });
    if (!UUID_PATTERN.test(request.params.mutationId)) return reply.code(404).send({ error: "CORPUS_NOT_FOUND", message: "The corpus mutation does not exist." });
    try { return hermesCorpusMutationSchema.parse(await manager.decideMutation(principal, request.params.mutationId, input.data)); }
    catch (error) { return sendError(error, reply); }
  });
}
