import type {
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatStreamEvent,
} from "@aihub/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AIHubApiError,
  createChatConversation,
  getChatConversation,
  getChatConversations,
  streamChatMessage,
  setChatFeedback,
  updateChatConversation,
} from "./api.js";

interface ChatViewProps {
  unlocked: boolean;
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW" | null;
  displayName: string | null;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onUnauthorized: () => void;
}

function emptyMessage(
  conversationId: string,
  id: string,
  role: "USER" | "ASSISTANT",
  content: string,
  status: ChatMessage["status"],
): ChatMessage {
  return {
    id,
    conversationId,
    role,
    status,
    content,
    modelAlias: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: null,
    finishReason: null,
    errorCode: null,
    sources: [],
    feedback: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

function formatConversationTime(value: string | null): string {
  if (!value) return "No messages";
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ChatView({
  unlocked,
  identityMode,
  displayName,
  oidcConfigured,
  onSignIn,
  onConfigure,
  onUnauthorized,
}: ChatViewProps) {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);

  const handleError = (cause: unknown, fallback: string) => {
    if (cause instanceof AIHubApiError && cause.status === 401) onUnauthorized();
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const refreshList = async () => {
    const result = await getChatConversations();
    setConversations(result.items);
    return result.items;
  };

  useEffect(() => {
    if (!unlocked) {
      setConversations([]);
      setActive(null);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    void getChatConversations()
      .then(async ({ items }) => {
        if (!current) return;
        setConversations(items);
        if (items[0]) setActive(await getChatConversation(items[0].id));
      })
      .catch((cause) => current && handleError(cause, "Unable to load conversations."))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
      abortController.current?.abort();
    };
  }, [unlocked]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth" });
  }, [active?.messages, busy]);

  const selectConversation = async (id: string) => {
    if (busy) return;
    setLoading(true);
    setError(null);
    try {
      setActive(await getChatConversation(id));
      setHistoryOpen(false);
    } catch (cause) {
      handleError(cause, "Unable to open the conversation.");
    } finally {
      setLoading(false);
    }
  };

  const newConversation = () => {
    if (busy) return;
    setActive(null);
    setDraft("");
    setError(null);
    setHistoryOpen(false);
  };

  const applyStreamEvent = (event: ChatStreamEvent) => {
    setActive((current) => {
      if (!current || current.id !== event.conversationId) return current;
      if (event.type === "started") {
        if (current.messages.some(({ id }) => id === event.messageId)) return current;
        return {
          ...current,
          messages: [
            ...current.messages,
            emptyMessage(current.id, event.messageId, "ASSISTANT", "", "PENDING"),
          ],
        };
      }
      if (event.type === "delta") {
        return {
          ...current,
          messages: current.messages.map((message) =>
            message.id === event.messageId
              ? { ...message, content: message.content + event.delta }
              : message,
          ),
        };
      }
      if (event.type === "completed") {
        return {
          ...current,
          messages: current.messages.map((message) =>
            message.id === event.messageId ? event.message : message,
          ),
        };
      }
      return {
        ...current,
        messages: current.messages.map((message) =>
          message.id === event.messageId
            ? {
                ...message,
                status: event.type === "cancelled" ? "CANCELLED" : "FAILED",
                errorCode: event.type === "failed" ? event.errorCode : "INFERENCE_CANCELLED",
              }
            : message,
        ),
      };
    });
    if (event.type === "failed") setError(event.error);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy || !unlocked) return;
    setBusy(true);
    setError(null);
    setDraft("");
    let conversation = active;
    try {
      if (!conversation) {
        const created = await createChatConversation();
        conversation = await getChatConversation(created.id);
        setConversations((items) => [created, ...items]);
      }
      const optimistic = emptyMessage(
        conversation.id,
        crypto.randomUUID(),
        "USER",
        content,
        "COMPLETED",
      );
      setActive({ ...conversation, messages: [...conversation.messages, optimistic] });
      const controller = new AbortController();
      abortController.current = controller;
      await streamChatMessage(conversation.id, content, applyStreamEvent, controller.signal);
      const refreshed = await getChatConversation(conversation.id);
      setActive(refreshed);
      await refreshList();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        handleError(cause, "Unable to send the message.");
      }
      if (conversation) {
        await getChatConversation(conversation.id).then(setActive).catch(() => undefined);
        await refreshList().catch(() => undefined);
      }
    } finally {
      abortController.current = null;
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!active || busy) return;
    setLoading(true);
    setError(null);
    try {
      await updateChatConversation(active.id, { status: "ARCHIVED" });
      const items = await refreshList();
      const next = items.find(({ id }) => id !== active.id && statusIsActive(id, items));
      setActive(next ? await getChatConversation(next.id) : null);
    } catch (cause) {
      handleError(cause, "Unable to archive the conversation.");
    } finally {
      setLoading(false);
    }
  };

  const recordFeedback = async (
    messageId: string,
    rating: "HELPFUL" | "NOT_HELPFUL",
  ) => {
    if (feedbackBusy) return;
    setFeedbackBusy(messageId);
    setError(null);
    try {
      const feedback = await setChatFeedback(messageId, rating);
      setActive((current) => current ? {
        ...current,
        messages: current.messages.map((message) =>
          message.id === messageId ? { ...message, feedback } : message,
        ),
      } : current);
    } catch (cause) {
      handleError(cause, "Unable to record feedback.");
    } finally {
      setFeedbackBusy(null);
    }
  };

  if (!unlocked) {
    return (
      <section className="chat-locked">
        <div className="chat-lock-mark" aria-hidden="true">AI</div>
        <p className="page-kicker">Governed on-premise AI</p>
        <h1>{oidcConfigured ? "Sign in to MPM AIHub" : "Enterprise access is not configured"}</h1>
        <p>{oidcConfigured
          ? "Use your approved MPM identity. AIHub checks the configured group allowlist before creating a local session."
          : "An administrator must configure and successfully test the enterprise OIDC connection before employees can enter Chat."}</p>
        <div className="chat-lock-actions">
          {oidcConfigured && <button className="primary-button" type="button" onClick={onSignIn}>Sign in with MPM</button>}
          <button className={oidcConfigured ? "text-button" : "primary-button"} type="button" onClick={onConfigure}>Administrator setup</button>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-workspace">
      <aside className={historyOpen ? "chat-history open" : "chat-history"}>
        <div className="chat-history-heading">
          <div><p className="page-kicker">Workspace</p><h1>Chat</h1></div>
          <button className="chat-new-button" type="button" onClick={newConversation}>+ New</button>
        </div>
        <div className="chat-history-list" aria-label="Conversation history">
          {conversations.length === 0 && !loading && (
            <p className="chat-history-empty">Your conversations will appear here.</p>
          )}
          {conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              className={active?.id === conversation.id ? "selected" : ""}
              onClick={() => void selectConversation(conversation.id)}
            >
              <strong>{conversation.title}</strong>
              <span>{conversation.lastMessagePreview ?? conversation.modelAlias}</span>
              <small>{conversation.status === "ARCHIVED" ? "Archived" : formatConversationTime(conversation.lastMessageAt)}</small>
            </button>
          ))}
        </div>
        <div className="chat-preview-note">
          <span>Identity mode</span>
          <strong>{identityMode === "ENTERPRISE" ? "Enterprise OIDC" : "Administrator preview"}</strong>
          <small>{displayName ?? "Active AIHub session"}</small>
        </div>
      </aside>

      <div className="chat-main">
        <header className="chat-topbar">
          <button className="history-toggle" type="button" onClick={() => setHistoryOpen((value) => !value)} aria-label="Toggle conversation history">☰</button>
          <div>
            <strong>{active?.title ?? "New conversation"}</strong>
            <span>{active?.modelAlias ?? "Uses the active LiteLLM model route"}</span>
          </div>
          {active && <button type="button" disabled={busy || loading} onClick={() => void archive()}>Archive</button>}
        </header>

        <div className="chat-messages" aria-live="polite">
          {!active || active.messages.length === 0 ? (
            <div className="chat-welcome">
              <div className="chat-welcome-mark">M</div>
              <p className="page-kicker">MPM AIHub</p>
              <h2>How can I help?</h2>
              <p>Responses stay on the configured on-premise inference route and include approved document context when relevant. Tools remain disabled.</p>
              <div className="chat-suggestions">
                <button type="button" onClick={() => setDraft("Summarize the main considerations for an on-premise AI deployment.")}>Outline an on-premise AI deployment</button>
                <button type="button" onClick={() => setDraft("Create a concise risk checklist for deploying an internal AI assistant.")}>Create an AI risk checklist</button>
              </div>
            </div>
          ) : (
            active.messages.map((message) => (
              <article className={`chat-message ${message.role.toLowerCase()}`} key={message.id}>
                <div className="message-avatar">{message.role === "USER" ? "You" : "M"}</div>
                <div>
                  <div className="message-heading">
                    <strong>{message.role === "USER" ? "You" : "MPM AIHub"}</strong>
                    {message.status !== "COMPLETED" && <span>{message.status.toLowerCase()}</span>}
                  </div>
                  <p>{message.content || (message.status === "PENDING" ? "Thinking…" : "No content returned.")}</p>
                  {message.sources.length > 0 && (
                    <div className="message-sources" aria-label="Enterprise knowledge sources">
                      <strong>Sources</strong>
                      <div>{message.sources.map((source) => (
                        <article key={source.documentId}>
                          <span>{source.fileName}</span>
                          <small>{source.classification.toLowerCase()} · {Math.round(source.score * 100)}% match</small>
                        </article>
                      ))}</div>
                    </div>
                  )}
                  {message.role === "ASSISTANT" && message.status === "COMPLETED" && (
                    <div className="message-meta">
                      <small>{message.totalTokens === null ? "Usage pending" : `${message.totalTokens.toLocaleString()} tokens`} · {message.latencyMs === null ? "Latency pending" : `${(message.latencyMs / 1000).toFixed(1)} s`}</small>
                      <div className="message-feedback" aria-label="Response feedback">
                        <button
                          type="button"
                          aria-label="Mark response helpful"
                          aria-pressed={message.feedback?.rating === "HELPFUL"}
                          disabled={feedbackBusy === message.id}
                          onClick={() => void recordFeedback(message.id, "HELPFUL")}
                        >Helpful</button>
                        <button
                          type="button"
                          aria-label="Mark response not helpful"
                          aria-pressed={message.feedback?.rating === "NOT_HELPFUL"}
                          disabled={feedbackBusy === message.id}
                          onClick={() => void recordFeedback(message.id, "NOT_HELPFUL")}
                        >Not helpful</button>
                      </div>
                    </div>
                  )}
                  {(message.status === "FAILED" || message.status === "CANCELLED") && (
                    <small className="message-failure">{message.status === "CANCELLED" ? "Generation cancelled" : `Generation failed · ${message.errorCode ?? "UNKNOWN"}`}</small>
                  )}
                </div>
              </article>
            ))
          )}
          <div ref={messageEnd}/>
        </div>

        <div className="chat-composer-wrap">
          {error && <div className="chat-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
          <form className="chat-composer" onSubmit={submit}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Message the approved on-premise model"
              rows={1}
              maxLength={32_000}
              disabled={busy}
              aria-label="Chat message"
            />
            {busy ? (
              <button className="stop-button" type="button" onClick={() => abortController.current?.abort()}>Stop</button>
            ) : (
              <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message">↑</button>
            )}
          </form>
          <p>{identityMode === "ENTERPRISE" ? "Enterprise session" : "Administrator preview"} · LiteLLM only · approved private knowledge · no tools</p>
        </div>
      </div>
    </section>
  );
}

function statusIsActive(
  id: string,
  items: ChatConversationSummary[],
): boolean {
  return items.find((item) => item.id === id)?.status === "ACTIVE";
}
