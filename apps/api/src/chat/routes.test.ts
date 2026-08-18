import { once } from "node:events";
import { connect, type AddressInfo, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ADMIN_SCOPES, type ChatMessage, type ChatSchedule } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminPrincipal, type AdminSessionManager } from "../auth/admin-session.js";
import {
  ENTERPRISE_SESSION_COOKIE,
  type EnterpriseIdentityManager,
} from "../identity/enterprise-session.js";
import {
  AgentConflictError,
  AgentRuntimeDisabledError,
} from "../agents/agent-manager.js";
import { ChatConfigurationError, type ChatManager } from "./chat-manager.js";

const SESSION_TOKEN = "s".repeat(43);
const SESSION_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const CONVERSATION_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const MESSAGE_ID = "78e3b103-3c63-41d8-a6c9-13b02369ee07";
const SCHEDULE_ID = "c4f6f1f6-2a2f-4a71-9a1e-3b6d5c8e4a11";
const ENTERPRISE_TOKEN = "u".repeat(43);
const principal: AdminPrincipal = {
  id: SESSION_ID,
  subject: "installation-key-administrator",
  role: "PLATFORM_ADMIN",
  scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z",
  idleExpiresAt: "2026-07-30T00:15:00.000Z",
  absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};
const summary = {
  id: CONVERSATION_ID,
  title: "Pilot chat",
  modelAlias: "laguna-primary",
  profileId: "f2f68d20-f921-44ba-981c-56b043e1b9ac",
  profileName: "Hermes Analyst",
  status: "ACTIVE" as const,
  messageCount: 0,
  lastMessagePreview: null,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  lastMessageAt: null,
};
const completedMessage: ChatMessage = {
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  role: "ASSISTANT",
  status: "COMPLETED",
  content: "Hello",
  modelAlias: "laguna-primary",
  inputTokens: 4,
  outputTokens: 2,
  reasoningTokens: 0,
  totalTokens: 6,
  latencyMs: 150,
  firstTokenLatencyMs: 40,
  finishReason: "stop",
  errorCode: null,
  agentRunId: "dd729774-47cb-4bd1-83d2-2ff75c6f3ec1",
  runStatus: "COMPLETED",
  lastEventCursor: "2",
  runtimeEvents: [],
  approvals: [],
  feedback: null,
  createdAt: "2026-07-30T00:00:01.000Z",
  completedAt: "2026-07-30T00:00:01.150Z",
};

class SessionManager implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === SESSION_TOKEN ? principal : null; }
  async revoke() { return true; }
}

const enterpriseIdentity: EnterpriseIdentityManager = {
  async signInWithPassword() { throw new Error("Not used"); },
  async changeLocalPassword() { throw new Error("Not used"); },
  async authenticate(token) {
    return token === ENTERPRISE_TOKEN ? {
      id: SESSION_ID,
      subject: "user:fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
      identityMode: "ENTERPRISE",
      displayName: "Pilot User",
      email: "pilot@orcasynapse.example",
      scopes: ["chat:use", "agents:use"], divisionId: null,
      session: {
        id: SESSION_ID,
        identityMode: "ENTERPRISE",
        user: {
          id: "fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
          displayName: "Pilot User",
          email: "pilot@orcasynapse.example",
        },
        scopes: ["chat:use", "agents:use"], divisionId: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        idleExpiresAt: "2026-07-30T08:00:00.000Z",
        absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
      },
    } : null;
  },
  async revoke() { return true; },
};

function memoryChatManager(): ChatManager {
  const userMessage: ChatMessage = {
    ...completedMessage,
    id: "c1446fb5-19f2-4071-8d5e-957a9629b1ad",
    role: "USER",
    content: "Hello",
    modelAlias: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: null,
    finishReason: null,
    agentRunId: null,
    runStatus: null,
    lastEventCursor: null,
    completedAt: "2026-07-30T00:00:01.000Z",
  };
  const pendingMessage: ChatMessage = {
    ...completedMessage,
    status: "PENDING",
    content: "",
    runStatus: "QUEUED",
    lastEventCursor: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: null,
    finishReason: null,
    completedAt: null,
  };
  const schedule: ChatSchedule = {
    id: SCHEDULE_ID,
    conversationId: CONVERSATION_ID,
    prompt: "Summarise overnight incidents.",
    intervalSeconds: 86_400,
    nextRunAt: "2026-07-31T06:00:00.000Z",
    lastRunAt: null,
    lastOutcome: null,
    lastDetail: null,
    enabled: true,
    createdBySubject: "local-admin:operator",
    revision: 0,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
  return {
    list: vi.fn(async () => ({ items: [summary] })),
    create: vi.fn(async () => summary),
    get: vi.fn(async () => ({ ...summary, messages: [] })),
    update: vi.fn(async () => summary),
    cancelActiveRun: vi.fn(async () => ({ ...summary, messages: [] })),
    submitMessage: vi.fn(async () => ({
      conversationId: CONVERSATION_ID,
      userMessage,
      assistantMessage: pendingMessage,
    })),
    subscribe: vi.fn(async (_principal, conversationId, messageId, _cursor, emit) => {
      emit({ type: "started", conversationId, messageId, runId: completedMessage.agentRunId!, cursor: null });
      emit({ type: "delta", conversationId, messageId, cursor: "1", delta: "Hello" });
      emit({ type: "completed", conversationId, messageId, cursor: "2", message: completedMessage });
    }),
    decideApproval: vi.fn(async () => ({
      id: "1d85febd-3e0e-4fc7-b9b7-1f8ceda13ebc", runId: completedMessage.agentRunId!, status: "APPROVED" as const,
      command: null, summary: "Continue", choices: ["ALLOW_ONCE" as const, "DENY" as const], requestedAt: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-07-30T00:10:00.000Z", decidedAt: "2026-07-30T00:01:00.000Z", decision: "ALLOW_ONCE" as const,
    })),
    fork: vi.fn(async () => ({ ...summary, id: "190039a6-f9dc-49ef-ab09-b94fc483e3c7", title: "Pilot chat (fork)" })),
    delete: vi.fn(async () => undefined),
    listSchedules: vi.fn(async () => ({ items: [schedule] })),
    createSchedule: vi.fn(async () => schedule),
    updateSchedule: vi.fn(async (_principal, _scheduleId, input) => ({
      ...schedule,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    })),
    deleteSchedule: vi.fn(async () => undefined),
    setFeedback: vi.fn(async (_principal, _messageId, input) => ({
      rating: input.rating,
      comment: input.comment ?? null,
      createdAt: "2026-07-30T00:00:02.000Z",
      updatedAt: "2026-07-30T00:00:02.000Z",
    })),
    metrics: vi.fn(async () => ({
      windowStartedAt: "2026-07-29T00:00:00.000Z",
      generatedAt: "2026-07-30T00:00:00.000Z",
      conversations: 1,
      responses: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      totalTokens: 6,
      averageLatencyMs: 150,
      failureRate: 0,
      feedback: { helpful: 0, notHelpful: 0 },
    })),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function chatApp(
  manager: ChatManager = memoryChatManager(),
  identityManager?: EnterpriseIdentityManager,
) {
  const app = await createApp({
    logger: false,
    runtime: {
      bootstrapState: "READY",
      sessionManager: new SessionManager(),
      chatManager: manager,
      ...(identityManager ? { identityManager } : {}),
    },
  });
  apps.push(app);
  return app;
}

describe("controlled chat routes", () => {
  it("requires a scoped administrator preview session", async () => {
    const app = await chatApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/chat/conversations" });
    expect(response.statusCode).toBe(401);
  });

  it("lists conversations without exposing credentials", async () => {
    const app = await chatApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/conversations",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [summary] });
    expect(response.body).not.toContain("write-only-key");
  });

  it("refuses an enterprise session that still owes a password change", async () => {
    const pendingIdentity: EnterpriseIdentityManager = {
      ...enterpriseIdentity,
      async authenticate(token) {
        const principal = await enterpriseIdentity.authenticate(token);
        if (!principal) return null;
        return {
          ...principal,
          session: { ...principal.session, passwordChangeRequired: true },
        };
      },
    };
    const manager = memoryChatManager();
    const app = await chatApp(manager, pendingIdentity);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/conversations",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${ENTERPRISE_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it("authorizes a group-approved enterprise identity without an admin session", async () => {
    const manager = memoryChatManager();
    const app = await chatApp(manager, enterpriseIdentity);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/conversations",
      headers: { cookie: `${ENTERPRISE_SESSION_COOKIE}=${ENTERPRISE_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(manager.list).toHaveBeenCalledWith(expect.objectContaining({
      identityMode: "ENTERPRISE",
      subject: "user:fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
    }));
  });

  it("submits durable work and streams typed model events over resumable SSE", async () => {
    const app = await chatApp();
    const submission = await app.inject({
      method: "POST",
      url: `/api/v1/chat/conversations/${CONVERSATION_ID}/messages`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { content: "Hello" },
    });
    expect(submission.statusCode).toBe(202);
    expect(submission.json()).toMatchObject({ assistantMessage: { id: MESSAGE_ID, status: "PENDING" } });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/chat/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/events`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: started");
    expect(response.body).toContain("event: delta");
    expect(response.body).toContain("event: completed");
  });

  it("answers a busy agent with a conflict, not an internal error", async () => {
    // Sending a message submits an agent run, so submitRun's errors reach the
    // chat route. Unmapped, the pilot answered "this agent has reached its
    // configured concurrent-run limit" with a 500 and a stack trace, which
    // reads as a broken control plane rather than a limit someone configured.
    const manager = memoryChatManager();
    manager.submitMessage = vi.fn(async () => {
      throw new AgentConflictError("This agent has reached its configured concurrent-run limit.");
    });
    const app = await chatApp(manager);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/chat/conversations/${CONVERSATION_ID}/messages`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { content: "Hello" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "AGENT_CONFLICT" });
    expect(response.json().message).toContain("concurrent-run limit");
  });

  it("answers a disabled runtime with locked, not an internal error", async () => {
    const manager = memoryChatManager();
    manager.submitMessage = vi.fn(async () => {
      throw new AgentRuntimeDisabledError("An administrator paused this runtime.");
    });
    const app = await chatApp(manager);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/chat/conversations/${CONVERSATION_ID}/messages`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { content: "Hello" },
    });

    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ error: "AGENT_RUNTIME_DISABLED" });
  });

  it("cancels the active durable Hermes run explicitly", async () => {
    const manager = memoryChatManager();
    const app = await chatApp(manager);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/chat/conversations/${CONVERSATION_ID}/cancel`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...summary, messages: [] });
    expect(manager.cancelActiveRun).toHaveBeenCalledWith(
      expect.objectContaining({ identityMode: "ADMINISTRATOR_PREVIEW" }),
      CONVERSATION_ID,
    );
  });

  it("records ownership-scoped response feedback", async () => {
    const manager = memoryChatManager();
    const app = await chatApp(manager);
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/chat/messages/${MESSAGE_ID}/feedback`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: { rating: "HELPFUL" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rating: "HELPFUL", comment: null });
    expect(manager.setFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ identityMode: "ADMINISTRATOR_PREVIEW" }),
      MESSAGE_ID,
      { rating: "HELPFUL" },
    );
  });

  it("exposes aggregate chat telemetry only through an admin-scoped route", async () => {
    const app = await chatApp();
    const denied = await app.inject({ method: "GET", url: "/api/v1/admin/chat/metrics" });
    expect(denied.statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/chat/metrics",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ responses: 1, totalTokens: 6, failureRate: 0 });
  });

  it("returns an actionable configuration gate before streaming begins", async () => {
    const manager = memoryChatManager();
    manager.create = vi.fn(async () => {
      throw new ChatConfigurationError("Test vLLM first.");
    });
    const app = await chatApp(manager);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/conversations",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}` },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "CHAT_NOT_CONFIGURED", message: "Test vLLM first." });
  });
});
describe("SSE write backpressure", () => {
  const FRAMES = 200;
  const FRAME_CONTENT = "x".repeat(128 * 1_024);

  it("stops producing for a subscriber that has stopped reading", async () => {
    // Resuming a long run replays saved events as fast as the database returns
    // them. `reply.raw.write` was called for each one and its return value
    // discarded, so an authenticated pilot whose tab stopped reading — a
    // suspended laptop, a proxy that stalled — had the whole replay accumulate
    // in this process's heap: measured at 7.1 MB for one subscriber before the
    // producer was paced by drain.
    let emitted = 0;
    const manager = memoryChatManager();
    manager.subscribe = vi.fn(async (_principal, conversationId, messageId, _cursor, emit) => {
      for (let index = 0; index < FRAMES; index += 1) {
        await emit({ type: "delta", conversationId, messageId, cursor: String(index + 1), delta: FRAME_CONTENT });
        emitted += 1;
      }
    });
    const app = await chatApp(manager);
    let handedToTransport = 0;
    // A transport that takes the bytes, answers false, and never drains. It is
    // simulated at this seam rather than provoked with a slow client because
    // how much a kernel absorbs for a reader that never reads is
    // platform-dependent: Windows loopback swallowed 26 MB of this same
    // response, which would hide on this machine a defect that is fatal on the
    // pilot. What is measured — bytes handed over while the consumer is
    // stalled — is the same quantity either way.
    app.server.on("connection", (socket) => {
      const stalled = ((chunk: unknown) => {
        handedToTransport += typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : Buffer.isBuffer(chunk) ? chunk.byteLength : 0;
        return false;
      }) as Socket["write"];
      socket.write = stalled;
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const client = connect({
      port: (app.server.address() as AddressInfo).port,
      host: "127.0.0.1",
    });
    await once(client, "connect");
    // Never read: this is a stalled consumer, not a slow one.
    client.pause();
    client.write(
      `GET /api/v1/chat/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/events HTTP/1.1\r\n` +
      `Host: 127.0.0.1\r\nCookie: ${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}\r\n\r\n`,
    );
    await delay(500);
    // Sampled before the socket is torn down: closing releases the producer,
    // which then runs to completion against a dead response.
    const producedWhileStalled = emitted;
    const bufferedWhileStalled = handedToTransport;
    client.destroy();
    await delay(50);

    expect(producedWhileStalled).toBeLessThan(FRAMES);
    expect(bufferedWhileStalled).toBeLessThan(2 * 1_024 * 1_024);
  });
});
