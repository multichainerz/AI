import {
  documentDetailSchema,
  documentListSchema,
  documentMetricsSchema,
  documentUploadMetadataSchema,
  quarantineDecisionSchema,
  type AdminScope,
} from "@aihub/contracts";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminSessionToken,
  type AdminSessionManager,
} from "../auth/admin-session.js";
import {
  enterpriseSessionToken,
  type EnterpriseIdentityManager,
} from "../identity/enterprise-session.js";
import {
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentStorageError,
  DocumentValidationError,
  type DocumentManager,
  type DocumentPrincipal,
} from "./document-manager.js";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface DocumentRouteOptions {
  sessionManager?: AdminSessionManager;
  identityManager?: EnterpriseIdentityManager;
  manager?: DocumentManager;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

async function requireDocumentPrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  options: DocumentRouteOptions,
  settings: { adminOnly?: boolean; adminScope?: AdminScope } = {},
): Promise<DocumentPrincipal | null> {
  const administrator = await options.sessionManager?.authenticate(adminSessionToken(request));
  if (administrator) {
    if (settings.adminScope && !administrator.scopes.includes(settings.adminScope)) {
      await reply.code(403).send({ error: "FORBIDDEN", message: `The administrator session does not grant '${settings.adminScope}'.` });
      return null;
    }
    return {
      id: administrator.id,
      subject: administrator.subject,
      identityMode: "ADMINISTRATOR_PREVIEW",
      scopes: administrator.scopes,
    };
  }
  if (!settings.adminOnly) {
    const enterprise = await options.identityManager?.authenticate(
      enterpriseSessionToken(request.headers.cookie),
    );
    if (enterprise) {
      if (!enterprise.scopes.includes("documents:use")) {
        await reply.code(403).send({ error: "FORBIDDEN", message: "The enterprise session does not grant document access." });
        return null;
      }
      return {
        id: enterprise.id,
        subject: enterprise.subject,
        identityMode: "ENTERPRISE",
        scopes: enterprise.scopes,
      };
    }
  }
  if (!options.identityManager && !options.sessionManager) {
    await reply.code(423).send({ error: "PLATFORM_LOCKED", message: "AIHub identity services are not ready." });
    return null;
  }
  await reply.code(401).send({ error: "UNAUTHORIZED", message: "An active AIHub session is required." });
  return null;
}

async function sendDocumentError(reply: FastifyReply, error: unknown): Promise<void> {
  if (error instanceof DocumentNotFoundError) {
    await reply.code(404).send({ error: "DOCUMENT_NOT_FOUND", message: error.message });
    return;
  }
  if (error instanceof DocumentValidationError) {
    await reply.code(400).send({ error: "INVALID_DOCUMENT", message: error.message });
    return;
  }
  if (error instanceof DocumentConflictError) {
    await reply.code(409).send({ error: "DOCUMENT_CONFLICT", message: error.message });
    return;
  }
  if (error instanceof DocumentStorageError) {
    await reply.code(503).send({ error: "DOCUMENT_STORAGE_UNAVAILABLE", message: error.message });
    return;
  }
  if (error && typeof error === "object" && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
    await reply.code(413).send({ error: "DOCUMENT_TOO_LARGE", message: "Document exceeds the 50 MB upload limit." });
    return;
  }
  throw error;
}

function managerOrLocked(options: DocumentRouteOptions, reply: FastifyReply): DocumentManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Document services are not ready." });
  return null;
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  options: DocumentRouteOptions,
): Promise<void> {
  await app.register(multipart, {
    limits: { files: 1, fields: 0, fileSize: MAX_UPLOAD_BYTES + 1 },
  });

  app.get("/", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminScope: "documents:read" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    return documentListSchema.parse(await manager.list(principal));
  });

  app.post("/", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminScope: "documents:review" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    const metadata = documentUploadMetadataSchema.safeParse(request.query);
    if (!metadata.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: metadata.error.issues[0]?.message });
    }
    try {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "INVALID_REQUEST", message: "One document file is required." });
      const result = await manager.upload(principal, {
        fileName: file.filename,
        declaredMediaType: file.mimetype,
        stream: file.file,
      }, metadata.data);
      return reply.code(201).send(documentDetailSchema.parse(result));
    } catch (error) {
      await sendDocumentError(reply, error);
    }
  });

  app.get("/metrics", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminOnly: true, adminScope: "documents:read" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    return documentMetricsSchema.parse(await manager.metrics());
  });

  app.get("/:documentId", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminScope: "documents:read" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    const id = uuid((request.params as Record<string, unknown>).documentId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Document ID is invalid." });
    try {
      return documentDetailSchema.parse(await manager.get(principal, id));
    } catch (error) {
      await sendDocumentError(reply, error);
    }
  });

  app.post("/:documentId/quarantine-decision", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminOnly: true, adminScope: "documents:review" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    const id = uuid((request.params as Record<string, unknown>).documentId);
    const input = quarantineDecisionSchema.safeParse(request.body);
    if (!id || !input.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: id ? input.error?.issues[0]?.message : "Document ID is invalid." });
    }
    try {
      return documentDetailSchema.parse(await manager.decideQuarantine(principal, id, input.data));
    } catch (error) {
      await sendDocumentError(reply, error);
    }
  });

  app.post("/:documentId/reprocess", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminScope: "documents:reprocess" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    const id = uuid((request.params as Record<string, unknown>).documentId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Document ID is invalid." });
    try {
      return documentDetailSchema.parse(await manager.reprocess(principal, id));
    } catch (error) {
      await sendDocumentError(reply, error);
    }
  });

  app.get("/:documentId/artifacts/:artifactId/download", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminScope: "documents:read" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    const params = request.params as Record<string, unknown>;
    const documentId = uuid(params.documentId);
    const artifactId = uuid(params.artifactId);
    if (!documentId || !artifactId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Document or artifact ID is invalid." });
    try {
      const download = await manager.download(principal, documentId, artifactId);
      void reply.header("content-type", download.mediaType);
      void reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`);
      return reply.send(Buffer.from(download.bytes));
    } catch (error) {
      await sendDocumentError(reply, error);
    }
  });

  app.delete("/:documentId", async (request, reply) => {
    const principal = await requireDocumentPrincipal(request, reply, options, { adminScope: "documents:delete" });
    if (!principal) return;
    const manager = managerOrLocked(options, reply);
    if (!manager) return;
    const id = uuid((request.params as Record<string, unknown>).documentId);
    const query = request.query as Record<string, unknown>;
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Document ID is invalid." });
    const reason = typeof query.reason === "string" && query.reason.length <= 1_000 ? query.reason : undefined;
    try {
      await manager.delete(principal, id, { force: query.force === "true", reason });
      return reply.code(204).send();
    } catch (error) {
      await sendDocumentError(reply, error);
    }
  });
}
