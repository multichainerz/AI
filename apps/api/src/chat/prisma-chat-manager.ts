import { randomUUID } from "node:crypto";
import {
  knowledgeSourceSchema,
  type AgentRun,
  type AgentRunEvent,
  type ChatConversation,
  type ChatConversationList,
  type ChatConversationSummary,
  type ChatFeedback,
  type ChatMessage,
  type ChatMetrics,
  type ChatStreamEvent,
  type CreateChatConversation,
  type SetChatFeedback,
  type UpdateChatConversation,
} from "@orcasynapse/contracts";
import { Prisma, type OrcaSynapsePrismaClient } from "@orcasynapse/database";
import type { AgentManager, AgentPrincipal } from "../agents/agent-manager.js";
import { inspectInputText } from "../guardrails/runtime-policy.js";
import {
  ChatConfigurationError,
  ChatConversationConflictError,
  ChatConversationNotFoundError,
  ChatMessageNotFoundError,
  ChatPolicyViolationError,
  ChatRateLimitError,
  type ChatManager,
  type ChatPrincipal,
} from "./chat-manager.js";

const STALE_PENDING_AFTER_MS = 10 * 60 * 1_000;
const RUN_POLL_INTERVAL_MS = 500;

interface StoredRunEvent {
  id: string;
  type: string;
  summary: string | null;
  toolName: string | null;
  childSessionId: string | null;
  occurredAt: Date;
}

interface StoredMessage {
  id: string;
  conversationId: string;
  role: "USER" | "ASSISTANT";
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED";
  content: string;
  modelAlias: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  finishReason: string | null;
  errorCode: string | null;
  agentRunId: string | null;
  sources: unknown;
  createdAt: Date;
  completedAt: Date | null;
  feedback?: {
    rating: "HELPFUL" | "NOT_HELPFUL";
    comment: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  agentRun?: { events: StoredRunEvent[] } | null;
}

interface StoredConversation {
  id: string;
  title: string;
  modelAlias: string;
  profileId: string | null;
  profileName: string | null;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
  _count?: { messages: number };
  messages?: StoredMessage[];
}

interface ChatPolicy {
  requestsPerMinute: number;
  maxInputCharacters: number;
  maxOutputCharacters: number;
  blockControlCharacters: boolean;
  blockCredentialPatterns: boolean;
  guardrailPolicyId: string | null;
  guardrailPolicyVersion: string | null;
}

function messageDto(message: StoredMessage): ChatMessage {
  const sources = knowledgeSourceSchema.array().max(10).safeParse(message.sources);
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    status: message.status,
    content: message.content,
    modelAlias: message.modelAlias,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    totalTokens: message.totalTokens,
    latencyMs: message.latencyMs,
    finishReason: message.finishReason,
    errorCode: message.errorCode,
    agentRunId: message.agentRunId,
    runtimeEvents: (message.agentRun?.events ?? []).map((event) => ({
      id: event.id,
      type: event.type,
      summary: event.summary,
      toolName: event.toolName,
      childSessionId: event.childSessionId,
      occurredAt: event.occurredAt.toISOString(),
    })),
    sources: sources.success ? sources.data : [],
    feedback: message.feedback ? {
      rating: message.feedback.rating,
      comment: message.feedback.comment,
      createdAt: message.feedback.createdAt.toISOString(),
      updatedAt: message.feedback.updatedAt.toISOString(),
    } : null,
    createdAt: message.createdAt.toISOString(),
    completedAt: message.completedAt?.toISOString() ?? null,
  };
}

function summaryDto(conversation: StoredConversation): ChatConversationSummary {
  const lastMessage = conversation.messages?.at(0);
  return {
    id: conversation.id,
    title: conversation.title,
    modelAlias: conversation.modelAlias,
    profileId: conversation.profileId,
    profileName: conversation.profileName,
    status: conversation.status,
    messageCount: conversation._count?.messages ?? conversation.messages?.length ?? 0,
    lastMessagePreview: lastMessage?.content.slice(0, 180) ?? null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
  };
}

function safeTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trimEnd()}…`;
}

function asAgentPrincipal(principal: ChatPrincipal): AgentPrincipal {
  return {
    id: principal.id,
    subject: principal.subject,
    identityMode: principal.identityMode,
    scopes: principal.scopes,
  };
}

function maximumUsage(events: AgentRunEvent[], field: "inputTokens" | "outputTokens"): number | null {
  const values = events.flatMap((event) => event[field] === null ? [] : [event[field]]);
  return values.length === 0 ? null : Math.max(...values);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireChatRateLimitLock(
  transaction: Pick<Prisma.TransactionClient, "$executeRaw">,
  subject: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`orcasynapse-chat:${subject}`}))
  `;
}

export class PrismaChatManager implements ChatManager {
  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly agents: AgentManager,
  ) {}

  async list(principal: ChatPrincipal): Promise<ChatConversationList> {
    const conversations = await this.prisma.chatConversation.findMany({
      where: { ownerSubject: principal.subject },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      take: 100,
      include: {
        _count: { select: { messages: true } },
        messages: { where: { content: { not: "" } }, orderBy: { ordinal: "desc" }, take: 1 },
      },
    });
    return { items: conversations.map((conversation) => summaryDto(conversation as StoredConversation)) };
  }

  async create(principal: ChatPrincipal, input: CreateChatConversation): Promise<ChatConversationSummary> {
    const profile = await this.activeProfile(input.profileId);
    if (input.modelAlias && input.modelAlias !== profile.modelAlias) {
      throw new ChatConfigurationError(`Agent '${profile.displayName}' uses model '${profile.modelAlias}'.`);
    }
    const conversation = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.chatConversation.create({
        data: {
          ownerSubject: principal.subject,
          title: input.title ?? "New conversation",
          modelAlias: profile.modelAlias,
          profileId: profile.id,
          profileName: profile.displayName,
        },
        include: { _count: { select: { messages: true } } },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "chat.hermes_conversation_created",
        resourceType: "ChatConversation", resourceId: created.id, outcome: "SUCCESS",
        metadata: { profileId: profile.id, profileVersion: profile.version, modelAlias: profile.modelAlias, identityMode: principal.identityMode },
      } });
      return created;
    });
    return summaryDto(conversation as StoredConversation);
  }

  async get(principal: ChatPrincipal, conversationId: string): Promise<ChatConversation> {
    const conversation = await this.prisma.chatConversation.findFirst({
      where: { id: conversationId, ownerSubject: principal.subject },
      include: {
        _count: { select: { messages: true } },
        messages: {
          orderBy: { ordinal: "asc" },
          include: {
            feedback: true,
            agentRun: { select: { events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 500 } } },
          },
        },
      },
    });
    if (!conversation) throw new ChatConversationNotFoundError();
    const stored = conversation as StoredConversation;
    return { ...summaryDto(stored), messages: (stored.messages ?? []).map(messageDto) };
  }

  async update(principal: ChatPrincipal, conversationId: string, input: UpdateChatConversation): Promise<ChatConversationSummary> {
    const result = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.chatConversation.updateMany({
        where: { id: conversationId, ownerSubject: principal.subject },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
      });
      if (updated.count !== 1) throw new ChatConversationNotFoundError();
      const conversation = await transaction.chatConversation.findUniqueOrThrow({
        where: { id: conversationId }, include: { _count: { select: { messages: true } } },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "chat.conversation_updated",
        resourceType: "ChatConversation", resourceId: conversationId, outcome: "SUCCESS",
        metadata: { fields: Object.keys(input) },
      } });
      return conversation;
    });
    return summaryDto(result as StoredConversation);
  }

  async streamMessage(
    principal: ChatPrincipal,
    conversationId: string,
    content: string,
    signal: AbortSignal,
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const policy = await this.resolvePolicy();
    const violation = inspectInputText(content, policy);
    if (violation) {
      await this.recordGuardrailBlock(principal, conversationId, content.length, violation, policy);
      throw new ChatPolicyViolationError(violation === "INPUT_CHARACTER_LIMIT"
        ? `The active policy limits chat input to ${policy.maxInputCharacters.toLocaleString("en-US")} characters.`
        : violation === "CONTROL_CHARACTERS"
          ? "The active policy blocks unsafe control characters."
          : "The active policy blocks content that appears to contain a credential.");
    }

    const now = new Date();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const conversation = await this.prisma.$transaction(async (transaction) => {
      await acquireChatRateLimitLock(transaction, principal.subject);
      const recentRequests = await transaction.chatMessage.count({
        where: { role: "USER", createdAt: { gte: new Date(now.getTime() - 60_000) }, conversation: { ownerSubject: principal.subject } },
      });
      if (recentRequests >= policy.requestsPerMinute) throw new ChatRateLimitError();
      const stored = await transaction.chatConversation.findFirst({
        where: { id: conversationId, ownerSubject: principal.subject },
        include: { messages: { where: { status: "PENDING" }, select: { id: true, createdAt: true }, take: 1 } },
      });
      if (!stored) throw new ChatConversationNotFoundError();
      if (stored.status !== "ACTIVE") throw new ChatConversationConflictError("Archived conversations cannot accept new messages.");
      if (!stored.profileId || !stored.profileName) {
        throw new ChatConfigurationError("This legacy conversation has no Agent Profile. Start a new conversation.");
      }
      const pending = stored.messages[0];
      if (pending?.createdAt && pending.createdAt.getTime() > now.getTime() - STALE_PENDING_AFTER_MS) {
        throw new ChatConversationConflictError("This conversation already has a Hermes run in progress.");
      }
      if (pending) await transaction.chatMessage.updateMany({
        where: { id: pending.id, status: "PENDING" },
        data: { status: "FAILED", errorCode: "HERMES_RUN_ABANDONED", completedAt: now },
      });
      const generation = stored.generation + 1;
      const claimed = await transaction.chatConversation.updateMany({
        where: { id: stored.id, ownerSubject: principal.subject, generation: stored.generation },
        data: { generation, lastMessageAt: now, ...(stored.title === "New conversation" ? { title: safeTitle(content) } : {}) },
      });
      if (claimed.count !== 1) throw new ChatConversationConflictError("Another message was submitted at the same time.");
      await transaction.chatMessage.createMany({ data: [
        { id: userMessageId, conversationId, ordinal: generation * 2 - 1, role: "USER", status: "COMPLETED", content, completedAt: now },
        { id: assistantMessageId, conversationId, ordinal: generation * 2, role: "ASSISTANT", status: "PENDING", content: "", modelAlias: stored.modelAlias },
      ] });
      return stored;
    });

    emit({ type: "started", conversationId, messageId: assistantMessageId });
    const startedAt = Date.now();
    let run: AgentRun | null = null;
    try {
      run = await this.agents.submitRun(
        asAgentPrincipal(principal),
        { profileId: conversation.profileId!, input: content },
        { sessionId: conversationId },
      );
      await this.prisma.chatMessage.update({ where: { id: assistantMessageId }, data: { agentRunId: run.id } });
      await this.prisma.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "chat.hermes_run_requested",
        resourceType: "ChatMessage", resourceId: assistantMessageId, outcome: "SUCCESS",
        metadata: { conversationId, runId: run.id, profileId: run.profileId, profileVersion: run.profileVersion, enforcementPlane: "ORCASYNAPSE" },
      } });

      const emittedEvents = new Set<string>();
      while (!signal.aborted) {
        run = await this.agents.getRun(asAgentPrincipal(principal), run.id, false);
        const events = await this.agents.listRunEvents(asAgentPrincipal(principal), run.id, false);
        for (const event of events.items) {
          if (emittedEvents.has(event.id)) continue;
          emittedEvents.add(event.id);
          emit({
            type: "activity", conversationId, messageId: assistantMessageId,
            runId: run.id, activity: event.type, summary: event.summary,
            toolName: event.toolName, childSessionId: event.childSessionId,
          });
        }
        if (run.status === "COMPLETED") {
          if (!run.output?.trim()) throw new Error("Hermes completed without a response.");
          if (run.output.length > policy.maxOutputCharacters) throw new Error("Hermes output exceeded the active guardrail limit.");
          emit({ type: "delta", conversationId, messageId: assistantMessageId, delta: run.output });
          const inputTokens = maximumUsage(events.items, "inputTokens");
          const outputTokens = maximumUsage(events.items, "outputTokens");
          const totalTokens = inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0);
          const completed = await this.prisma.$transaction(async (transaction) => {
            await transaction.chatMessage.update({ where: { id: assistantMessageId }, data: {
              status: "COMPLETED", content: run!.output!, inputTokens, outputTokens, totalTokens,
              latencyMs: Date.now() - startedAt, finishReason: "hermes_completed", sources: run!.sources as Prisma.InputJsonValue,
              completedAt: new Date(),
            } });
            await transaction.auditEvent.create({ data: {
              actorType: "USER", actorId: principal.id, action: "chat.hermes_run_completed",
              resourceType: "ChatMessage", resourceId: assistantMessageId, outcome: "SUCCESS",
              metadata: { conversationId, runId: run!.id, profileId: run!.profileId, profileVersion: run!.profileVersion, latencyMs: Date.now() - startedAt, inputTokens, outputTokens, knowledgeSourceCount: run!.sources.length, guardrailPolicyId: policy.guardrailPolicyId },
            } });
            return transaction.chatMessage.findUniqueOrThrow({
              where: { id: assistantMessageId },
              include: { feedback: true, agentRun: { select: { events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 500 } } } },
            });
          });
          emit({ type: "completed", conversationId, messageId: assistantMessageId, message: messageDto(completed as StoredMessage) });
          return;
        }
        if (["FAILED", "DENIED", "TIMED_OUT", "CANCELLED"].includes(run.status)) {
          throw new Error(run.failureMessage ?? `Hermes run ended as ${run.status.toLowerCase()}.`);
        }
        await sleep(RUN_POLL_INTERVAL_MS);
      }
      if (run) await this.agents.cancelRun(asAgentPrincipal(principal), run.id, false).catch(() => undefined);
      throw new DOMException("Generation cancelled", "AbortError");
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      const errorCode = cancelled ? "HERMES_RUN_CANCELLED" : run?.failureCode ?? "HERMES_RUN_FAILED";
      const safeError = cancelled ? "The Hermes run was cancelled." : error instanceof Error ? error.message.slice(0, 500) : "Hermes could not complete the response.";
      await this.prisma.$transaction([
        this.prisma.chatMessage.updateMany({
          where: { id: assistantMessageId, status: "PENDING" },
          data: { status: cancelled ? "CANCELLED" : "FAILED", latencyMs: Date.now() - startedAt, errorCode, completedAt: new Date() },
        }),
        this.prisma.auditEvent.create({ data: {
          actorType: "USER", actorId: principal.id, action: cancelled ? "chat.hermes_run_cancelled" : "chat.hermes_run_failed",
          resourceType: "ChatMessage", resourceId: assistantMessageId, outcome: "FAILURE",
          metadata: { conversationId, runId: run?.id ?? null, errorCode, guardrailPolicyId: policy.guardrailPolicyId },
        } }),
      ]);
      emit(cancelled
        ? { type: "cancelled", conversationId, messageId: assistantMessageId }
        : { type: "failed", conversationId, messageId: assistantMessageId, error: safeError, errorCode });
    }
  }

  async setFeedback(principal: ChatPrincipal, messageId: string, input: SetChatFeedback): Promise<ChatFeedback> {
    const feedback = await this.prisma.$transaction(async (transaction) => {
      const message = await transaction.chatMessage.findFirst({
        where: { id: messageId, role: "ASSISTANT", status: "COMPLETED", conversation: { ownerSubject: principal.subject } },
        select: { id: true, conversationId: true },
      });
      if (!message) throw new ChatMessageNotFoundError();
      const saved = await transaction.chatFeedback.upsert({
        where: { messageId },
        create: { messageId, ownerSubject: principal.subject, rating: input.rating, comment: input.comment ?? null },
        update: { rating: input.rating, comment: input.comment ?? null },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "chat.feedback_recorded", resourceType: "ChatMessage",
        resourceId: messageId, outcome: "SUCCESS", metadata: { conversationId: message.conversationId, rating: saved.rating, identityMode: principal.identityMode },
      } });
      return saved;
    });
    return { rating: feedback.rating, comment: feedback.comment, createdAt: feedback.createdAt.toISOString(), updatedAt: feedback.updatedAt.toISOString() };
  }

  async metrics(): Promise<ChatMetrics> {
    const generatedAt = new Date();
    const windowStartedAt = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1_000);
    const [conversations, messages, helpful, notHelpful] = await Promise.all([
      this.prisma.chatConversation.count({ where: { createdAt: { gte: windowStartedAt } } }),
      this.prisma.chatMessage.findMany({
        where: { role: "ASSISTANT", status: { in: ["COMPLETED", "FAILED", "CANCELLED"] }, createdAt: { gte: windowStartedAt } },
        select: { status: true, totalTokens: true, latencyMs: true },
      }),
      this.prisma.chatFeedback.count({ where: { rating: "HELPFUL", createdAt: { gte: windowStartedAt } } }),
      this.prisma.chatFeedback.count({ where: { rating: "NOT_HELPFUL", createdAt: { gte: windowStartedAt } } }),
    ]);
    const completed = messages.filter(({ status }) => status === "COMPLETED").length;
    const failed = messages.filter(({ status }) => status === "FAILED").length;
    const cancelled = messages.filter(({ status }) => status === "CANCELLED").length;
    const latencies = messages.flatMap(({ latencyMs }) => latencyMs === null ? [] : [latencyMs]);
    return {
      windowStartedAt: windowStartedAt.toISOString(), generatedAt: generatedAt.toISOString(), conversations,
      responses: messages.length, completed, failed, cancelled,
      totalTokens: messages.reduce((sum, message) => sum + (message.totalTokens ?? 0), 0),
      averageLatencyMs: latencies.length === 0 ? null : Math.round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length),
      failureRate: messages.length === 0 ? 0 : failed / messages.length,
      feedback: { helpful, notHelpful },
    };
  }

  private async activeProfile(profileId?: string): Promise<{ id: string; displayName: string; modelAlias: string; version: number }> {
    const profile = await this.prisma.agentProfile.findFirst({
      where: { ...(profileId ? { id: profileId } : {}), status: "ACTIVE", activeVersion: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, activeVersion: true },
    });
    if (!profile?.activeVersion) throw new ChatConfigurationError(profileId
      ? "The selected Agent Profile is not active."
      : "Activate one Agent Profile before starting Chat.");
    const version = await this.prisma.agentProfileVersion.findUnique({
      where: { profileId_version: { profileId: profile.id, version: profile.activeVersion } },
      select: { displayName: true, modelAlias: true, version: true },
    });
    if (!version) throw new ChatConfigurationError("The active Agent Profile distribution is unavailable.");
    return { id: profile.id, displayName: version.displayName, modelAlias: version.modelAlias, version: version.version };
  }

  private async resolvePolicy(): Promise<ChatPolicy> {
    const catalogueEnforced = await this.prisma.guardrailPolicy.count({ where: { firstActivatedAt: { not: null } } }) > 0;
    const policies = !catalogueEnforced ? [] : await this.prisma.guardrailPolicy.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, version: true, maxInputCharacters: true, maxOutputCharacters: true, blockControlCharacters: true, blockCredentialPatterns: true },
      take: 2,
    });
    if (catalogueEnforced && policies.length === 0) throw new ChatConfigurationError("Activate one evaluated guardrail policy before using Chat.");
    if (policies.length > 1) throw new ChatConfigurationError("More than one chat guardrail policy is active.");
    const policy = policies[0];
    return {
      requestsPerMinute: 12,
      maxInputCharacters: policy?.maxInputCharacters ?? 32_000,
      maxOutputCharacters: policy?.maxOutputCharacters ?? 200_000,
      blockControlCharacters: policy?.blockControlCharacters ?? true,
      blockCredentialPatterns: policy?.blockCredentialPatterns ?? true,
      guardrailPolicyId: policy?.id ?? null,
      guardrailPolicyVersion: policy?.version ?? null,
    };
  }

  private async recordGuardrailBlock(
    principal: ChatPrincipal,
    conversationId: string,
    observedCharacters: number,
    violation: string,
    policy: ChatPolicy,
  ): Promise<void> {
    const conversation = await this.prisma.chatConversation.findFirst({
      where: { id: conversationId, ownerSubject: principal.subject }, select: { id: true },
    });
    if (!conversation) throw new ChatConversationNotFoundError();
    await this.prisma.auditEvent.create({ data: {
      actorType: "USER", actorId: principal.id, action: "guardrail.request_blocked",
      resourceType: "ChatConversation", resourceId: conversationId, outcome: "FAILURE",
      metadata: { policyId: policy.guardrailPolicyId, policyVersion: policy.guardrailPolicyVersion, reason: violation, observedCharacters, maxInputCharacters: policy.maxInputCharacters },
    } });
  }
}
