import type {
  ChatConversation,
  ChatConversationList,
  ChatConversationSummary,
  ChatStreamEvent,
  ChatFeedback,
  ChatMetrics,
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
  update(
    principal: ChatPrincipal,
    conversationId: string,
    input: UpdateChatConversation,
  ): Promise<ChatConversationSummary>;
  streamMessage(
    principal: ChatPrincipal,
    conversationId: string,
    content: string,
    signal: AbortSignal,
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void>;
  setFeedback(
    principal: ChatPrincipal,
    messageId: string,
    input: SetChatFeedback,
  ): Promise<ChatFeedback>;
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
