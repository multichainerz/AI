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
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunApproval,
  agentRunEvent,
  auditEvent,
  chatConversation,
  chatConversationDocument,
  chatFeedback,
  chatMessage,
  document,
  guardrailPolicy,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
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
  // PostgreSQL numeric arrives as a string; the DTO narrows it to a number.
  costUsd: string | number | null;
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

/** The database handle or a transaction opened from it. */
type Executor = OrcaSynapseDatabase | Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0];

async function acquireChatRateLimitLock(
  transaction: Pick<Executor, "execute">,
  subject: string,
): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`orcasynapse-chat:${subject}`}))`);
}

export class DrizzleChatManager implements ChatManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly agents: AgentManager,
  ) {}

  /**
   * Replaces the Prisma message include. The run's events and approvals are
   * fetched per run rather than as a nested relation, because the event set is
   * filtered and bounded independently of the message row.
   */
  private async loadMessages(where: SQL<unknown>): Promise<StoredMessage[]> {
    const rows = await this.database
      .select({
        message: chatMessage,
        feedback: chatFeedback,
        runStatus: agentRun.status,
        lastEventCursor: agentRun.lastEventCursor,
      })
      .from(chatMessage)
      .leftJoin(chatFeedback, eq(chatFeedback.messageId, chatMessage.id))
      .leftJoin(agentRun, eq(chatMessage.agentRunId, agentRun.id))
      .where(where)
      .orderBy(asc(chatMessage.ordinal));

    const runIds = rows.flatMap(({ message }) => message.agentRunId ? [message.agentRunId] : []);
    const events = runIds.length === 0 ? [] : await this.database
      .select()
      .from(agentRunEvent)
      .where(and(inArray(agentRunEvent.runId, runIds), ne(agentRunEvent.type, "MESSAGE_DELTA")))
      .orderBy(asc(agentRunEvent.cursor))
      .limit(500);
    const approvals = runIds.length === 0 ? [] : await this.database
      .select()
      .from(agentRunApproval)
      .where(inArray(agentRunApproval.runId, runIds))
      .orderBy(asc(agentRunApproval.requestedAt))
      .limit(20);

    return rows.map(({ message, feedback, runStatus, lastEventCursor }) => ({
      ...message,
      feedback,
      agentRun: message.agentRunId && runStatus
        ? {
          status: runStatus,
          lastEventCursor: lastEventCursor === null ? null : BigInt(lastEventCursor),
          events: events.filter(({ runId }) => runId === message.agentRunId) as StoredRunEvent[],
          approvals: approvals.filter(({ runId }) => runId === message.agentRunId) as StoredApproval[],
        }
        : null,
    }) as StoredMessage);
  }

  /** Message counts per conversation, replacing Prisma's `_count`. */
  private async messageCounts(conversationIds: string[]): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.database
      .select({ conversationId: chatMessage.conversationId, total: count() })
      .from(chatMessage)
      .where(inArray(chatMessage.conversationId, conversationIds))
      .groupBy(chatMessage.conversationId);
    return new Map(rows.map(({ conversationId, total }) => [conversationId, total]));
  }

  /** The documents pinned to a conversation, newest pin first. */
  private async pinnedDocuments(conversationId: string) {
    return this.database
      .select({
        id: document.id,
        fileName: document.fileName,
        classification: document.classification,
        status: document.status,
      })
      .from(chatConversationDocument)
      .innerJoin(document, eq(chatConversationDocument.documentId, document.id))
      .where(eq(chatConversationDocument.conversationId, conversationId))
      .orderBy(desc(chatConversationDocument.createdAt));
  }

  async attachDocument(principal: ChatPrincipal, conversationId: string, documentId: string): Promise<ChatConversation> {
    const [conversation] = await this.database
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(and(eq(chatConversation.id, conversationId), eq(chatConversation.ownerSubject, principal.subject)))
      .limit(1);
    if (!conversation) throw new ChatConversationNotFoundError();
    // The document must be the caller's own and actually retrievable, or the
    // pin would silently narrow retrieval to nothing.
    const [source] = await this.database
      .select({ id: document.id })
      .from(document)
      .where(and(
        eq(document.id, documentId),
        eq(document.ownerSubject, principal.subject),
        eq(document.status, "READY"),
        isNull(document.deletedAt),
      ))
      .limit(1);
    if (!source) throw new ChatMessageNotFoundError();
    await this.database
      .insert(chatConversationDocument)
      .values({ conversationId, documentId, ownerSubject: principal.subject })
      .onConflictDoNothing();
    await this.database.insert(auditEvent).values({
      actorType: "USER", actorId: principal.id, action: "chat.knowledge_pinned",
      resourceType: "ChatConversation", resourceId: conversationId, outcome: "SUCCESS",
      metadata: { documentId },
    });
    return this.get(principal, conversationId);
  }

  async detachDocument(principal: ChatPrincipal, conversationId: string, documentId: string): Promise<ChatConversation> {
    const [conversation] = await this.database
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(and(eq(chatConversation.id, conversationId), eq(chatConversation.ownerSubject, principal.subject)))
      .limit(1);
    if (!conversation) throw new ChatConversationNotFoundError();
    const removed = await this.database
      .delete(chatConversationDocument)
      .where(and(
        eq(chatConversationDocument.conversationId, conversationId),
        eq(chatConversationDocument.documentId, documentId),
      ))
      .returning({ id: chatConversationDocument.id });
    if (removed.length === 1) {
      await this.database.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "chat.knowledge_unpinned",
        resourceType: "ChatConversation", resourceId: conversationId, outcome: "SUCCESS",
        metadata: { documentId },
      });
    }
    return this.get(principal, conversationId);
  }

  async list(principal: ChatPrincipal): Promise<ChatConversationList> {
    const conversations = await this.database
      .select()
      .from(chatConversation)
      .where(eq(chatConversation.ownerSubject, principal.subject))
      .orderBy(desc(chatConversation.lastMessageAt), desc(chatConversation.updatedAt))
      .limit(100);
    const ids = conversations.map(({ id }) => id);
    const counts = await this.messageCounts(ids);
    // The preview is the newest message that actually carries text.
    const previews = ids.length === 0 ? [] : await this.database
      .selectDistinctOn([chatMessage.conversationId], {
        conversationId: chatMessage.conversationId,
        content: chatMessage.content,
      })
      .from(chatMessage)
      .where(and(inArray(chatMessage.conversationId, ids), ne(chatMessage.content, "")))
      .orderBy(chatMessage.conversationId, desc(chatMessage.ordinal));
    const previewByConversation = new Map(previews.map(({ conversationId, content }) => [conversationId, content]));
    return {
      items: conversations.map((conversation) => summaryDto({
        ...conversation,
        _count: { messages: counts.get(conversation.id) ?? 0 },
        messages: previewByConversation.has(conversation.id)
          ? [{ content: previewByConversation.get(conversation.id)! } as StoredMessage]
          : [],
      } as StoredConversation)),
    };
  }

  async create(principal: ChatPrincipal, input: CreateChatConversation): Promise<ChatConversationSummary> {
    const profile = await this.activeProfile(input.profileId);
    if (input.modelAlias && input.modelAlias !== profile.modelAlias) {
      throw new ChatConfigurationError(`Agent '${profile.displayName}' uses model '${profile.modelAlias}'.`);
    }
    const conversation = await this.database.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(chatConversation)
        .values({
          ownerSubject: principal.subject,
          title: input.title ?? "New conversation",
          modelAlias: profile.modelAlias,
          profileId: profile.id,
          profileName: profile.displayName,
        })
        .returning();
      if (!created) throw new ChatConfigurationError("The conversation could not be created.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "chat.hermes_conversation_created",
        resourceType: "ChatConversation", resourceId: created.id, outcome: "SUCCESS",
        metadata: { profileId: profile.id, profileVersion: profile.version, modelAlias: profile.modelAlias, identityMode: principal.identityMode },
      });
      return created;
    });
    return summaryDto({ ...conversation, _count: { messages: 0 } } as StoredConversation);
  }

  async get(principal: ChatPrincipal, conversationId: string): Promise<ChatConversation> {
    const [conversation] = await this.database
      .select()
      .from(chatConversation)
      .where(and(
        eq(chatConversation.id, conversationId),
        eq(chatConversation.ownerSubject, principal.subject),
      ))
      .limit(1);
    if (!conversation) throw new ChatConversationNotFoundError();
    const messages = await this.loadMessages(eq(chatMessage.conversationId, conversationId));
    const stored = { ...conversation, _count: { messages: messages.length }, messages } as StoredConversation;
    const pinned = await this.pinnedDocuments(conversationId);
    return {
      ...summaryDto(stored),
      messages: messages.map(messageDto),
      knowledgeDocuments: pinned.map((source) => ({
        id: source.id,
        fileName: source.fileName,
        classification: source.classification,
        status: source.status,
      })),
    };
  }

  async update(principal: ChatPrincipal, conversationId: string, input: UpdateChatConversation): Promise<ChatConversationSummary> {
    const result = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(chatConversation)
        .set({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.status === undefined ? {} : { status: input.status }),
        })
        .where(and(
          eq(chatConversation.id, conversationId),
          eq(chatConversation.ownerSubject, principal.subject),
        ))
        .returning();
      const [conversation] = updated;
      if (updated.length !== 1 || !conversation) throw new ChatConversationNotFoundError();
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "chat.conversation_updated",
        resourceType: "ChatConversation", resourceId: conversationId, outcome: "SUCCESS",
        metadata: { fields: Object.keys(input) },
      });
      return conversation;
    });
    const counts = await this.messageCounts([conversationId]);
    return summaryDto({ ...result, _count: { messages: counts.get(conversationId) ?? 0 } } as StoredConversation);
  }

  async cancelActiveRun(principal: ChatPrincipal, conversationId: string): Promise<ChatConversation> {
    const [pending] = await this.database
      .select({ id: chatMessage.id, agentRunId: chatMessage.agentRunId })
      .from(chatMessage)
      .innerJoin(chatConversation, eq(chatMessage.conversationId, chatConversation.id))
      .where(and(
        eq(chatMessage.conversationId, conversationId),
        eq(chatMessage.role, "ASSISTANT"),
        eq(chatMessage.status, "PENDING"),
        eq(chatConversation.ownerSubject, principal.subject),
      ))
      .orderBy(desc(chatMessage.createdAt))
      .limit(1);
    if (!pending) throw new ChatConversationConflictError("No Hermes run is currently active for this conversation.");

    if (pending.agentRunId) {
      await this.agents.cancelRun(asAgentPrincipal(principal), pending.agentRunId, false);
    } else {
      // The run was never submitted, so there is nothing for Hermes to cancel.
      await this.database
        .update(chatMessage)
        .set({
          status: "CANCELLED",
          errorCode: "CANCELLED_BEFORE_HERMES_SUBMISSION",
          completedAt: new Date(),
        })
        .where(and(
          eq(chatMessage.id, pending.id),
          eq(chatMessage.status, "PENDING"),
          sql`${chatMessage.agentRunId} is null`,
        ));
    }
    await this.database.insert(auditEvent).values({
      actorType: "USER", actorId: principal.id, action: "chat.hermes_run_cancel_requested",
      resourceType: "ChatMessage", resourceId: pending.id, outcome: "SUCCESS",
      metadata: { conversationId, runId: pending.agentRunId },
    });
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
    const conversation = await this.database.transaction(async (transaction) => {
      await acquireChatRateLimitLock(transaction, principal.subject);
      const [recent] = await transaction
        .select({ total: count() })
        .from(chatMessage)
        .innerJoin(chatConversation, eq(chatMessage.conversationId, chatConversation.id))
        .where(and(
          eq(chatMessage.role, "USER"),
          gte(chatMessage.createdAt, new Date(now.getTime() - 60_000)),
          eq(chatConversation.ownerSubject, principal.subject),
        ));
      if ((recent?.total ?? 0) >= policy.requestsPerMinute) throw new ChatRateLimitError();
      const [stored] = await transaction
        .select()
        .from(chatConversation)
        .where(and(
          eq(chatConversation.id, conversationId),
          eq(chatConversation.ownerSubject, principal.subject),
        ))
        .limit(1);
      if (!stored) throw new ChatConversationNotFoundError();
      if (stored.status !== "ACTIVE") throw new ChatConversationConflictError("Archived conversations cannot accept new messages.");
      if (!stored.profileId || !stored.profileName) {
        throw new ChatConfigurationError("This legacy conversation has no Agent Profile. Start a new conversation.");
      }
      const history = await transaction
        .select({
          id: chatMessage.id,
          ordinal: chatMessage.ordinal,
          role: chatMessage.role,
          status: chatMessage.status,
          content: chatMessage.content,
          createdAt: chatMessage.createdAt,
          agentRunId: chatMessage.agentRunId,
        })
        .from(chatMessage)
        .where(eq(chatMessage.conversationId, conversationId))
        .orderBy(desc(chatMessage.ordinal))
        .limit(42);
      const pending = history.find(({ role, status }) => role === "ASSISTANT" && status === "PENDING");
      if (pending?.createdAt && pending.createdAt.getTime() > now.getTime() - STALE_PENDING_AFTER_MS) {
        throw new ChatConversationConflictError("This conversation already has a Hermes run in progress.");
      }
      if (pending) {
        await transaction
          .update(chatMessage)
          .set({ status: "FAILED", errorCode: "HERMES_RUN_ABANDONED", completedAt: now })
          .where(and(eq(chatMessage.id, pending.id), eq(chatMessage.status, "PENDING")));
      }
      // Claiming the generation is what serialises concurrent submissions.
      const generation = stored.generation + 1;
      const claimed = await transaction
        .update(chatConversation)
        .set({
          generation,
          lastMessageAt: now,
          ...(stored.title === "New conversation" ? { title: safeTitle(content) } : {}),
        })
        .where(and(
          eq(chatConversation.id, stored.id),
          eq(chatConversation.ownerSubject, principal.subject),
          eq(chatConversation.generation, stored.generation),
        ))
        .returning({ id: chatConversation.id });
      if (claimed.length !== 1) throw new ChatConversationConflictError("Another message was submitted at the same time.");
      await transaction.insert(chatMessage).values([
        { id: userMessageId, conversationId, ordinal: generation * 2 - 1, role: "USER", status: "COMPLETED", content, completedAt: now },
        { id: assistantMessageId, conversationId, ordinal: generation * 2, role: "ASSISTANT", status: "PENDING", content: "", modelAlias: stored.modelAlias },
      ]);
      const pinned = await transaction
        .select({ documentId: chatConversationDocument.documentId })
        .from(chatConversationDocument)
        .where(eq(chatConversationDocument.conversationId, conversationId));
      return {
        profileId: stored.profileId,
        modelAlias: stored.modelAlias,
        hermesMemoryKey: stored.hermesMemoryKey,
        history: boundedConversationHistory(history),
        knowledgeDocumentIds: pinned.map(({ documentId }) => documentId),
      };
    });

    let run: Awaited<ReturnType<AgentManager["submitRun"]>> | undefined;
    try {
      run = await this.agents.submitRun(
        asAgentPrincipal(principal),
        { profileId: conversation.profileId!, input: content },
        {
          sessionId: conversationId,
          memorySessionKey: conversation.hermesMemoryKey,
          conversationHistory: conversation.history,
          outputCharacterLimit: policy.maxOutputCharacters,
          ...(conversation.knowledgeDocumentIds.length > 0
            ? { knowledgeDocumentIds: conversation.knowledgeDocumentIds }
            : {}),
        },
      );
      const linked = await this.database
        .update(chatMessage)
        .set({ agentRunId: run.id })
        .where(and(eq(chatMessage.id, assistantMessageId), eq(chatMessage.status, "PENDING")))
        .returning({ id: chatMessage.id });
      if (linked.length !== 1) {
        await this.agents.cancelRun(asAgentPrincipal(principal), run.id, false).catch(() => undefined);
        throw new ChatConversationConflictError("The pending response was cancelled before Hermes submission completed.");
      }
      await this.database.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "chat.hermes_run_requested",
        resourceType: "ChatMessage", resourceId: assistantMessageId, outcome: "SUCCESS",
        metadata: { conversationId, runId: run.id, profileId: run.profileId, profileVersion: run.profileVersion, enforcementPlane: "ORCASYNAPSE" },
      });
    } catch (error) {
      const errorCode = "HERMES_SUBMISSION_FAILED";
      await this.database.transaction(async (transaction) => {
        await transaction
          .update(chatMessage)
          .set({ status: "FAILED", errorCode, completedAt: new Date() })
          .where(and(eq(chatMessage.id, assistantMessageId), eq(chatMessage.status, "PENDING")));
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "chat.hermes_run_failed",
          resourceType: "ChatMessage", resourceId: assistantMessageId, outcome: "FAILURE",
          metadata: { conversationId, runId: run?.id ?? null, errorCode, guardrailPolicyId: policy.guardrailPolicyId },
        });
      });
      throw error;
    }

    const messages = await this.loadMessages(inArray(chatMessage.id, [userMessageId, assistantMessageId]));
    const userMessage = messages.find(({ id }) => id === userMessageId);
    const assistantMessage = messages.find(({ id }) => id === assistantMessageId);
    if (!userMessage || !assistantMessage) throw new ChatMessageNotFoundError();
    return {
      conversationId,
      userMessage: messageDto(userMessage),
      assistantMessage: messageDto(assistantMessage),
    };
  }

  async subscribe(
    principal: ChatPrincipal,
    conversationId: string,
    messageId: string,
    afterCursor: string | null,
    // Awaited, so a consumer that cannot take the next frame yet — an SSE
    // response whose socket is holding what was already written — stops this
    // loop instead of letting a replay accumulate in the process.
    emit: (event: ChatStreamEvent) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const [linked] = await this.database
      .select({ agentRunId: chatMessage.agentRunId })
      .from(chatMessage)
      .innerJoin(chatConversation, eq(chatMessage.conversationId, chatConversation.id))
      .where(and(
        eq(chatMessage.id, messageId),
        eq(chatMessage.conversationId, conversationId),
        eq(chatMessage.role, "ASSISTANT"),
        eq(chatConversation.ownerSubject, principal.subject),
      ))
      .limit(1);
    if (!linked) throw new ChatMessageNotFoundError();
    if (!linked.agentRunId) throw new ChatConversationConflictError("The Hermes run has not been linked yet.");
    const runId = linked.agentRunId;
    let cursor = afterCursor && /^\d+$/.test(afterCursor) ? BigInt(afterCursor) : 0n;
    let previousStatus: string | null = null;
    await emit({ type: "started", conversationId, messageId, runId, cursor: cursor === 0n ? null : cursor.toString() });

    while (!signal.aborted) {
      const events = await this.database
        .select()
        .from(agentRunEvent)
        .where(and(eq(agentRunEvent.runId, runId), gt(agentRunEvent.cursor, cursor)))
        .orderBy(asc(agentRunEvent.cursor))
        .limit(100);
      const approvalIds = events.flatMap(({ approvalId }) => approvalId ? [approvalId] : []);
      const approvals = approvalIds.length === 0 ? [] : await this.database
        .select()
        .from(agentRunApproval)
        .where(and(inArray(agentRunApproval.id, approvalIds), eq(agentRunApproval.runId, runId)));
      const approvalById = new Map(approvals.map((approval) => [approval.id, approval]));
      for (const event of events) {
        cursor = event.cursor;
        const eventCursor = cursor.toString();
        if (event.type === "MESSAGE_DELTA" && event.delta) {
          await emit({ type: "delta", conversationId, messageId, cursor: eventCursor, delta: event.delta });
          continue;
        }
        await emit({
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
          await emit({
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

      const [run] = await this.database
        .select({
          status: agentRun.status,
          failureCode: agentRun.failureCode,
          failureMessage: agentRun.failureMessage,
          lastEventCursor: agentRun.lastEventCursor,
        })
        .from(agentRun)
        .where(eq(agentRun.id, runId))
        .limit(1);
      if (!run) throw new ChatConversationConflictError("The Hermes run is no longer available.");
      if (run.status !== previousStatus) {
        previousStatus = run.status;
        await emit({
          type: "state",
          conversationId,
          messageId,
          cursor: run.lastEventCursor?.toString() ?? (cursor === 0n ? null : cursor.toString()),
          runId,
          status: run.status,
        });
      }
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "DENIED"].includes(run.status)) {
        const [message] = await this.loadMessages(eq(chatMessage.id, messageId));
        if (!message) throw new ChatMessageNotFoundError();
        const dto = messageDto(message);
        const terminalCursor = run.lastEventCursor?.toString() ?? (cursor === 0n ? null : cursor.toString());
        if (run.status === "COMPLETED") {
          await emit({ type: "completed", conversationId, messageId, cursor: terminalCursor, message: dto });
        } else if (run.status === "CANCELLED") {
          await emit({ type: "cancelled", conversationId, messageId, cursor: terminalCursor });
        } else {
          await emit({
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
    const approval = await this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ approval: agentRunApproval })
        .from(agentRunApproval)
        .innerJoin(agentRun, eq(agentRunApproval.runId, agentRun.id))
        .where(and(
          eq(agentRunApproval.id, approvalId),
          eq(agentRun.ownerSubject, principal.subject),
        ))
        .limit(1)
        .then((rows) => rows.map(({ approval: row }) => row));
      if (!current) throw new ChatMessageNotFoundError();
      if (current.status !== "PENDING") {
        throw new ChatConversationConflictError("This Hermes approval request has already been decided.");
      }
      if (current.expiresAt <= now) {
        throw new ChatConversationConflictError("This Hermes approval request has expired.");
      }
      const changed = await transaction
        .update(agentRunApproval)
        .set({
          status: input.decision === "ALLOW_ONCE" ? "APPROVED" : "DENIED",
          decision: input.decision,
          decidedAt: now,
          decidedBy: principal.id,
        })
        .where(and(
          eq(agentRunApproval.id, current.id),
          eq(agentRunApproval.status, "PENDING"),
          gt(agentRunApproval.expiresAt, now),
        ))
        .returning();
      const [decided] = changed;
      if (changed.length !== 1 || !decided) {
        throw new ChatConversationConflictError("This approval changed before the decision was saved.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: input.decision === "ALLOW_ONCE" ? "chat.hermes_approval_allowed_once" : "chat.hermes_approval_denied",
        resourceType: "AgentRunApproval",
        resourceId: current.id,
        outcome: "SUCCESS",
        metadata: { runId: current.runId, identityMode: principal.identityMode },
      });
      return decided;
    });
    return approvalDto(approval as StoredApproval);
  }

  async fork(
    principal: ChatPrincipal,
    conversationId: string,
    input: ForkChatConversation,
  ): Promise<ChatConversationSummary> {
    const [sourceRow] = await this.database
      .select()
      .from(chatConversation)
      .where(and(
        eq(chatConversation.id, conversationId),
        eq(chatConversation.ownerSubject, principal.subject),
      ))
      .limit(1);
    const source = sourceRow ? {
      ...sourceRow,
      messages: await this.database
        .select()
        .from(chatMessage)
        .where(and(eq(chatMessage.conversationId, conversationId), eq(chatMessage.status, "COMPLETED")))
        .orderBy(asc(chatMessage.ordinal)),
    } : undefined;
    if (!source) throw new ChatConversationNotFoundError();
    if (!source.profileId) throw new ChatConfigurationError("The source conversation has no Agent Profile.");
    await this.activeProfile(source.profileId);
    const through = input.throughMessageId
      ? source.messages.find(({ id }) => id === input.throughMessageId)
      : source.messages.at(-1);
    if (input.throughMessageId && !through) throw new ChatMessageNotFoundError();
    const messages = through ? source.messages.filter(({ ordinal }) => ordinal <= through.ordinal) : [];
    // Ordinals are copied verbatim, so the generation has to be derived from the
    // highest of them rather than from the row count. A turn skipped *below* the
    // fork point - a failed or still-running assistant reply - leaves the copied
    // set sparse, and a count-derived generation would then place the next
    // submission's `generation * 2 - 1` back onto an ordinal that was already
    // copied, violating ChatMessage_conversationId_ordinal_key. That rolls the
    // submission back, so the generation never advances and the fork stays
    // permanently unusable. (A gap *above* the fork point is harmless: those rows
    // are never copied.) Renumbering densely on copy would close the gap too, but
    // it repoints every ordinal away from the source's, so a `throughMessageId`
    // read can no longer be lined up against the conversation it was forked from,
    // and it breaks the odd-USER/even-ASSISTANT pairing that `generation * 2`
    // encodes. Keeping the numbering and moving the generation is the cheaper
    // trade. `messages` is ordered by ordinal, so the last row carries the max.
    const highestOrdinal = messages.at(-1)?.ordinal ?? 0;
    const created = await this.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .insert(chatConversation)
        .values({
          ownerSubject: principal.subject,
          title: `${source.title.replace(/ \(fork\)$/i, "")} (fork)`.slice(0, 160),
          modelAlias: source.modelAlias,
          profileId: source.profileId,
          profileName: source.profileName,
          generation: Math.ceil(highestOrdinal / 2),
          lastMessageAt: messages.at(-1)?.createdAt ?? null,
        })
        .returning();
      if (!conversation) throw new ChatConfigurationError("The forked conversation could not be created.");
      if (messages.length > 0) {
        // The fork copies completed turns only; runs and feedback stay with the source.
        await transaction.insert(chatMessage).values(messages.map((message) => ({
          conversationId: conversation.id,
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
          sources: message.sources,
          completedAt: message.completedAt,
        })));
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "chat.conversation_forked",
        resourceType: "ChatConversation",
        resourceId: conversation.id,
        outcome: "SUCCESS",
        metadata: { sourceConversationId: source.id, throughMessageId: through?.id ?? null },
      });
      return conversation;
    });
    return summaryDto({ ...created, _count: { messages: messages.length } } as StoredConversation);
  }

  async delete(principal: ChatPrincipal, conversationId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [conversation] = await transaction
        .select({ id: chatConversation.id })
        .from(chatConversation)
        .where(and(
          eq(chatConversation.id, conversationId),
          eq(chatConversation.ownerSubject, principal.subject),
        ))
        .limit(1);
      if (!conversation) throw new ChatConversationNotFoundError();
      const active = await transaction
        .select({ id: chatMessage.id })
        .from(chatMessage)
        .where(and(eq(chatMessage.conversationId, conversationId), eq(chatMessage.status, "PENDING")))
        .limit(1);
      if (active.length > 0) {
        throw new ChatConversationConflictError("Stop the active Hermes run before deleting this conversation.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "chat.conversation_deleted",
        resourceType: "ChatConversation",
        resourceId: conversationId,
        outcome: "SUCCESS",
      });
      await transaction.delete(chatConversation).where(eq(chatConversation.id, conversationId));
    });
  }

  async setFeedback(principal: ChatPrincipal, messageId: string, input: SetChatFeedback): Promise<ChatFeedback> {
    const feedback = await this.database.transaction(async (transaction) => {
      const [message] = await transaction
        .select({ id: chatMessage.id, conversationId: chatMessage.conversationId })
        .from(chatMessage)
        .innerJoin(chatConversation, eq(chatMessage.conversationId, chatConversation.id))
        .where(and(
          eq(chatMessage.id, messageId),
          eq(chatMessage.role, "ASSISTANT"),
          eq(chatMessage.status, "COMPLETED"),
          eq(chatConversation.ownerSubject, principal.subject),
        ))
        .limit(1);
      if (!message) throw new ChatMessageNotFoundError();
      const [saved] = await transaction
        .insert(chatFeedback)
        .values({ messageId, ownerSubject: principal.subject, rating: input.rating, comment: input.comment ?? null })
        .onConflictDoUpdate({
          target: chatFeedback.messageId,
          set: { rating: input.rating, comment: input.comment ?? null, updatedAt: new Date() },
        })
        .returning();
      if (!saved) throw new ChatMessageNotFoundError();
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "chat.feedback_recorded", resourceType: "ChatMessage",
        resourceId: messageId, outcome: "SUCCESS", metadata: { conversationId: message.conversationId, rating: saved.rating, identityMode: principal.identityMode },
      });
      return saved;
    });
    return { rating: feedback.rating, comment: feedback.comment, createdAt: feedback.createdAt.toISOString(), updatedAt: feedback.updatedAt.toISOString() };
  }

  async metrics(): Promise<ChatMetrics> {
    const generatedAt = new Date();
    const windowStartedAt = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1_000);
    const feedbackCount = async (rating: "HELPFUL" | "NOT_HELPFUL") => this.database
      .select({ total: count() })
      .from(chatFeedback)
      .where(and(eq(chatFeedback.rating, rating), gte(chatFeedback.createdAt, windowStartedAt)))
      .then(([row]) => row?.total ?? 0);
    const [conversations, messages, helpful, notHelpful] = await Promise.all([
      this.database
        .select({ total: count() })
        .from(chatConversation)
        .where(gte(chatConversation.createdAt, windowStartedAt))
        .then(([row]) => row?.total ?? 0),
      this.database
        .select({ status: chatMessage.status, totalTokens: chatMessage.totalTokens, latencyMs: chatMessage.latencyMs })
        .from(chatMessage)
        .where(and(
          eq(chatMessage.role, "ASSISTANT"),
          inArray(chatMessage.status, ["COMPLETED", "FAILED", "CANCELLED"]),
          gte(chatMessage.createdAt, windowStartedAt),
        )),
      feedbackCount("HELPFUL"),
      feedbackCount("NOT_HELPFUL"),
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
    const [profile] = await this.database
      .select({ id: agentProfile.id, activeVersion: agentProfile.activeVersion })
      .from(agentProfile)
      .where(and(
        ...(profileId ? [eq(agentProfile.id, profileId)] : []),
        eq(agentProfile.status, "ACTIVE"),
        isNotNull(agentProfile.activeVersion),
      ))
      .orderBy(desc(agentProfile.updatedAt))
      .limit(1);
    if (!profile?.activeVersion) throw new ChatConfigurationError(profileId
      ? "The selected Agent Profile is not active."
      : "Create and activate one Hermes Profile before starting Chat.");
    const [version] = await this.database
      .select({
        displayName: agentProfileVersion.displayName,
        modelAlias: agentProfileVersion.modelAlias,
        version: agentProfileVersion.version,
      })
      .from(agentProfileVersion)
      .where(and(
        eq(agentProfileVersion.profileId, profile.id),
        eq(agentProfileVersion.version, profile.activeVersion),
      ))
      .limit(1);
    if (!version) throw new ChatConfigurationError("The active Agent Profile distribution is unavailable.");
    return { id: profile.id, displayName: version.displayName, modelAlias: version.modelAlias, version: version.version };
  }

  private async resolvePolicy(): Promise<ChatPolicy> {
    const [enforcement] = await this.database
      .select({ total: count() })
      .from(guardrailPolicy)
      .where(isNotNull(guardrailPolicy.firstActivatedAt));
    const catalogueEnforced = (enforcement?.total ?? 0) > 0;
    const policies = !catalogueEnforced ? [] : await this.database
      .select({
        id: guardrailPolicy.id,
        version: guardrailPolicy.version,
        maxInputCharacters: guardrailPolicy.maxInputCharacters,
        maxOutputCharacters: guardrailPolicy.maxOutputCharacters,
        blockControlCharacters: guardrailPolicy.blockControlCharacters,
        blockCredentialPatterns: guardrailPolicy.blockCredentialPatterns,
      })
      .from(guardrailPolicy)
      .where(eq(guardrailPolicy.status, "ACTIVE"))
      .limit(2);
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
    const [conversation] = await this.database
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(and(
        eq(chatConversation.id, conversationId),
        eq(chatConversation.ownerSubject, principal.subject),
      ))
      .limit(1);
    if (!conversation) throw new ChatConversationNotFoundError();
    await this.database.insert(auditEvent).values({
      actorType: "USER", actorId: principal.id, action: "guardrail.request_blocked",
      resourceType: "ChatConversation", resourceId: conversationId, outcome: "FAILURE",
      metadata: { policyId: policy.guardrailPolicyId, policyVersion: policy.guardrailPolicyVersion, reason: violation, observedCharacters, maxInputCharacters: policy.maxInputCharacters },
    });
  }
}
