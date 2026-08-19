import { chatArtifactListSchema, chatArtifactSchema, hermesArtifactReceiptSchema, hermesArtifactUploadSchema, uploadChatArtifactSchema } from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminSessionManager } from "../auth/admin-session.js";
import { requireChatPrincipal } from "../chat/routes.js";
import type { EnterpriseIdentityManager } from "../identity/enterprise-session.js";
import { RuntimeNodeAuthenticationError, type NodeSignatureHeaders } from "../runtime-nodes/runtime-node-manager.js";
import {
  ArtifactNotFoundError,
  ArtifactNotRetainedError,
  ArtifactValidationError,
  type ChatArtifactManager,
} from "./artifact-manager.js";

export interface ArtifactRouteOptions {
  manager?: ChatArtifactManager;
}

export interface ChatArtifactRouteOptions {
  sessionManager?: AdminSessionManager;
  identityManager?: EnterpriseIdentityManager;
  manager?: ChatArtifactManager;
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

async function sendError(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof ArtifactValidationError) return reply.code(400).send({ error: "INVALID_ARTIFACT_UPLOAD", message: error.message });
  if (error instanceof RuntimeNodeAuthenticationError) return reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: error.message });
  throw error;
}

export async function registerRuntimeArtifactRoutes(app: FastifyInstance, options: ArtifactRouteOptions): Promise<void> {
  /*
   * A 4 MiB file travels base64-encoded inside signed JSON, which inflates it
   * by 4/3 to ~5.6 MiB before envelope fields -- past Fastify's 1 MiB default.
   * The limit is raised on this one route only; every other endpoint keeps the
   * tight default as its own defense.
   */
  app.post<{ Params: { nodeId: string } }>("/:nodeId/artifacts", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Artifact services are not ready." });
    if (!UUID_PATTERN.test(request.params.nodeId)) return reply.code(401).send({ error: "INVALID_NODE_SIGNATURE", message: "This runtime node is not recognized." });
    const input = hermesArtifactUploadSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_ARTIFACT_UPLOAD", message: input.error.issues[0]?.message });
    try {
      return hermesArtifactReceiptSchema.parse(await options.manager.ingest(request.params.nodeId, signatureHeaders(request), input.data));
    } catch (error) { return sendError(error, reply); }
  });
}

/**
 * A filename the Content-Disposition header can carry without becoming header
 * injection or an encoding surprise: ASCII-safe fallback plus the RFC 5987
 * form for everything else.
 */
function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function registerChatArtifactRoutes(app: FastifyInstance, options: ChatArtifactRouteOptions): Promise<void> {
  app.get<{ Querystring: { conversationId?: string } }>("/", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return reply;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Artifact services are not ready." });
    const conversationId = request.query.conversationId;
    if (conversationId !== undefined && !UUID_PATTERN.test(conversationId)) {
      return reply.code(400).send({ error: "INVALID_ARTIFACT_QUERY", message: "conversationId must be a UUID." });
    }
    return chatArtifactListSchema.parse(await options.manager.list(principal, conversationId ? { conversationId } : undefined));
  });

  /*
   * The person-facing sibling of the node ingest: same 4 MiB file in base64
   * inside JSON, so the same one-route body-limit raise. Owner and division
   * come from the session; the request names only the conversation and the
   * file.
   */
  app.post("/uploads", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return reply;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Artifact services are not ready." });
    const input = uploadChatArtifactSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_ARTIFACT_UPLOAD", message: input.error.issues[0]?.message });
    try {
      return reply.code(201).send(chatArtifactSchema.parse(await options.manager.upload(principal, input.data)));
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: error.message });
      return sendError(error, reply);
    }
  });

  app.get<{ Params: { artifactId: string } }>("/:artifactId/content", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return reply;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Artifact services are not ready." });
    if (!UUID_PATTERN.test(request.params.artifactId)) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND", message: "The requested artifact does not exist." });
    try {
      const { artifact, bytes } = await options.manager.download(principal, request.params.artifactId);
      /*
       * Always an attachment, always octet-stream, never the stored media
       * type: these bytes are agent-authored, and a governed dashboard must
       * not hand the browser an HTML or SVG file it will happily render on
       * this origin. The recorded media type stays in the metadata for the
       * UI to *say*; it is deliberately not what gets *served*.
       */
      return reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", contentDisposition(artifact.name))
        .header("content-length", String(bytes.byteLength))
        .type("application/octet-stream")
        .send(bytes);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND", message: error.message });
      if (error instanceof ArtifactNotRetainedError) return reply.code(409).send({ error: "ARTIFACT_NOT_RETAINED", message: error.message });
      throw error;
    }
  });
}
