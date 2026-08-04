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
} from "@orcasynapse/contracts";

export interface ChatPrincipal {
  id: string;
  subject: string;
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW";
  scopes: readonly string[];
}

export interface ChatManager {
  list(principal: ChatPrincipal): Promise<ChatConversationList>;
  create(
    principal: ChatPrincipal,
    input: CreateChatConversation,
  ): Promise<ChatConversationSummary>;
  get(principal: ChatPrincipal, conversationId: string): Promise<ChatConversation>;
  attachDocument(principal: ChatPrincipal, conversationId: string, documentId: string): Promise<ChatConversation>;
  detachDocument(principal: ChatPrincipal, conversationId: string, documentId: string): Promise<ChatConversation>;
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
    emit: (event: ChatStreamEvent) => void,
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
