import {
  chatConversationSchema,
  chatConversationListSchema,
  chatConversationSummarySchema,
  chatStreamEventSchema,
  chatFeedbackSchema,
  chatMetricsSchema,
  createChatConversationSchema,
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

export interface ChatRouteOptions {
  sessionManager?: AdminSessionManager;
  identityManager?: EnterpriseIdentityManager;
  manager?: ChatManager;
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

function conversationId(value: unknown): string | null {
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
    const id = conversationId((request.params as Record<string, unknown>).conversationId);
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
    const id = conversationId((request.params as Record<string, unknown>).conversationId);
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
    const id = conversationId((request.params as Record<string, unknown>).conversationId);
    const input = sendChatMessageSchema.safeParse(request.body);
    if (!id || !input.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: id ? input.error?.issues[0]?.message : "Conversation ID is invalid.",
      });
    }

    // The HTTP stream is a subscriber to durable PostgreSQL/Hermes work. A
    // browser disconnect must not implicitly cancel that work; explicit Stop
    // uses the cancellation route below.
    let streaming = false;
    const emit = (value: unknown) => {
      const event = chatStreamEventSchema.parse(value);
      if (reply.raw.destroyed) return;
      if (!streaming) {
        streaming = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-cache, must-revalidate",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
      }
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await options.manager.streamMessage(
        principal,
        id,
        input.data.content,
        emit,
      );
      if (streaming && !reply.raw.destroyed) reply.raw.end();
    } catch (error) {
      if (streaming) {
        if (!reply.raw.destroyed) reply.raw.end();
      } else {
        await sendChatError(reply, error);
      }
    }
  });

  app.post("/conversations/:conversationId/cancel", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    }
    const id = conversationId((request.params as Record<string, unknown>).conversationId);
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
    const id = conversationId((request.params as Record<string, unknown>).messageId);
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
