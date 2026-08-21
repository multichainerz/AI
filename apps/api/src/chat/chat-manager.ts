import type {
  ChatConversation,
  ChatConversationList,
  ChatConversationSummary,
  ChatStreamEvent,
  ChatFeedback,
  ChatMetrics,
  ChatMessageSubmission,
  AgentRunApproval,
  DecideAgentRunApproval,
  ForkChatConversation,
  SetChatFeedback,
  CreateChatConversation,
  UpdateChatConversation,
  ChatSchedule,
  ChatScheduleList,
  CreateChatSchedule,
  UpdateChatSchedule,
} from "@orcasynapse/contracts";

export interface ChatPrincipal {
  /*
   * The *session* row id, not the account's.
   *
   * `AdministratorSession` has no `administratorId` column at all, and the
   * enterprise session exposes its own primary key rather than the user's, so
   * this uuid is meaningless to `LocalAdministrator` and `EnterpriseUser`.
   * Anything stored to be resolved again after the session is gone must record
   * `principalAccountId(...)` instead -- see the note there.
   */
  id: string;
  subject: string;
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW";
  scopes: readonly string[];
  /** As `AgentPrincipal.divisionId`. */
  divisionId?: string | null;
}

/*
 * A uuid as both session managers format it into a subject. Deliberately the
 * same shape `AdminSessionManager.changeLocalPassword` tests with, because this
 * function exists for the same reason: the account id is recoverable only by
 * parsing it back out of the subject.
 */
const ACCOUNT_ID_PATTERN = /^[0-9a-f-]{36}$/i;

/**
 * The durable account uuid behind a principal, or `null` if it has none.
 *
 * `ChatPrincipal.id` is a session row id, so a column that stores it and
 * resolves it later against `LocalAdministrator` or `EnterpriseUser` matches
 * nothing -- silently, because no foreign key spans a session id and an account
 * table. The account uuid survives only inside `subject`, which the two session
 * managers mint as `local-admin:<uuid>` (`admin-session.ts`) and `user:<uuid>`
 * (`enterprise-session.ts`).
 *
 * Returns null rather than throwing for the installation-key recovery session,
 * whose subject is the literal `installation-key-administrator`. That session
 * carries only `sessions:manage` and so cannot reach any chat route, but a
 * parser that assumed every subject held a uuid would be wrong about it.
 */
export function principalAccountId(principal: {
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW";
  subject: string;
}): string | null {
  const prefix = principal.identityMode === "ENTERPRISE" ? "user:" : "local-admin:";
  if (!principal.subject.startsWith(prefix)) return null;
  const accountId = principal.subject.slice(prefix.length);
  return ACCOUNT_ID_PATTERN.test(accountId) ? accountId : null;
}

export interface ChatManager {
  list(principal: ChatPrincipal): Promise<ChatConversationList>;
  create(
    principal: ChatPrincipal,
    input: CreateChatConversation,
  ): Promise<ChatConversationSummary>;
  get(principal: ChatPrincipal, conversationId: string): Promise<ChatConversation>;
  update(
    principal: ChatPrincipal,
    conversationId: string,
    input: UpdateChatConversation,
  ): Promise<ChatConversationSummary>;
  submitMessage(
    principal: ChatPrincipal,
    conversationId: string,
    content: string,
  ): Promise<ChatMessageSubmission>;
  subscribe(
    principal: ChatPrincipal,
    conversationId: string,
    messageId: string,
    afterCursor: string | null,
    /*
     * Awaited by the implementation, so a consumer that cannot take the next
     * frame yet stops the producer. Typed as widely here as it is there: the
     * narrower `=> void` let a caller supply an emit that silently discarded
     * backpressure while still satisfying this interface.
     */
    emit: (event: ChatStreamEvent) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  cancelActiveRun(
    principal: ChatPrincipal,
    conversationId: string,
  ): Promise<ChatConversation>;
  setFeedback(
    principal: ChatPrincipal,
    messageId: string,
    input: SetChatFeedback,
  ): Promise<ChatFeedback>;
  decideApproval(
    principal: ChatPrincipal,
    approvalId: string,
    input: DecideAgentRunApproval,
  ): Promise<AgentRunApproval>;
  fork(
    principal: ChatPrincipal,
    conversationId: string,
    input: ForkChatConversation,
  ): Promise<ChatConversationSummary>;
  delete(principal: ChatPrincipal, conversationId: string): Promise<void>;
  /*
   * Standing instructions to post a prompt into a conversation on a timer.
   *
   * Scoped to conversations the caller owns, exactly as `submitMessage` is: a
   * schedule is a stored intent to call that method later, so it must not be
   * creatable anywhere that method could not be called now.
   */
  listSchedules(principal: ChatPrincipal, conversationId: string): Promise<ChatScheduleList>;
  createSchedule(
    principal: ChatPrincipal,
    conversationId: string,
    input: CreateChatSchedule,
  ): Promise<ChatSchedule>;
  updateSchedule(
    principal: ChatPrincipal,
    scheduleId: string,
    input: UpdateChatSchedule,
  ): Promise<ChatSchedule>;
  deleteSchedule(principal: ChatPrincipal, scheduleId: string): Promise<void>;
  metrics(): Promise<ChatMetrics>;
}

export class ChatConversationNotFoundError extends Error {
  constructor() {
    super("The conversation does not exist or is not available to this identity.");
    this.name = "ChatConversationNotFoundError";
  }
}

export class ChatMessageNotFoundError extends Error {
  constructor() {
    super("The completed assistant response does not exist or is not available to this identity.");
    this.name = "ChatMessageNotFoundError";
  }
}

export class ChatConversationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatConversationConflictError";
  }
}

/**
 * A conflict that will refuse identically forever, rather than one that lost a race.
 *
 * `ChatConversationConflictError` covers both, and every route maps the two the
 * same way -- 409 either way, because to the caller they are both "not now". The
 * distinction exists for the schedule dispatcher, which has to decide whether to
 * try again next interval or stop the schedule and tell somebody.
 *
 * Archiving is a decision the operator made and it does not come back on its
 * own. A run already in progress, a message submitted at the same instant, and a
 * pending response cancelled mid-submission are all races -- they clear by
 * themselves, and disabling a schedule for one turns a busy minute into a
 * morning report that never came back.
 */
export class ChatConversationArchivedError extends ChatConversationConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ChatConversationArchivedError";
  }
}

export class ChatConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatConfigurationError";
  }
}

export class ChatRateLimitError extends Error {
  constructor() {
    super("The chat request limit was reached. Wait a moment before trying again.");
    this.name = "ChatRateLimitError";
  }
}

export class ChatPolicyViolationError extends Error {
  constructor(message = "The request was blocked by the active OrcaSynapse guardrail policy.") {
    super(message);
    this.name = "ChatPolicyViolationError";
  }
}
