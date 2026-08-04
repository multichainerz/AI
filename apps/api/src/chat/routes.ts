import {
  attachChatDocumentSchema,
  agentMemoryRecordListSchema,
  chatConversationSchema,
  chatConversationListSchema,
  chatConversationSummarySchema,
  chatMessageSubmissionSchema,
  agentRunApprovalSchema,
  chatStreamEventSchema,
  chatFeedbackSchema,
  chatMetricsSchema,
  createChatConversationSchema,
  decideAgentRunApprovalSchema,
  forkChatConversationSchema,
  sendChatMessageSchema,
  setChatFeedbackSchema,
  updateChatConversationSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminSessionToken,
  requireAdmin,
  type AdminSessionManager,
} from "../auth/admin-session.js";
import {
  enterpriseSessionToken,
  type EnterpriseIdentityManager,
} from "../identity/enterprise-session.js";
import {
  ChatConfigurationError,
  ChatConversationConflictError,
  ChatConversationNotFoundError,
  ChatMessageNotFoundError,
  ChatPolicyViolationError,
  ChatRateLimitError,
  type ChatPrincipal,
  type ChatManager,
} from "./chat-manager.js";
import type { MemoryManager } from "../memory/memory-manager.js";

export interface ChatRouteOptions {
  sessionManager?: AdminSessionManager;
  identityManager?: EnterpriseIdentityManager;
  manager?: ChatManager;
  memoryManager?: MemoryManager;
}

async function requireChatPrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatRouteOptions,
): Promise<ChatPrincipal | null> {
  const administrator = await options.sessionManager?.authenticate(adminSessionToken(request));
  if (administrator?.scopes.includes("chat:use")) {
    return {
      id: administrator.id,
      subject: administrator.subject,
      identityMode: "ADMINISTRATOR_PREVIEW",
      scopes: administrator.scopes,
    };
  }

  const enterprise = await options.identityManager?.authenticate(
    enterpriseSessionToken(request.headers.cookie),
  );
  if (enterprise) {
    return {
      id: enterprise.id,
      subject: enterprise.subject,
      identityMode: "ENTERPRISE",
      scopes: enterprise.scopes,
    };
  }

  if (!options.identityManager && !options.sessionManager) {
    await reply.code(423).send({
      error: "PLATFORM_LOCKED",
      message: "OrcaSynapse identity services are not ready.",
    });
    return null;
  }
  await reply.code(401).send({
    error: "UNAUTHORIZED",
    message: "Sign in with an enterprise account or an authorized administrator session.",
  });
  return null;
}

function uuidParam(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

async function sendChatError(reply: FastifyReply, error: unknown): Promise<void> {
  if (error instanceof ChatMessageNotFoundError) {
    await reply.code(404).send({ error: "MESSAGE_NOT_FOUND", message: error.message });
    return;
  }
  if (error instanceof ChatConversationNotFoundError) {
    await reply.code(404).send({ error: "CONVERSATION_NOT_FOUND", message: error.message });
    return;
  }
  if (error instanceof ChatConversationConflictError) {
    await reply.code(409).send({ error: "CONVERSATION_CONFLICT", message: error.message });
    return;
  }
  if (error instanceof ChatConfigurationError) {
    await reply.code(503).send({ error: "CHAT_NOT_CONFIGURED", message: error.message });
    return;
  }
  if (error instanceof ChatRateLimitError) {
    await reply.code(429).send({ error: "CHAT_RATE_LIMITED", message: error.message });
    return;
  }
  if (error instanceof ChatPolicyViolationError) {
    await reply.code(422).send({ error: "GUARDRAIL_BLOCKED", message: error.message });
    return;
  }
  throw error;
}

function safeStreamError(error: unknown): string {
  if (
    error instanceof ChatMessageNotFoundError ||
    error instanceof ChatConversationNotFoundError ||
    error instanceof ChatConversationConflictError ||
    error instanceof ChatConfigurationError ||
    error instanceof ChatRateLimitError ||
    error instanceof ChatPolicyViolationError
  ) return error.message.slice(0, 500);
  return "The Hermes event stream was interrupted. Reconnect to resume from the last saved event.";
}

export async function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions,
): Promise<void> {
  app.get("/conversations", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    return chatConversationListSchema.parse(await options.manager.list(principal));
  });

  app.post("/conversations", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const input = createChatConversationSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    }
    try {
      return reply.code(201).send(
        chatConversationSummarySchema.parse(await options.manager.create(principal, input.data)),
      );
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.get("/conversations/:conversationId", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Conversation ID is invalid." });
    try {
      return chatConversationSchema.parse(await options.manager.get(principal, id));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.patch("/conversations/:conversationId", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    const input = updateChatConversationSchema.safeParse(request.body);
    if (!id || !input.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: id ? input.error?.issues[0]?.message : "Conversation ID is invalid.",
      });
    }
    try {
      return chatConversationSummarySchema.parse(await options.manager.update(principal, id, input.data));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.post("/conversations/:conversationId/messages", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    const input = sendChatMessageSchema.safeParse(request.body);
    if (!id || !input.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: id ? input.error?.issues[0]?.message : "Conversation ID is invalid.",
      });
    }

    try {
      return reply.code(202).send(chatMessageSubmissionSchema.parse(
        await options.manager.submitMessage(principal, id, input.data.content),
      ));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.get("/conversations/:conversationId/messages/:messageId/events", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const parameters = request.params as Record<string, unknown>;
    const conversation = uuidParam(parameters.conversationId);
    const message = uuidParam(parameters.messageId);
    if (!conversation || !message) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: "Conversation or message ID is invalid." });
    }
    const query = request.query as Record<string, unknown>;
    const queryCursor = typeof query.cursor === "string" && /^\d+$/.test(query.cursor) ? query.cursor : null;
    const headerCursor = typeof request.headers["last-event-id"] === "string" && /^\d+$/.test(request.headers["last-event-id"])
      ? request.headers["last-event-id"]
      : null;
    const controller = new AbortController();
    request.raw.once("close", () => controller.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": OrcaSynapse Hermes event stream\n\n");
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    heartbeat.unref();
    const emit = (value: unknown) => {
      const event = chatStreamEventSchema.parse(value);
      if (reply.raw.destroyed) return;
      const idLine = event.cursor ? `id: ${event.cursor}\n` : "";
      reply.raw.write(`${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await options.manager.subscribe(
        principal,
        conversation,
        message,
        queryCursor ?? headerCursor,
        emit,
        controller.signal,
      );
    } catch (error) {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: stream_error\ndata: ${JSON.stringify({ message: safeStreamError(error) })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.get("/memory", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.memoryManager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    void reply.header("cache-control", "no-store");
    // Scoped to the caller's own subject inside the manager, so this can only
    // ever return what an agent learned about the person asking.
    return agentMemoryRecordListSchema.parse(await options.memoryManager.recordsForOwner(principal.subject));
  });

  app.delete("/memory/:memoryId", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.memoryManager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const memoryId = uuidParam((request.params as Record<string, unknown>).memoryId);
    if (!memoryId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Memory ID is invalid." });
    try {
      await options.memoryManager.forget(
        { id: principal.id, ownerSubject: principal.subject },
        memoryId,
        "The person this memory is about asked for it to be forgotten.",
      );
      return reply.code(204).send();
    } catch {
      // A memory outside the caller's scope is indistinguishable from one that
      // does not exist, which is the point.
      return reply.code(404).send({ error: "NOT_FOUND", message: "That memory does not exist within your scope." });
    }
  });

  app.post("/conversations/:conversationId/documents", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Conversation ID is invalid." });
    const input = attachChatDocumentSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    try {
      return chatConversationSchema.parse(await options.manager.attachDocument(principal, id, input.data.documentId));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.delete("/conversations/:conversationId/documents/:documentId", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const params = request.params as Record<string, unknown>;
    const id = uuidParam(params.conversationId);
    const documentId = uuidParam(params.documentId);
    if (!id || !documentId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Conversation or document ID is invalid." });
    try {
      return chatConversationSchema.parse(await options.manager.detachDocument(principal, id, documentId));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.post("/conversations/:conversationId/fork", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    const input = forkChatConversationSchema.safeParse(request.body ?? {});
    if (!id || !input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: id ? input.error?.issues[0]?.message : "Conversation ID is invalid." });
    try {
      return reply.code(201).send(chatConversationSummarySchema.parse(await options.manager.fork(principal, id, input.data)));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.delete("/conversations/:conversationId", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Conversation ID is invalid." });
    try {
      await options.manager.delete(principal, id);
      return reply.code(204).send();
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.post("/approvals/:approvalId/decision", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    const id = uuidParam((request.params as Record<string, unknown>).approvalId);
    const input = decideAgentRunApprovalSchema.safeParse(request.body);
    if (!id || !input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: id ? input.error?.issues[0]?.message : "Approval ID is invalid." });
    try {
      return agentRunApprovalSchema.parse(await options.manager.decideApproval(principal, id, input.data));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.post("/conversations/:conversationId/cancel", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Conversation ID is invalid." });
    try {
      return chatConversationSchema.parse(await options.manager.cancelActiveRun(principal, id));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.put("/messages/:messageId/feedback", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const id = uuidParam((request.params as Record<string, unknown>).messageId);
    const input = setChatFeedbackSchema.safeParse(request.body);
    if (!id || !input.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: id ? input.error?.issues[0]?.message : "Message ID is invalid.",
      });
    }
    try {
      return chatFeedbackSchema.parse(await options.manager.setFeedback(principal, id, input.data));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });
}

export async function registerChatMetricsRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions,
): Promise<void> {
  app.get("/metrics", async (request, reply) => {
    const principal = await requireAdmin(
      request,
      reply,
      options.sessionManager,
      "operations:read",
    );
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    return chatMetricsSchema.parse(await options.manager.metrics());
  });
}
