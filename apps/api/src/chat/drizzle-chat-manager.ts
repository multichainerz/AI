import { randomUUID } from "node:crypto";
import {
  isAgentRunEndedEventType,
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
  type ChatSchedule,
  type ChatScheduleList,
  type ChatScheduleOutcome,
  type CreateChatSchedule,
  type SetChatFeedback,
  type DecideAgentRunApproval,
  type ForkChatConversation,
  type GuardrailRule,
  type UpdateChatConversation,
  type UpdateChatSchedule,
} from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunApproval,
  agentRunEvent,
  auditEvent,
  chatConversation,
  chatFeedback,
  chatMessage,
  chatSchedule,
  guardrailPolicy,
  type ChatRunWakeHub,
  type ChatRunWatch,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import type { AgentManager, AgentPrincipal } from "../agents/agent-manager.js";
import { profileVisibleTo } from "../agents/profile-visibility.js";
import {
  inspectInput,
  type GuardrailRuleMatch,
  type RuntimePolicyViolation,
} from "../guardrails/runtime-policy.js";
import {
  ChatConfigurationError,
  ChatConversationArchivedError,
  ChatConversationConflictError,
  ChatConversationNotFoundError,
  ChatMessageNotFoundError,
  ChatPolicyViolationError,
  ChatRateLimitError,
  principalAccountId,
  type ChatManager,
  type ChatPrincipal,
} from "./chat-manager.js";

const STALE_PENDING_AFTER_MS = 65 * 60 * 1_000;
const RUN_POLL_INTERVAL_MS = 350;
/**
 * Floor between two reads of the run row on one stream.
 *
 * The run row no longer ends a stream -- the log's terminal marker does -- so
 * this statement is now only for the intermediate states a turn passes through.
 * Those do not need to be seen any sooner than they used to be, and holding the
 * read to the old cadence keeps a loop that runs faster than the poll interval
 * from multiplying it.
 */
const RUN_STATUS_INTERVAL_MS = 350;
/**
 * Floor between two cursor queries on one stream.
 *
 * With a wake the read rate follows the write rate rather than a timer, so this
 * is a ceiling of about forty passes a second against a producer faster than
 * that. The worker flushes roughly twenty-five times a second, so it does not
 * bind in normal operation -- it exists for the case that is not normal.
 */
const RUN_WAKE_MIN_INTERVAL_MS = 25;
/** The statuses from which a run never leaves. */
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "DENIED"]);

/*
 * Per run, not per conversation. The numbers are the ones the Prisma include
 * carried; what changed is that they are applied where that include applied
 * them, which a flat LIMIT over every run in the conversation did not.
 */
const EVENTS_PER_RUN = 500;
const APPROVALS_PER_RUN = 20;

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
  toolCallKey: string | null;
  text: string | null;
  contentOffset: number | null;
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
  rules: GuardrailRule[];
  guardrailPolicyId: string | null;
  guardrailPolicyVersion: string | null;
}

/**
 * What a refused sender is told.
 *
 * A rule refusal names the rule's *label*, never its pattern and never the text
 * that matched: the label is what an operator wrote to be read, while the
 * pattern is configuration and the text may be the credential the rule exists
 * to catch.
 */
function guardrailRefusal(
  reason: RuntimePolicyViolation,
  matches: readonly GuardrailRuleMatch[],
  maxInputCharacters: number,
): string {
  switch (reason) {
    case "INPUT_CHARACTER_LIMIT":
      return `The active policy limits chat input to ${maxInputCharacters.toLocaleString("en-US")} characters.`;
    case "CONTROL_CHARACTERS":
      return "The active policy blocks unsafe control characters.";
    case "CREDENTIAL_PATTERN":
      return "The active policy blocks content that appears to contain a credential.";
    case "RULE_BUDGET_EXCEEDED":
      return "The active policy could not finish checking this message and refused it rather than sending it unchecked.";
    default: {
      const blocking = matches.filter(({ action }) => action === "BLOCK").map(({ label }) => label);
      return blocking.length > 0
        ? `The active policy blocks this message (${blocking.join(", ")}).`
        : "The active policy blocks this message.";
    }
  }
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
      toolCallKey: event.toolCallKey,
      text: event.text,
      contentOffset: event.contentOffset,
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

/*
 * `lastOutcome` is a varchar in the database and a union on the wire, so it is
 * narrowed here rather than asserted. A value this release does not recognise
 * reads as "never run" instead of failing the parse: this is the field an
 * operator opens when a schedule has stopped working, and it must not be the
 * second thing that breaks.
 */
function scheduleOutcome(value: string | null): ChatScheduleOutcome | null {
  return value === "OK" || value === "SKIPPED" || value === "DISABLED" ? value : null;
}

function scheduleDto(row: typeof chatSchedule.$inferSelect): ChatSchedule {
  return {
    id: row.id,
    conversationId: row.conversationId,
    prompt: row.prompt,
    intervalSeconds: row.intervalSeconds,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastOutcome: scheduleOutcome(row.lastOutcome),
    lastDetail: row.lastDetail,
    enabled: row.enabled,
    createdBySubject: row.createdBySubject,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
    /*
     * `profileVisibleTo` treats a missing division as "no division" — the
     * narrowest reading. Dropping it here is how a person could create a
     * conversation on their division's profile and then 404 on the first send:
     * create used the full principal, submitRun did not.
     */
    divisionId: principal.divisionId ?? null,
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

/**
 * The poll interval, cut short by a wake but never below the floor.
 *
 * The timer is what guarantees the loop looks again; the wake only removes the
 * waiting. The floor is the ceiling on read rate: without it a producer faster
 * than the flush threshold drives one drain per notification, against a pool
 * shared by the entire control plane. It is applied inside the wait rather than
 * added to it, so a stream that already waited out the poll interval adds
 * nothing.
 */
async function waitForNextPass(watch: ChatRunWatch, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  await watch.wait(RUN_POLL_INTERVAL_MS);
  const remaining = RUN_WAKE_MIN_INTERVAL_MS - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining, signal);
}

/** The database handle or a transaction opened from it. */
type Executor = OrcaSynapseDatabase | Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0];

export interface HermesSessionLifecycle {
  forkSession(sourceSessionId: string, targetSessionId: string): Promise<"forked" | "source_absent">;
  deleteSession(sessionId: string): Promise<void>;
}

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
    /**
     * Required, and pass `NO_CHAT_RUN_WAKE` where there is no channel.
     *
     * It was optional once. Deleting the argument at the single place this is
     * constructed for real then left all 577 API tests green, so the entire
     * accelerator could ship inert behind a fully passing suite. A default is
     * exactly the wrong shape for a dependency whose absence is invisible:
     * making it explicit turns that deletion into a compile error.
     */
    private readonly wake: ChatRunWakeHub,
    /** Native transcript lifecycle; OrcaSynapse never copies Hermes memory. */
    private readonly hermesSessions: HermesSessionLifecycle,
  ) {}

  /**
   * Replaces the Prisma message include. The run's events and approvals are
   * fetched per run rather than as a nested relation, because the event set is
   * filtered and bounded independently of the message row.
   *
   * "Per run" is the whole point and it is what the first Drizzle version of
   * this method lost. Prisma applied these limits as *nested* relation limits,
   * which it partitions per parent record; a flat `.limit(500)` over an
   * `inArray` of every run in the conversation applies them once across the
   * lot. Ordered ascending, that keeps the oldest events in the conversation
   * and discards the newest -- so the run the operator is actually watching is
   * the one whose activity trail goes missing, and it gets worse the longer the
   * conversation is useful. The window function restores the original meaning.
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
    /*
     * Ranked newest-first inside each run, then re-ordered ascending for the
     * DTO. Taking the newest is what makes a bound safe to have at all: an
     * older event that falls outside it is history the transcript can lose,
     * where a newer one is the turn in progress.
     */
    const rankedEvents = this.database
      .select({
        ...getTableColumns(agentRunEvent),
        rank: sql<number>`row_number() over (partition by ${agentRunEvent.runId} order by ${agentRunEvent.cursor} desc)`.as("rank"),
      })
      .from(agentRunEvent)
      .where(and(inArray(agentRunEvent.runId, runIds.length === 0 ? [""] : runIds), ne(agentRunEvent.type, "MESSAGE_DELTA")))
      .as("ranked_events");
    const events = runIds.length === 0 ? [] : await this.database
      .select()
      .from(rankedEvents)
      .where(lte(rankedEvents.rank, EVENTS_PER_RUN))
      .orderBy(asc(rankedEvents.cursor));

    const rankedApprovals = this.database
      .select({
        ...getTableColumns(agentRunApproval),
        rank: sql<number>`row_number() over (partition by ${agentRunApproval.runId} order by ${agentRunApproval.requestedAt} desc)`.as("rank"),
      })
      .from(agentRunApproval)
      .where(inArray(agentRunApproval.runId, runIds.length === 0 ? [""] : runIds))
      .as("ranked_approvals");
    const approvals = runIds.length === 0 ? [] : await this.database
      .select()
      .from(rankedApprovals)
      .where(lte(rankedApprovals.rank, APPROVALS_PER_RUN))
      .orderBy(asc(rankedApprovals.requestedAt));

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
    /*
     * `profileId` stays optional in the contract so an omitted field answers
     * with this sentence rather than a schema error naming a field the operator
     * never filled in. What it must not do any more is default to something.
     */
    if (!input.profileId) {
      throw new ChatConfigurationError("Select an Agent Profile to start a Session.");
    }
    const profile = await this.activeProfile(principal, input.profileId);
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
    return {
      ...summaryDto(stored),
      messages: messages.map(messageDto),
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
    requested: string,
  ): Promise<ChatMessageSubmission> {
    const policy = await this.resolvePolicy();
    const inspection = inspectInput(requested, policy, policy.rules);
    if (inspection.decision === "BLOCK") {
      await this.recordGuardrailBlock(principal, conversationId, requested.length, inspection.reason!, policy, inspection.matches);
      throw new ChatPolicyViolationError(guardrailRefusal(inspection.reason!, inspection.matches, policy.maxInputCharacters));
    }

    /*
     * From here on the redacted text is the message, and the parameter is
     * deliberately no longer in scope under a name anybody would reach for.
     *
     * `content` is read three times below -- `safeTitle` when the conversation
     * is still unnamed, the stored USER row, and the input handed to
     * `submitRun`. Redacting only the row would leave the matched credential
     * sitting in the conversation title, on the sidebar of every screen that
     * lists conversations. Rebinding here is what makes it impossible to redact
     * one of the three and miss the others.
     */
    const content = inspection.text;
    if (inspection.matches.length > 0) {
      await this.recordGuardrailMatches(principal, conversationId, inspection.matches, policy);
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
      if (stored.status !== "ACTIVE") throw new ChatConversationArchivedError("Archived conversations cannot accept new messages.");
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
      return {
        profileId: stored.profileId,
        modelAlias: stored.modelAlias,
      };
    });

    let run: Awaited<ReturnType<AgentManager["submitRun"]>> | undefined;
    try {
      run = await this.agents.submitRun(
        asAgentPrincipal(principal),
        { profileId: conversation.profileId!, input: content },
        {
          sessionId: conversationId,
          outputCharacterLimit: policy.maxOutputCharacters,
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
    /*
     * Set when the drain reaches the log's terminal marker, which is the only
     * thing that ends this stream.
     *
     * The outcome used to be read from `AgentRun.status` in a second statement,
     * which cannot be ordered against the events query above it: an event
     * committing between the two reached nobody, and the terminal frame closed
     * the stream on top of it. Ending on a row *in* the log makes that
     * unrepresentable -- everything before the marker was drained by the same
     * query that found it.
     */
    let terminal: typeof agentRunEvent.$inferSelect | null = null;
    /*
     * One extra pass for a run whose status is terminal but whose log has no
     * marker, which is how every run finalised before the marker existed looks.
     * The marker is written in the transaction that sets the status, so if it
     * exists it is visible by the next drain; one pass settles it, and the flag
     * is what stops the question being asked forever.
     */
    let reconciled = false;
    let statusReadAt = 0;
    /**
     * The frame that ends the turn, from whichever source established it.
     *
     * `cursor` is the last event actually handed over -- never the run's own
     * high-water mark. The browser stores every frame's cursor as the point it
     * will reconnect from, and the run can be ahead of this loop, so
     * advertising the run's mark would move a reader's resume point past deltas
     * it never received.
     */
    const emitOutcome = async (
      status: string,
      errorCode: string | null,
      failureMessage: string | null,
    ): Promise<void> => {
      const [message] = await this.loadMessages(eq(chatMessage.id, messageId));
      if (!message) throw new ChatMessageNotFoundError();
      const terminalCursor = cursor === 0n ? null : cursor.toString();
      if (status === "COMPLETED") {
        await emit({ type: "completed", conversationId, messageId, cursor: terminalCursor, message: messageDto(message) });
        return;
      }
      if (status === "CANCELLED") {
        await emit({ type: "cancelled", conversationId, messageId, cursor: terminalCursor });
        return;
      }
      await emit({
        type: "failed",
        conversationId,
        messageId,
        cursor: terminalCursor,
        error: failureMessage ?? `Hermes ended the run as ${status.toLowerCase()}.`,
        errorCode: errorCode ?? `HERMES_${status}`,
      });
    };
    /*
     * Registered before the first query, and inside the `try` that closes it.
     *
     * Before the query, because a notification arriving while nothing is
     * registered has nothing to latch onto and costs the first frame a whole
     * poll interval. After that, ordering stops mattering: a notification either
     * lands in a query that has not run yet, or latches and forces the next wait
     * to return at once.
     *
     * Inside the `try`, because the `started` emit below can throw -- an SSE
     * socket that closed between the route accepting the request and this line
     * is enough -- and a watcher registered outside it would then be leaked for
     * the life of the process.
     */
    const watch = this.wake.watch(runId, signal);
    try {
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
        /*
         * The marker ends the drain, and deliberately does not advance the
         * cursor.
         *
         * Nothing can follow it in the log, and leaving the cursor on the last
         * delivered event is what makes a reconnect idempotent: a browser that
         * resumes from the terminal frame's cursor drains this marker again and
         * is told the outcome again. Advancing past it would make that resume
         * silent -- no events, no marker, and an open stream waiting on a run
         * that already ended.
         *
         * It is not emitted as an activity frame either. The terminal frame
         * below says the same thing in the shape the browser already handles;
         * emitting both would put a card reading "the run ended" in the
         * timeline directly above the answer that says so.
         */
        if (isAgentRunEndedEventType(event.type)) {
          terminal = event;
          break;
        }
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
          toolCallKey: event.toolCallKey,
          text: event.text,
          contentOffset: event.contentOffset,
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
      if (terminal) {
        await emitOutcome(terminal.status ?? "FAILED", terminal.errorCode, terminal.summary);
        return;
      }
      if (events.length === 100) continue;

      /*
       * The run row, for the two things the log cannot give: the intermediate
       * states a turn passes through, and whether a run that predates the
       * marker has already ended.
       *
       * It can no longer end this stream, which is the whole point -- only the
       * marker does. That demotion is also what lets the read be skipped while
       * events are flowing: a state frame arriving a fraction of a second late
       * is invisible, and a wake-driven loop would otherwise run this statement
       * as often as it runs the drain.
       */
      const readAt = Date.now();
      if (events.length === 0 || readAt - statusReadAt >= RUN_STATUS_INTERVAL_MS) {
        statusReadAt = readAt;
        const [run] = await this.database
          .select({
            status: agentRun.status,
            failureCode: agentRun.failureCode,
            failureMessage: agentRun.failureMessage,
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
            cursor: cursor === 0n ? null : cursor.toString(),
            runId,
            status: run.status,
          });
        }
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          // Terminal status, no marker drained. Either it committed after the
          // query above -- in which case the immediate re-drain finds it and
          // this never runs again -- or the run was finalised before markers
          // existed and the run row is the only record of how it ended.
          if (!reconciled) {
            reconciled = true;
            continue;
          }
          await emitOutcome(run.status, run.failureCode, run.failureMessage);
          return;
        }
      }
      await waitForNextPass(watch, signal);
    }
    } finally {
      // Every exit passes through here: the terminal returns, the abort that
      // ends the while, and anything thrown from inside it.
      watch.close();
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
    let nativeForkId: string | null = null;
    try {
      const result = await this.database.transaction(async (transaction) => {
        // This is the same subject lock used by submission, so the Hermes and
        // Orca snapshots cannot diverge while a concurrent turn is being added.
        await acquireChatRateLimitLock(transaction, principal.subject);
        const [sourceRow] = await transaction
          .select()
          .from(chatConversation)
          .where(and(
            eq(chatConversation.id, conversationId),
            eq(chatConversation.ownerSubject, principal.subject),
          ))
          .limit(1);
        const source = sourceRow ? {
          ...sourceRow,
          messages: await transaction
            .select()
            .from(chatMessage)
            .where(and(eq(chatMessage.conversationId, conversationId), eq(chatMessage.status, "COMPLETED")))
            .orderBy(asc(chatMessage.ordinal)),
        } : undefined;
        if (!source) throw new ChatConversationNotFoundError();
        if (!source.profileId) throw new ChatConfigurationError("The source conversation has no Agent Profile.");
        const active = await transaction
          .select({ id: chatMessage.id })
          .from(chatMessage)
          .where(and(eq(chatMessage.conversationId, conversationId), eq(chatMessage.status, "PENDING")))
          .limit(1);
        if (active.length > 0) {
          throw new ChatConversationConflictError("Stop the active Hermes run before forking this conversation.");
        }
        await this.activeProfile(principal, source.profileId);
        const through = input.throughMessageId
          ? source.messages.find(({ id }) => id === input.throughMessageId)
          : source.messages.at(-1);
        if (input.throughMessageId && !through) throw new ChatMessageNotFoundError();
        if (input.throughMessageId && through?.id !== source.messages.at(-1)?.id) {
          throw new ChatConfigurationError(
            "Hermes-native forks branch from the latest completed message. Start the fork there instead.",
          );
        }
        const messages = through ? source.messages.filter(({ ordinal }) => ordinal <= through.ordinal) : [];
        // Ordinals are copied verbatim, so the generation has to be derived from
        // the highest one rather than the row count when failed turns left gaps.
        const highestOrdinal = messages.at(-1)?.ordinal ?? 0;
        const targetSessionId = randomUUID();
        if (messages.length > 0) {
          const forked = await this.hermesSessions.forkSession(source.id, targetSessionId);
          if (forked === "source_absent") {
            throw new ChatConfigurationError(
              "The Hermes-native source session is unavailable, so its context cannot be forked safely.",
            );
          }
          nativeForkId = targetSessionId;
        }
        const [conversation] = await transaction
          .insert(chatConversation)
          .values({
            id: targetSessionId,
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
        return { conversation, messageCount: messages.length };
      });
      return summaryDto({ ...result.conversation, _count: { messages: result.messageCount } } as StoredConversation);
    } catch (error) {
      if (nativeForkId) {
        try {
          await this.hermesSessions.deleteSession(nativeForkId);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "The conversation fork failed and its Hermes-native session could not be cleaned up.",
          );
        }
      }
      throw error;
    }
  }

  async delete(principal: ChatPrincipal, conversationId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await acquireChatRateLimitLock(transaction, principal.subject);
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
      // Delete the authoritative transcript before deleting its projection. If
      // Hermes is unavailable, fail closed so no private session is orphaned.
      await this.hermesSessions.deleteSession(conversationId);
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

  /*
   * ---------------------------------------------------------------------------
   * Schedules
   * ---------------------------------------------------------------------------
   * Stored intent only. Nothing here starts a run; a schedule is a record that
   * `submitMessage` should be called later, and every rule that method enforces
   * is enforced by it then rather than duplicated here. The two checks that do
   * happen at write time -- conversation ownership and the policy's input
   * ceiling -- are here because an operator filling in a form should learn about
   * a refusal now instead of silently on every fire.
   */

  async listSchedules(principal: ChatPrincipal, conversationId: string): Promise<ChatScheduleList> {
    await this.ownedConversation(principal, conversationId);
    const rows = await this.database
      .select()
      .from(chatSchedule)
      .where(eq(chatSchedule.conversationId, conversationId))
      .orderBy(asc(chatSchedule.createdAt), asc(chatSchedule.id));
    return { items: rows.map(scheduleDto) };
  }

  async createSchedule(
    principal: ChatPrincipal,
    conversationId: string,
    input: CreateChatSchedule,
  ): Promise<ChatSchedule> {
    await this.ownedConversation(principal, conversationId);
    await this.assertPromptWithinPolicy(input.prompt);
    /*
     * The account id, not `principal.id`. The dispatcher re-reads this column
     * against `LocalAdministrator` / `EnterpriseUser` on every fire, and a
     * session row id matches neither -- with no foreign key to say so, which is
     * why writing the wrong one here made every schedule disable itself on its
     * first fire instead of failing at creation.
     */
    const createdBy = principalAccountId(principal);
    if (!createdBy) {
      throw new ChatConfigurationError(
        "This sign-in cannot own a schedule, because it is not tied to an account the dispatcher can re-read.",
      );
    }
    /*
     * An absent `startAt` means one interval from now rather than "now". A
     * schedule created without a start time and made immediately due would fire
     * while the operator is still looking at the form they just submitted,
     * which reads as a bug even though it is what "every 5 minutes" literally
     * asks for.
     */
    const nextRunAt = input.startAt
      ? new Date(input.startAt)
      : new Date(Date.now() + input.intervalSeconds * 1_000);
    const created = await this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .insert(chatSchedule)
        .values({
          conversationId,
          prompt: input.prompt,
          intervalSeconds: input.intervalSeconds,
          nextRunAt,
          createdBy,
          createdBySubject: principal.subject,
          createdByMode: principal.identityMode,
        })
        .returning();
      if (!row) throw new ChatConfigurationError("The schedule could not be created.");
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "chat.schedule_created",
        resourceType: "ChatSchedule",
        resourceId: row.id,
        outcome: "SUCCESS",
        metadata: {
          conversationId,
          intervalSeconds: input.intervalSeconds,
          nextRunAt: nextRunAt.toISOString(),
          identityMode: principal.identityMode,
        },
      });
      return row;
    });
    return scheduleDto(created);
  }

  async updateSchedule(
    principal: ChatPrincipal,
    scheduleId: string,
    input: UpdateChatSchedule,
  ): Promise<ChatSchedule> {
    const updated = await this.database.transaction(async (transaction) => {
      /*
       * Ownership first, as `createSchedule` does it.
       *
       * The policy check used to run before this, so a caller who did not own
       * the schedule still learned whether their text fit the deployment's
       * `maxInputCharacters` and whether it tripped a rule -- answers about a
       * resource they were about to be told does not exist.
       */
      const existing = await this.ownedSchedule(transaction, principal, scheduleId);
      /*
       * Enforced inside the transaction that writes, so the row cannot move
       * between the check and the update. Refused as a conflict rather than
       * silently applied: the column existed and was returned to clients from
       * the beginning, and comparing nothing meant two operators editing one
       * schedule took turns overwriting each other with no sign either way.
       */
      if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
        throw new ChatConversationConflictError(
          "This schedule changed since it was loaded. Reopen it and apply the change again.",
        );
      }
      if (input.prompt !== undefined) await this.assertPromptWithinPolicy(input.prompt);
      /*
       * Re-enabling clears the stored reason and re-arms the cadence from now.
       * Leaving `nextRunAt` in the past would make a schedule that had been
       * disabled for a week fire the moment it came back, which is not what
       * "enable" means to the person clicking it.
       */
      const reArm = input.enabled === true && !existing.enabled;
      const interval = input.intervalSeconds ?? existing.intervalSeconds;
      const [row] = await transaction
        .update(chatSchedule)
        .set({
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(reArm
            ? { nextRunAt: new Date(Date.now() + interval * 1_000), lastOutcome: null, lastDetail: null }
            : {}),
          revision: sql`${chatSchedule.revision} + 1`,
        })
        .where(eq(chatSchedule.id, scheduleId))
        .returning();
      if (!row) throw new ChatConversationNotFoundError();
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "chat.schedule_updated",
        resourceType: "ChatSchedule",
        resourceId: scheduleId,
        outcome: "SUCCESS",
        metadata: { fields: Object.keys(input), enabled: row.enabled },
      });
      return row;
    });
    return scheduleDto(updated);
  }

  async deleteSchedule(principal: ChatPrincipal, scheduleId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.ownedSchedule(transaction, principal, scheduleId);
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "chat.schedule_deleted",
        resourceType: "ChatSchedule",
        resourceId: scheduleId,
        outcome: "SUCCESS",
      });
      await transaction.delete(chatSchedule).where(eq(chatSchedule.id, scheduleId));
    });
  }

  /**
   * The conversation, or the same not-found every other owner-scoped read
   * raises. Ownership and existence deliberately produce one error: telling a
   * caller that a conversation exists but belongs to somebody else is itself a
   * disclosure.
   */
  private async ownedConversation(principal: ChatPrincipal, conversationId: string): Promise<void> {
    const [conversation] = await this.database
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(and(
        eq(chatConversation.id, conversationId),
        eq(chatConversation.ownerSubject, principal.subject),
      ))
      .limit(1);
    if (!conversation) throw new ChatConversationNotFoundError();
  }

  /** The same test, reached through the schedule's conversation. */
  private async ownedSchedule(
    transaction: OrcaSynapseDatabase,
    principal: ChatPrincipal,
    scheduleId: string,
  ): Promise<{ enabled: boolean; intervalSeconds: number; revision: number }> {
    const [row] = await transaction
      .select({
        enabled: chatSchedule.enabled,
        intervalSeconds: chatSchedule.intervalSeconds,
        revision: chatSchedule.revision,
      })
      .from(chatSchedule)
      .innerJoin(chatConversation, eq(chatSchedule.conversationId, chatConversation.id))
      .where(and(
        eq(chatSchedule.id, scheduleId),
        eq(chatConversation.ownerSubject, principal.subject),
      ))
      .limit(1);
    if (!row) throw new ChatConversationNotFoundError();
    return row;
  }

  /**
   * The policy's input ceiling, checked while the operator is still on the form.
   *
   * Only the length. The rule and detector checks stay where they run today --
   * inside `submitMessage`, against the policy active at the moment of the fire
   * -- because a policy activated after this schedule was written must still
   * govern it. Checking the ceiling here is worth the duplication because it is
   * the one refusal an operator can fix immediately by shortening what they
   * typed.
   */
  private async assertPromptWithinPolicy(prompt: string): Promise<void> {
    const policy = await this.resolvePolicy();
    if (prompt.length > policy.maxInputCharacters) {
      throw new ChatPolicyViolationError(
        `The scheduled prompt is ${prompt.length} characters; the active guardrail policy allows ${policy.maxInputCharacters}.`,
      );
    }
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

  /**
   * Resolve one named, visible, active profile. Never guess one.
   *
   * The id was optional until increment A, and omitting it fell through to
   * `orderBy(desc(updatedAt)).limit(1)` -- the caller was handed whichever
   * profile had been edited most recently. Harmless while every user may use
   * every profile; a free read of another division's agent the moment they may
   * not, requiring no UUID at all, just an absent field.
   *
   * Now the id is required by the signature, so a caller that has none is a
   * compile error rather than a silent default, and the lookup no longer
   * filters on status: visibility and activeness are different answers with
   * different codes. Not visible is 404 (see `profileVisibleTo` for why
   * absence and refusal must be indistinguishable); visible but not active is a
   * configuration conflict naming what to fix.
   */
  private async activeProfile(
    principal: ChatPrincipal,
    profileId: string,
  ): Promise<{ id: string; displayName: string; modelAlias: string; version: number }> {
    const [profile] = await this.database
      .select({
        id: agentProfile.id,
        status: agentProfile.status,
        activeVersion: agentProfile.activeVersion,
        // Selected because the visibility rule reads it. Omit it and the rule
        // sees undefined, which it treats as deployment-wide -- the gate would
        // pass every profile while looking exactly as it does now.
        divisionId: agentProfile.divisionId,
      })
      .from(agentProfile)
      .where(eq(agentProfile.id, profileId))
      .limit(1);
    if (!profileVisibleTo(principal, profile)) throw new ChatConversationNotFoundError();
    if (profile.status !== "ACTIVE" || !profile.activeVersion) {
      throw new ChatConfigurationError("The selected Agent Profile is not active.");
    }
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
    /*
     * The latch is "a policy has been authored", not "a policy was ever
     * activated". It used to be the latter, and the gap between the two was a
     * silent one: an operator who created a policy and its rules but never
     * pressed Activate got a success toast, a configured-looking screen, and a
     * chat that enforced nothing -- with no error anywhere saying so. Counting
     * every row keeps a fresh install (zero policies) permissive while making
     * an authored-but-inactive catalogue refuse with instructions instead of
     * quietly waving everything through.
     */
    const [enforcement] = await this.database
      .select({ total: count() })
      .from(guardrailPolicy);
    const catalogueEnforced = (enforcement?.total ?? 0) > 0;
    const policies = !catalogueEnforced ? [] : await this.database
      .select({
        id: guardrailPolicy.id,
        version: guardrailPolicy.version,
        maxInputCharacters: guardrailPolicy.maxInputCharacters,
        maxOutputCharacters: guardrailPolicy.maxOutputCharacters,
        blockControlCharacters: guardrailPolicy.blockControlCharacters,
        blockCredentialPatterns: guardrailPolicy.blockCredentialPatterns,
        rules: guardrailPolicy.rules,
      })
      .from(guardrailPolicy)
      .where(eq(guardrailPolicy.status, "ACTIVE"))
      .limit(2);
    if (catalogueEnforced && policies.length === 0) throw new ChatConfigurationError("Activate one guardrail policy before using Chat.");
    if (policies.length > 1) throw new ChatConfigurationError("More than one chat guardrail policy is active.");
    const policy = policies[0];
    return {
      requestsPerMinute: 12,
      maxInputCharacters: policy?.maxInputCharacters ?? 32_000,
      maxOutputCharacters: policy?.maxOutputCharacters ?? 200_000,
      blockControlCharacters: policy?.blockControlCharacters ?? true,
      blockCredentialPatterns: policy?.blockCredentialPatterns ?? true,
      rules: (policy?.rules ?? []) as GuardrailRule[],
      guardrailPolicyId: policy?.id ?? null,
      guardrailPolicyVersion: policy?.version ?? null,
    };
  }

  /**
   * Records what matched without recording what it matched.
   *
   * Counts and labels only. A CREDENTIAL_PATTERN or a credential-shaped rule
   * fires precisely because the message looked like a key, so quoting the text
   * to explain the event would put that key in the audit trail — which is
   * retained, forwarded to a SIEM, and readable by every AUDITOR.
   */
  private async recordGuardrailMatches(
    principal: ChatPrincipal,
    conversationId: string,
    matches: readonly GuardrailRuleMatch[],
    policy: ChatPolicy,
  ): Promise<void> {
    const summarise = (action: GuardrailRuleMatch["action"]) => matches
      .filter((match) => match.action === action)
      .map(({ ruleId, label, count }) => ({ ruleId, label, count }));

    for (const [action, event] of [["REDACT", "guardrail.request_redacted"], ["FLAG", "guardrail.rule_flagged"]] as const) {
      const applicable = summarise(action);
      if (applicable.length === 0) continue;
      await this.database.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: event,
        resourceType: "ChatConversation", resourceId: conversationId, outcome: "SUCCESS",
        metadata: { policyId: policy.guardrailPolicyId, policyVersion: policy.guardrailPolicyVersion, rules: applicable },
      }).catch(() => undefined);
    }
  }

  private async recordGuardrailBlock(
    principal: ChatPrincipal,
    conversationId: string,
    observedCharacters: number,
    violation: string,
    policy: ChatPolicy,
    matches: readonly GuardrailRuleMatch[] = [],
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
      metadata: {
        policyId: policy.guardrailPolicyId,
        policyVersion: policy.guardrailPolicyVersion,
        reason: violation,
        observedCharacters,
        maxInputCharacters: policy.maxInputCharacters,
        // Labels and counts, never the matched text. See recordGuardrailMatches.
        rules: matches.map(({ ruleId, label, action, count }) => ({ ruleId, label, action, count })),
      },
    });
  }
}
