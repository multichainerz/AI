import { randomUUID } from "node:crypto";
import {
  knowledgeSourceSchema,
  type AgentRunApproval,
  type ChatConversation,
  type ChatConversationList,
  type ChatConversationSummary,
  type ChatFeedback,
  type ChatMessage,
  type ChatMetrics,
  type ChatMessageSubmission,
  type ChatStreamEvent,
  type CreateChatConversation,
  type SetChatFeedback,
  type DecideAgentRunApproval,
  type ForkChatConversation,
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

const STALE_PENDING_AFTER_MS = 65 * 60 * 1_000;
const RUN_POLL_INTERVAL_MS = 350;

interface StoredRunEvent {
  id: string;
  cursor: bigint;
  type: string;
  delta: string | null;
  preview: string | null;
  status: string | null;
  errorCode: string | null;
  approvalId: string | null;
  summary: string | null;
  toolName: string | null;
  childSessionId: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: Prisma.Decimal | number | null;
  occurredAt: Date;
}

interface StoredApproval {
  id: string;
  runId: string;
  status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CANCELLED";
  command: string | null;
  summary: string | null;
  choices: unknown;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decision: string | null;
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
  reasoningTokens: number | null;
  latencyMs: number | null;
  firstTokenLatencyMs: number | null;
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
  agentRun?: {
    status: "QUEUED" | "RUNNING" | "WAITING_FOR_APPROVAL" | "CANCEL_REQUESTED" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "DENIED";
    lastEventCursor: bigint | null;
    events: StoredRunEvent[];
    approvals: StoredApproval[];
  } | null;
}

interface StoredConversation {
  id: string;
  title: string;
  modelAlias: string;
  profileId: string | null;
  profileName: string | null;
  status: "ACTIVE" | "ARCHIVED";
  hermesMemoryKey?: string;
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

const messageInclude = {
  feedback: true,
  agentRun: {
    select: {
      status: true,
      lastEventCursor: true,
      events: {
        where: { type: { not: "MESSAGE_DELTA" } },
        orderBy: { cursor: "asc" as const },
        take: 500,
      },
      approvals: {
        orderBy: { requestedAt: "asc" as const },
        take: 20,
      },
    },
  },
} as const;

function approvalDto(approval: StoredApproval): AgentRunApproval {
  const choices = Array.isArray(approval.choices)
    ? approval.choices.filter((choice): choice is "ALLOW_ONCE" | "DENY" => choice === "ALLOW_ONCE" || choice === "DENY")
    : [];
  return {
    id: approval.id,
    runId: approval.runId,
    status: approval.status,
    command: approval.command,
    summary: approval.summary,
    choices: choices.length > 0 ? choices : ["ALLOW_ONCE", "DENY"],
    requestedAt: approval.requestedAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decision: approval.decision === "ALLOW_ONCE" || approval.decision === "DENY" ? approval.decision : null,
  };
}

function messageDto(message: StoredMessage): ChatMessage {
  const sources = knowledgeSourceSchema.array().max(10).safeParse(message.sources);
  const allEvents = message.agentRun?.events ?? [];
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
    reasoningTokens: message.reasoningTokens,
    latencyMs: message.latencyMs,
    firstTokenLatencyMs: message.firstTokenLatencyMs,
    finishReason: message.finishReason,
    errorCode: message.errorCode,
    agentRunId: message.agentRunId,
    runStatus: message.agentRun?.status ?? null,
    lastEventCursor: message.agentRun?.lastEventCursor?.toString() ?? null,
    runtimeEvents: allEvents.filter(({ type }) => type !== "MESSAGE_DELTA").map((event) => ({
      id: event.id,
      cursor: event.cursor.toString(),
      type: event.type,
      summary: event.summary,
      preview: event.preview,
      status: event.status,
      errorCode: event.errorCode,
      toolName: event.toolName,
      childSessionId: event.childSessionId,
      approvalId: event.approvalId,
      durationMs: event.durationMs,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      reasoningTokens: event.reasoningTokens,
      costUsd: event.costUsd === null ? null : Number(event.costUsd),
      occurredAt: event.occurredAt.toISOString(),
    })),
    approvals: (message.agentRun?.approvals ?? []).map(approvalDto),
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

export function boundedConversationHistory(
  messages: Array<{ role: "USER" | "ASSISTANT"; status: string; content: string; ordinal: number }>,
): Array<{ role: "user" | "assistant"; content: string }> {
  let characters = 0;
  const ordered = [...messages].sort((left, right) => left.ordinal - right.ordinal);
  const pairs: Array<Array<{ role: "user" | "assistant"; content: string }>> = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const user = ordered[index];
    const assistant = ordered[index + 1];
    if (
      user?.role === "USER" && user.status === "COMPLETED" && user.content.trim() &&
      assistant?.role === "ASSISTANT" && assistant.status === "COMPLETED" && assistant.content.trim()
    ) {
      pairs.push([{ role: "user", content: user.content }, { role: "assistant", content: assistant.content }]);
      index += 1;
    }
  }
  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const pair of pairs.reverse()) {
    const pairCharacters = pair.reduce((total, message) => total + message.content.length, 0);
    if (selected.length + pair.length > 40 || characters + pairCharacters > 64_000) break;
    selected.unshift(...pair);
    characters += pairCharacters;
  }
  return selected;
}

function asAgentPrincipal(principal: ChatPrincipal): AgentPrincipal {
  return {
    id: principal.id,
    subject: principal.subject,
    identityMode: principal.identityMode,
    scopes: principal.scopes,
  };
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
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
          include: messageInclude,
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

  async cancelActiveRun(principal: ChatPrincipal, conversationId: string): Promise<ChatConversation> {
    const pending = await this.prisma.chatMessage.findFirst({
      where: {
        conversationId,
        role: "ASSISTANT",
        status: "PENDING",
        conversation: { ownerSubject: principal.subject },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, agentRunId: true },
    });
    if (!pending) throw new ChatConversationConflictError("No Hermes run is currently active for this conversation.");

    if (pending.agentRunId) {
      await this.agents.cancelRun(asAgentPrincipal(principal), pending.agentRunId, false);
    } else {
      await this.prisma.chatMessage.updateMany({
        where: { id: pending.id, status: "PENDING", agentRunId: null },
        data: {
          status: "CANCELLED",
          errorCode: "CANCELLED_BEFORE_HERMES_SUBMISSION",
          completedAt: new Date(),
        },
      });
    }
    await this.prisma.auditEvent.create({ data: {
      actorType: "USER", actorId: principal.id, action: "chat.hermes_run_cancel_requested",
      resourceType: "ChatMessage", resourceId: pending.id, outcome: "SUCCESS",
      metadata: { conversationId, runId: pending.agentRunId },
    } });
    return this.get(principal, conversationId);
  }

  async submitMessage(
    principal: ChatPrincipal,
    conversationId: string,
    content: string,
  ): Promise<ChatMessageSubmission> {
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
        include: {
          messages: {
            orderBy: { ordinal: "desc" },
            take: 42,
            select: {
              id: true,
              ordinal: true,
              role: true,
              status: true,
              content: true,
              createdAt: true,
              agentRunId: true,
            },
          },
        },
      });
      if (!stored) throw new ChatConversationNotFoundError();
      if (stored.status !== "ACTIVE") throw new ChatConversationConflictError("Archived conversations cannot accept new messages.");
      if (!stored.profileId || !stored.profileName) {
        throw new ChatConfigurationError("This legacy conversation has no Agent Profile. Start a new conversation.");
      }
      const pending = stored.messages.find(({ role, status }) => role === "ASSISTANT" && status === "PENDING");
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
      return {
        profileId: stored.profileId,
        modelAlias: stored.modelAlias,
        hermesMemoryKey: stored.hermesMemoryKey,
        history: boundedConversationHistory(stored.messages),
      };
    });

    let run;
    try {
      run = await this.agents.submitRun(
        asAgentPrincipal(principal),
        { profileId: conversation.profileId!, input: content },
        {
          sessionId: conversationId,
          memorySessionKey: conversation.hermesMemoryKey,
          conversationHistory: conversation.history,
          outputCharacterLimit: policy.maxOutputCharacters,
        },
      );
      const linked = await this.prisma.chatMessage.updateMany({
        where: { id: assistantMessageId, status: "PENDING" },
        data: { agentRunId: run.id },
      });
      if (linked.count !== 1) {
        await this.agents.cancelRun(asAgentPrincipal(principal), run.id, false).catch(() => undefined);
        throw new ChatConversationConflictError("The pending response was cancelled before Hermes submission completed.");
      }
      await this.prisma.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "chat.hermes_run_requested",
        resourceType: "ChatMessage", resourceId: assistantMessageId, outcome: "SUCCESS",
        metadata: { conversationId, runId: run.id, profileId: run.profileId, profileVersion: run.profileVersion, enforcementPlane: "ORCASYNAPSE" },
      } });
    } catch (error) {
      const errorCode = "HERMES_SUBMISSION_FAILED";
      await this.prisma.$transaction([
        this.prisma.chatMessage.updateMany({
          where: { id: assistantMessageId, status: "PENDING" },
          data: { status: "FAILED", errorCode, completedAt: new Date() },
        }),
        this.prisma.auditEvent.create({ data: {
          actorType: "USER", actorId: principal.id, action: "chat.hermes_run_failed",
          resourceType: "ChatMessage", resourceId: assistantMessageId, outcome: "FAILURE",
          metadata: { conversationId, runId: run?.id ?? null, errorCode, guardrailPolicyId: policy.guardrailPolicyId },
        } }),
      ]);
      throw error;
    }

    const [userMessage, assistantMessage] = await Promise.all([
      this.prisma.chatMessage.findUniqueOrThrow({ where: { id: userMessageId }, include: messageInclude }),
      this.prisma.chatMessage.findUniqueOrThrow({ where: { id: assistantMessageId }, include: messageInclude }),
    ]);
    return {
      conversationId,
      userMessage: messageDto(userMessage as StoredMessage),
      assistantMessage: messageDto(assistantMessage as StoredMessage),
    };
  }

  async subscribe(
    principal: ChatPrincipal,
    conversationId: string,
    messageId: string,
    afterCursor: string | null,
    emit: (event: ChatStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const linked = await this.prisma.chatMessage.findFirst({
      where: {
        id: messageId,
        conversationId,
        role: "ASSISTANT",
        conversation: { ownerSubject: principal.subject },
      },
      select: { agentRunId: true },
    });
    if (!linked) throw new ChatMessageNotFoundError();
    if (!linked.agentRunId) throw new ChatConversationConflictError("The Hermes run has not been linked yet.");
    const runId = linked.agentRunId;
    let cursor = afterCursor && /^\d+$/.test(afterCursor) ? BigInt(afterCursor) : 0n;
    let previousStatus: string | null = null;
    emit({ type: "started", conversationId, messageId, runId, cursor: cursor === 0n ? null : cursor.toString() });

    while (!signal.aborted) {
      const events = await this.prisma.agentRunEvent.findMany({
        where: { runId, cursor: { gt: cursor } },
        orderBy: { cursor: "asc" },
        take: 100,
      });
      const approvalIds = events.flatMap(({ approvalId }) => approvalId ? [approvalId] : []);
      const approvals = approvalIds.length === 0 ? [] : await this.prisma.agentRunApproval.findMany({
        where: { id: { in: approvalIds }, runId },
      });
      const approvalById = new Map(approvals.map((approval) => [approval.id, approval]));
      for (const event of events) {
        cursor = event.cursor;
        const eventCursor = cursor.toString();
        if (event.type === "MESSAGE_DELTA" && event.delta) {
          emit({ type: "delta", conversationId, messageId, cursor: eventCursor, delta: event.delta });
          continue;
        }
        emit({
          type: "activity",
          conversationId,
          messageId,
          cursor: eventCursor,
          runId,
          eventId: event.id,
          activity: event.type,
          summary: event.summary,
          preview: event.preview,
          status: event.status,
          errorCode: event.errorCode,
          toolName: event.toolName,
          childSessionId: event.childSessionId,
          approvalId: event.approvalId,
          durationMs: event.durationMs,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          reasoningTokens: event.reasoningTokens,
          costUsd: event.costUsd === null ? null : Number(event.costUsd),
          occurredAt: event.occurredAt.toISOString(),
        });
        const approval = event.approvalId ? approvalById.get(event.approvalId) : null;
        if (approval) {
          emit({
            type: "approval",
            conversationId,
            messageId,
            cursor: eventCursor,
            runId,
            approval: approvalDto(approval as StoredApproval),
          });
        }
      }
      if (events.length === 100) continue;

      const run = await this.prisma.agentRun.findUnique({
        where: { id: runId },
        select: { status: true, failureCode: true, failureMessage: true, lastEventCursor: true },
      });
      if (!run) throw new ChatConversationConflictError("The Hermes run is no longer available.");
      if (run.status !== previousStatus) {
        previousStatus = run.status;
        emit({
          type: "state",
          conversationId,
          messageId,
          cursor: run.lastEventCursor?.toString() ?? (cursor === 0n ? null : cursor.toString()),
          runId,
          status: run.status,
        });
      }
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "DENIED"].includes(run.status)) {
        const message = await this.prisma.chatMessage.findUniqueOrThrow({
          where: { id: messageId },
          include: messageInclude,
        });
        const dto = messageDto(message as StoredMessage);
        const terminalCursor = run.lastEventCursor?.toString() ?? (cursor === 0n ? null : cursor.toString());
        if (run.status === "COMPLETED") {
          emit({ type: "completed", conversationId, messageId, cursor: terminalCursor, message: dto });
        } else if (run.status === "CANCELLED") {
          emit({ type: "cancelled", conversationId, messageId, cursor: terminalCursor });
        } else {
          emit({
            type: "failed",
            conversationId,
            messageId,
            cursor: terminalCursor,
            error: run.failureMessage ?? `Hermes ended the run as ${run.status.toLowerCase()}.`,
            errorCode: run.failureCode ?? `HERMES_${run.status}`,
          });
        }
        return;
      }
      await sleep(RUN_POLL_INTERVAL_MS, signal);
    }
  }

  async decideApproval(
    principal: ChatPrincipal,
    approvalId: string,
    input: DecideAgentRunApproval,
  ): Promise<AgentRunApproval> {
    const now = new Date();
    const approval = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.agentRunApproval.findFirst({
        where: { id: approvalId, run: { ownerSubject: principal.subject } },
      });
      if (!current) throw new ChatMessageNotFoundError();
      if (current.status !== "PENDING") {
        throw new ChatConversationConflictError("This Hermes approval request has already been decided.");
      }
      if (current.expiresAt <= now) {
        throw new ChatConversationConflictError("This Hermes approval request has expired.");
      }
      const changed = await transaction.agentRunApproval.updateMany({
        where: { id: current.id, status: "PENDING", expiresAt: { gt: now } },
        data: {
          status: input.decision === "ALLOW_ONCE" ? "APPROVED" : "DENIED",
          decision: input.decision,
          decidedAt: now,
          decidedBy: principal.id,
        },
      });
      if (changed.count !== 1) throw new ChatConversationConflictError("This approval changed before the decision was saved.");
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: input.decision === "ALLOW_ONCE" ? "chat.hermes_approval_allowed_once" : "chat.hermes_approval_denied",
        resourceType: "AgentRunApproval",
        resourceId: current.id,
        outcome: "SUCCESS",
        metadata: { runId: current.runId, identityMode: principal.identityMode },
      } });
      return transaction.agentRunApproval.findUniqueOrThrow({ where: { id: current.id } });
    });
    return approvalDto(approval as StoredApproval);
  }

  async fork(
    principal: ChatPrincipal,
    conversationId: string,
    input: ForkChatConversation,
  ): Promise<ChatConversationSummary> {
    const source = await this.prisma.chatConversation.findFirst({
      where: { id: conversationId, ownerSubject: principal.subject },
      include: { messages: { where: { status: "COMPLETED" }, orderBy: { ordinal: "asc" } } },
    });
    if (!source) throw new ChatConversationNotFoundError();
    if (!source.profileId) throw new ChatConfigurationError("The source conversation has no Agent Profile.");
    await this.activeProfile(source.profileId);
    const through = input.throughMessageId
      ? source.messages.find(({ id }) => id === input.throughMessageId)
      : source.messages.at(-1);
    if (input.throughMessageId && !through) throw new ChatMessageNotFoundError();
    const messages = through ? source.messages.filter(({ ordinal }) => ordinal <= through.ordinal) : [];
    const created = await this.prisma.$transaction(async (transaction) => {
      const conversation = await transaction.chatConversation.create({
        data: {
          ownerSubject: principal.subject,
          title: `${source.title.replace(/ \(fork\)$/i, "")} (fork)`.slice(0, 160),
          modelAlias: source.modelAlias,
          profileId: source.profileId,
          profileName: source.profileName,
          generation: Math.ceil(messages.length / 2),
          lastMessageAt: messages.at(-1)?.createdAt ?? null,
          ...(messages.length === 0 ? {} : { messages: {
            create: messages.map((message) => ({
              ordinal: message.ordinal,
              role: message.role,
              status: "COMPLETED" as const,
              content: message.content,
              modelAlias: message.modelAlias,
              inputTokens: message.inputTokens,
              outputTokens: message.outputTokens,
              reasoningTokens: message.reasoningTokens,
              totalTokens: message.totalTokens,
              latencyMs: message.latencyMs,
              firstTokenLatencyMs: message.firstTokenLatencyMs,
              finishReason: message.finishReason,
              sources: message.sources as Prisma.InputJsonValue,
              completedAt: message.completedAt,
            })),
          } }),
        },
        include: { _count: { select: { messages: true } } },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "chat.conversation_forked",
        resourceType: "ChatConversation",
        resourceId: conversation.id,
        outcome: "SUCCESS",
        metadata: { sourceConversationId: source.id, throughMessageId: through?.id ?? null },
      } });
      return conversation;
    });
    return summaryDto(created as StoredConversation);
  }

  async delete(principal: ChatPrincipal, conversationId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const conversation = await transaction.chatConversation.findFirst({
        where: { id: conversationId, ownerSubject: principal.subject },
        select: { id: true, messages: { where: { status: "PENDING" }, select: { id: true }, take: 1 } },
      });
      if (!conversation) throw new ChatConversationNotFoundError();
      if (conversation.messages.length > 0) {
        throw new ChatConversationConflictError("Stop the active Hermes run before deleting this conversation.");
      }
      await transaction.auditEvent.create({ data: {
        actorType: "USER",
        actorId: principal.id,
        action: "chat.conversation_deleted",
        resourceType: "ChatConversation",
        resourceId: conversationId,
        outcome: "SUCCESS",
      } });
      await transaction.chatConversation.delete({ where: { id: conversationId } });
    });
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
      : "Create and activate one Hermes Profile before starting Chat.");
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
