import type {
  AgentProfile,
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatStreamEvent,
} from "@orcasynapse/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createChatConversation,
  getChatConversation,
  getChatConversations,
  getAgentProfiles,
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

interface ClientCrypto {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

let fallbackMessageSequence = 0;

export function createClientMessageId(
  cryptoApi: ClientCrypto | null | undefined = globalThis.crypto as ClientCrypto | undefined,
): string {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    // This identifier exists only until the server-supplied message replaces
    // the optimistic row. It is never used as an authentication token.
    const seed = `${Date.now()}-${fallbackMessageSequence += 1}-${Math.random()}`;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = seed.charCodeAt(index % seed.length) ^ ((index * 31) & 0xff);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    agentRunId: null,
    runtimeEvents: [],
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

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTokenCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function formatLatency(value: number | null): string {
  if (value === null) return "—";
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(2)} s`;
}

export interface ChatTelemetryMetric {
  key: "throughput" | "input" | "output" | "total" | "latency" | "finish";
  label: string;
  value: string;
}

export function chatMessageTelemetry(message: ChatMessage): ChatTelemetryMetric[] {
  const throughput = message.outputTokens !== null && message.latencyMs !== null && message.latencyMs > 0
    ? `${(message.outputTokens / (message.latencyMs / 1_000)).toFixed(1)} tok/s`
    : "—";
  return [
    { key: "throughput", label: "Effective speed", value: throughput },
    { key: "input", label: "Input", value: formatTokenCount(message.inputTokens) },
    { key: "output", label: "Output", value: formatTokenCount(message.outputTokens) },
    { key: "total", label: "Total", value: formatTokenCount(message.totalTokens) },
    { key: "latency", label: "Latency", value: formatLatency(message.latencyMs) },
    {
      key: "finish",
      label: "Finish",
      value: message.finishReason?.replaceAll("_", " ").toLowerCase() ?? "—",
    },
  ];
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
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [currentActivity, setCurrentActivity] = useState<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);

  const handleError = (cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
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
      setProfiles([]);
      return;
    }
    let current = true;
    setLoading(true);
    void Promise.all([getChatConversations(), getAgentProfiles(false)])
      .then(async ([{ items }, profileList]) => {
        if (!current) return;
        setConversations(items);
        const activeProfiles = profileList.items.filter(({ status }) => status === "ACTIVE");
        setProfiles(activeProfiles);
        setSelectedProfileId((selected) => selected || activeProfiles[0]?.id || "");
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

  useEffect(() => {
    if (streamStartedAt === null) return;
    const updateElapsed = () => setStreamElapsedMs(Date.now() - streamStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [streamStartedAt]);

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
    setCurrentActivity(null);
  };

  const applyStreamEvent = (event: ChatStreamEvent) => {
    if (event.type === "started") setCurrentActivity("Hermes run queued");
    if (event.type === "activity") {
      setCurrentActivity(event.toolName ?? event.summary ?? event.activity.replaceAll("_", " ").toLowerCase());
    }
    if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
      setCurrentActivity(null);
    }
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
      if (event.type === "activity") {
        return current;
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
        if (!selectedProfileId) throw new Error("Activate an Agent Profile before starting Chat.");
        const created = await createChatConversation({ profileId: selectedProfileId });
        conversation = await getChatConversation(created.id);
        setConversations((items) => [created, ...items]);
      }
      const optimistic = emptyMessage(
        conversation.id,
        createClientMessageId(),
        "USER",
        content,
        "COMPLETED",
      );
      setActive({ ...conversation, messages: [...conversation.messages, optimistic] });
      const controller = new AbortController();
      abortController.current = controller;
      setStreamElapsedMs(0);
      setStreamStartedAt(Date.now());
      setCurrentActivity("Hermes run queued");
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
      setStreamStartedAt(null);
      setCurrentActivity(null);
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
        <h1>{oidcConfigured ? "Sign in to OrcaSynapse" : "Enterprise access is not configured"}</h1>
        <p>{oidcConfigured
          ? "Use your approved OrcaSynapse identity. OrcaSynapse checks the configured group allowlist before creating a local session."
          : "An administrator must configure and successfully test the enterprise OIDC connection before employees can enter Chat."}</p>
        <div className="chat-lock-actions">
          {oidcConfigured && <button className="primary-button" type="button" onClick={onSignIn}>Sign in with OrcaSynapse</button>}
          <button className={oidcConfigured ? "text-button" : "primary-button"} type="button" onClick={onConfigure}>Administrator setup</button>
        </div>
      </section>
    );
  }

  const assistantResponses = active?.messages.filter(({ role }) => role === "ASSISTANT") ?? [];
  const completedResponses = assistantResponses.filter(({ status }) => status === "COMPLETED");
  const conversationTotalTokens = completedResponses.reduce(
    (total, message) => total + (message.totalTokens ?? 0),
    0,
  );

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
              <span>{conversation.lastMessagePreview ?? conversation.profileName ?? conversation.modelAlias}</span>
              <small>{conversation.status === "ARCHIVED" ? "Archived" : formatConversationTime(conversation.lastMessageAt)}</small>
            </button>
          ))}
        </div>
        <div className="chat-preview-note">
          <div className="chat-preview-identity">
            <i aria-hidden="true" />
            <div><span>Identity mode</span><strong>{identityMode === "ENTERPRISE" ? "Enterprise Access" : "Administrator preview"}</strong><small>{displayName ?? "Active OrcaSynapse session"}</small></div>
          </div>
          <dl>
            <div><dt>Agent</dt><dd>{active?.profileName ?? "Choose below"}</dd></div>
            <div><dt>Usage</dt><dd>{conversationTotalTokens.toLocaleString()} tokens</dd></div>
          </dl>
        </div>
      </aside>

      <div className="chat-main">
        <header className="chat-topbar">
          <button className="history-toggle" type="button" onClick={() => setHistoryOpen((value) => !value)} aria-label="Toggle conversation history">☰</button>
          <div className="chat-topbar-title">
            <strong>{active?.title ?? "New conversation"}</strong>
            <span>{active ? `${active.profileName ?? "Legacy route"} · ${active.messages.length} messages` : "Start a governed Hermes conversation"}</span>
          </div>
          <div className="chat-runtime-summary" aria-label="Conversation runtime summary">
            <span className={busy ? "generating" : "ready"}><i aria-hidden="true" />{busy ? `${currentActivity ?? "Hermes is working"} · ${(streamElapsedMs / 1_000).toFixed(1)} s` : "Hermes ready"}</span>
            <span><small>Model</small><strong>{active?.modelAlias ?? "Active default"}</strong></span>
            <span><small>Session usage</small><strong>{conversationTotalTokens.toLocaleString()} tok</strong></span>
          </div>
          {active && <button type="button" disabled={busy || loading} onClick={() => void archive()}>Archive</button>}
        </header>

        <div className="chat-messages" aria-live="polite">
          {!active || active.messages.length === 0 ? (
            <div className="chat-welcome">
              <div className="chat-welcome-mark">H</div>
              <p className="page-kicker">Hermes through OrcaSynapse</p>
              <h2>How can I help?</h2>
              <p>Every response is a governed Hermes Agent Run. Your selected profile controls behavior, skills, memory access, and tool policy.</p>
              <label className="chat-profile-picker">
                <span>Agent Profile</span>
                <select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
                  {profiles.length === 0 && <option value="">No active profiles</option>}
                  {profiles.map((profile) => (
                    <option value={profile.id} key={profile.id}>{profile.activeVersionConfiguration?.displayName ?? profile.version.displayName}</option>
                  ))}
                </select>
                <small>{profiles.length === 0 ? "Activate a profile in Agents before chatting." : "This profile remains bound to the conversation."}</small>
              </label>
              <div className="chat-suggestions">
                <button type="button" onClick={() => setDraft("Summarize the main considerations for an on-premise AI deployment.")}>Outline an on-premise AI deployment</button>
                <button type="button" onClick={() => setDraft("Create a concise risk checklist for deploying an internal AI assistant.")}>Create an AI risk checklist</button>
              </div>
            </div>
          ) : (
            active.messages.map((message) => (
              <article className={`chat-message ${message.role.toLowerCase()}`} key={message.id}>
                <div className="message-avatar">{message.role === "USER" ? "You" : "H"}</div>
                <div className="message-body">
                  <div className="message-heading">
                    <div><strong>{message.role === "USER" ? "You" : active.profileName ?? "Hermes"}</strong><time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time></div>
                    <div className="message-heading-tags">
                      {message.role === "ASSISTANT" && <span className="model">{message.modelAlias ?? active.modelAlias}</span>}
                      {message.status !== "COMPLETED" && <span className={`status ${message.status.toLowerCase()}`}>{message.status.toLowerCase()}</span>}
                    </div>
                  </div>
                  <p>{message.content || (message.status === "PENDING" ? "Thinking…" : "No content returned.")}</p>
                  {message.role === "ASSISTANT" && message.status === "PENDING" && (
                    <div className="message-stream-status" aria-label="Live generation status">
                      <span><i aria-hidden="true" />{currentActivity ?? "Hermes is working"}</span>
                      <small>{busy ? `${(streamElapsedMs / 1_000).toFixed(1)} s elapsed` : "Awaiting recovery"} · governed run details appear as Hermes reports them</small>
                    </div>
                  )}
                  {message.role === "ASSISTANT" && message.runtimeEvents.length > 0 && (
                    <details className="message-runtime-events">
                      <summary>{message.runtimeEvents.length} Hermes runtime event{message.runtimeEvents.length === 1 ? "" : "s"}</summary>
                      <ol>{message.runtimeEvents.map((runtimeEvent) => (
                        <li key={runtimeEvent.id}>
                          <strong>{runtimeEvent.type.replaceAll("_", " ").toLowerCase()}</strong>
                          <span>{runtimeEvent.toolName ?? runtimeEvent.summary ?? "Runtime lifecycle update"}</span>
                        </li>
                      ))}</ol>
                    </details>
                  )}
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
                    <>
                      <section className="message-telemetry" aria-label="Response performance">
                        <header><div><strong>Response telemetry</strong><small>Reported by Hermes lifecycle events and measured by OrcaSynapse</small></div>{message.sources.length > 0 && <span>{message.sources.length} knowledge source{message.sources.length === 1 ? "" : "s"}</span>}</header>
                        <dl>{chatMessageTelemetry(message).map((metric) => (
                          <div className={metric.key === "throughput" ? "primary" : undefined} key={metric.key}>
                            <dt>{metric.label}</dt><dd>{metric.value}</dd>
                          </div>
                        ))}</dl>
                      </section>
                      <div className="message-meta">
                        <small>Effective speed is output tokens divided by end-to-end response latency.</small>
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
                    </>
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
            <div className="chat-composer-input">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Message your selected Hermes agent"
                rows={1}
                maxLength={32_000}
                disabled={busy}
                aria-label="Chat message"
              />
              <div><span>Enter to send · Shift + Enter for a new line</span><span>{draft.length.toLocaleString()} / 32,000</span></div>
            </div>
            {busy ? (
              <button className="stop-button" type="button" onClick={() => abortController.current?.abort()}>Stop</button>
            ) : (
              <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message">↑</button>
            )}
          </form>
          <div className="chat-composer-status">
            <span className={busy ? "generating" : "ready"}><i aria-hidden="true" />{busy ? currentActivity ?? "Hermes is working" : "Hermes route ready"}</span>
            <span>{identityMode === "ENTERPRISE" ? "Enterprise session" : "Administrator preview"}</span>
            <span>OrcaSynapse policy · Hermes execution · Supermemory knowledge</span>
          </div>
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
