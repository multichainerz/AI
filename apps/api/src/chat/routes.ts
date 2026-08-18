import {
  chatConversationSchema,
  chatConversationListSchema,
  chatConversationSummarySchema,
  chatMessageSubmissionSchema,
  agentRunApprovalSchema,
  chatStreamEventSchema,
  chatFeedbackSchema,
  chatMetricsSchema,
  chatScheduleSchema,
  chatScheduleListSchema,
  createChatConversationSchema,
  createChatScheduleSchema,
  decideAgentRunApprovalSchema,
  forkChatConversationSchema,
  sendChatMessageSchema,
  setChatFeedbackSchema,
  updateChatConversationSchema,
  updateChatScheduleSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentRuntimeDisabledError,
} from "../agents/agent-manager.js";
import {
  authenticateAdministrator,
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
  const administrator = await authenticateAdministrator(request, reply, options.sessionManager);
  // Refused before the scope test, not after: a pending password change must
  // not be reportable as "this session lacks chat:use", and must not fall
  // through to the enterprise branch on the same cookie.
  if (administrator.outcome === "REFUSED") return null;
  if (administrator.outcome === "ADMINISTRATOR" && administrator.principal.scopes.includes("chat:use")) {
    return {
      id: administrator.principal.id,
      subject: administrator.principal.subject,
      identityMode: "ADMINISTRATOR_PREVIEW",
      scopes: administrator.principal.scopes,
    };
  }

  const enterprise = await options.identityManager?.authenticate(
    enterpriseSessionToken(request.headers.cookie),
  );
  if (enterprise) {
    // Same split as the administrator gate: a pending password change must
    // not be reportable as a missing `chat:use` scope.
    if (enterprise.session.passwordChangeRequired === true) {
      await reply.code(403).send({
        error: "PASSWORD_CHANGE_REQUIRED",
        message: "Change the temporary password before using OrcaSynapse.",
      });
      return null;
    }
    return {
      id: enterprise.id,
      subject: enterprise.subject,
      identityMode: "ENTERPRISE",
      scopes: enterprise.scopes,
      divisionId: enterprise.divisionId,
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
  // Sending a message submits an agent run, so the agent errors surface here
  // too. Unmapped they became 500s: the pilot answered "the agent is busy" with
  // an Internal Server Error and a stack trace, which reads as a broken control
  // plane rather than a limit the operator configured.
  if (error instanceof AgentNotFoundError) {
    await reply.code(404).send({ error: "AGENT_NOT_FOUND", message: error.message });
    return;
  }
  if (error instanceof AgentConflictError) {
    await reply.code(409).send({ error: "AGENT_CONFLICT", message: error.message });
    return;
  }
  if (error instanceof AgentRuntimeDisabledError) {
    await reply.code(423).send({ error: "AGENT_RUNTIME_DISABLED", message: error.message });
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
    /*
     * The browser's own reconnect delay, which otherwise defaults to three
     * seconds of a dead transcript. A run resumes from `lastEventCursor`, so
     * reconnecting costs one indexed query and replays nothing the reader has
     * already seen -- the cost of trying sooner is small, and the cost of
     * waiting is the answer appearing to stop mid-sentence.
     */
    reply.raw.write("retry: 1000\n\n");
    reply.raw.write(": OrcaSynapse Hermes event stream\n\n");
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    heartbeat.unref();
    /** Settles on the next drain, or at once if the subscriber is already gone. */
    const drained = () => new Promise<void>((resolve) => {
      if (reply.raw.destroyed || controller.signal.aborted) {
        resolve();
        return;
      }
      const settle = () => {
        reply.raw.off("drain", settle);
        reply.raw.off("close", settle);
        controller.signal.removeEventListener("abort", settle);
        resolve();
      };
      reply.raw.once("drain", settle);
      reply.raw.once("close", settle);
      controller.signal.addEventListener("abort", settle, { once: true });
    });
    const emit = (value: unknown): void | Promise<void> => {
      const event = chatStreamEventSchema.parse(value);
      if (reply.raw.destroyed) return;
      const idLine = event.cursor ? `id: ${event.cursor}\n` : "";
      if (reply.raw.write(`${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) return;
      // A false return means the frame is held in this process, not on the
      // wire. Discarding it is what let a single subscriber who stopped
      // reading — a suspended tab resuming a long run from cursor 0 — pull the
      // whole replay into the heap: 15,590 of 15,800 writes buffered rather
      // than sent, 7.1 MB for one /events request. Producing again only once
      // the response drains gives that limit back to the transport.
      return drained();
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
        // Through `emit`, so this frame is validated like every other one
        // rather than being the single hand-written exception.
        await emit({
          type: "stream_error",
          conversationId: conversation,
          messageId: message,
          cursor: queryCursor ?? headerCursor ?? null,
          error: safeStreamError(error),
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!reply.raw.destroyed) reply.raw.end();
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

  /*
   * Schedules. Owner-scoped like every other conversation route -- the manager
   * makes the same ownership test `submitMessage` makes, because a schedule is
   * a stored intent to call that method later.
   */
  app.get("/conversations/:conversationId/schedules", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Conversation ID is invalid." });
    try {
      return chatScheduleListSchema.parse(await options.manager.listSchedules(principal, id));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.post("/conversations/:conversationId/schedules", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    const id = uuidParam((request.params as Record<string, unknown>).conversationId);
    const input = createChatScheduleSchema.safeParse(request.body);
    if (!id || !input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: id ? input.error?.issues[0]?.message : "Conversation ID is invalid." });
    try {
      return reply.code(201).send(chatScheduleSchema.parse(await options.manager.createSchedule(principal, id, input.data)));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.patch("/schedules/:scheduleId", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    const id = uuidParam((request.params as Record<string, unknown>).scheduleId);
    const input = updateChatScheduleSchema.safeParse(request.body);
    if (!id || !input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: id ? input.error?.issues[0]?.message : "Schedule ID is invalid." });
    try {
      return chatScheduleSchema.parse(await options.manager.updateSchedule(principal, id, input.data));
    } catch (error) {
      await sendChatError(reply, error);
    }
  });

  app.delete("/schedules/:scheduleId", async (request, reply) => {
    const principal = await requireChatPrincipal(request, reply, options);
    if (!principal) return;
    if (!options.manager) return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Chat services are not ready." });
    const id = uuidParam((request.params as Record<string, unknown>).scheduleId);
    if (!id) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Schedule ID is invalid." });
    try {
      await options.manager.deleteSchedule(principal, id);
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
