import type {
  AgentMemoryRecord,
  HermesRuntimeCatalogue,
  AgentRunApproval,
  AgentProfile,
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatStreamEvent,
  DocumentSummary,
} from "@orcasynapse/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  OrcaSynapseApiError,
  attachChatDocument,
  cancelChatRun,
  createChatConversation,
  decideChatApproval,
  deleteChatConversation,
  detachChatDocument,
  forkChatConversation,
  getChatConversation,
  getDocuments,
  getOwnAgentMemory,
  getRuntimeCatalogue,
  forgetOwnAgentMemory,
  getChatConversations,
  getAgentProfiles,
  streamChatEvents,
  submitChatMessage,
  setChatFeedback,
  updateChatConversation,
} from "./api.js";

interface ChatViewProps {
  unlocked: boolean;
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW" | null;
  displayName: string | null;
  administratorReadiness: {
    ready: boolean;
    title: string;
    detail: string;
    target: "Deployment" | "Agents";
  } | null;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onOpenAgents: () => void;
  onOpenPlatform: () => void;
  onSessionExpired: () => void;
}

interface ClientCrypto {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

let fallbackMessageSequence = 0;

/**
 * Only an indexed document can be pinned. Pinning one that has not finished
 * embedding narrows retrieval to a source with no chunks, which surfaces as the
 * agent having no answer rather than as the document not being ready.
 */
export function pinnableDocuments(documents: readonly DocumentSummary[]): DocumentSummary[] {
  return documents.filter((item) => item.status === "READY");
}

/**
 * States which knowledge an answer may draw on. The distinction changes what an
 * answer means, so it is spelled out rather than implied by a count alone.
 */
export function knowledgeScopeSummary(pinnedCount: number): string {
  if (pinnedCount === 0) return "Nothing pinned. Answers may draw on every document you own.";
  return `Answers are restricted to ${pinnedCount} pinned document${pinnedCount === 1 ? "" : "s"}.`;
}

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
    reasoningTokens: null,
    latencyMs: null,
    firstTokenLatencyMs: null,
    finishReason: null,
    errorCode: null,
    agentRunId: null,
    runStatus: null,
    lastEventCursor: null,
    runtimeEvents: [],
    approvals: [],
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

function formatRuntimeDuration(value: number | null): string | null {
  if (value === null) return null;
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function runtimeEventLabel(type: string): string {
  return type.replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());
}

export interface ChatTelemetryMetric {
  key: "throughput" | "input" | "output" | "reasoning" | "total" | "first-token" | "latency" | "finish";
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
    { key: "reasoning", label: "Reasoning", value: formatTokenCount(message.reasoningTokens) },
    { key: "total", label: "Total", value: formatTokenCount(message.totalTokens) },
    { key: "first-token", label: "First token", value: formatLatency(message.firstTokenLatencyMs) },
    { key: "latency", label: "Latency", value: formatLatency(message.latencyMs) },
    {
      key: "finish",
      label: "Finish",
      value: message.finishReason?.replaceAll("_", " ").toLowerCase() ?? "—",
    },
  ];
}

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => defaultUrlTransform(url)}
        components={{
          a: ({ children, ...properties }) => (
            <a {...properties} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          img: ({ alt }) => <span className="blocked-inline-image">[External image blocked{alt ? `: ${alt}` : ""}]</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function ChatView({
  unlocked,
  identityMode,
  displayName,
  administratorReadiness,
  oidcConfigured,
  onSignIn,
  onConfigure,
  onOpenAgents,
  onOpenPlatform,
  onSessionExpired,
}: ChatViewProps) {
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [library, setLibrary] = useState<DocumentSummary[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<HermesRuntimeCatalogue | null>(null);
  const [memories, setMemories] = useState<AgentMemoryRecord[] | null>(null);
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [currentActivity, setCurrentActivity] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const activePending = active?.messages.find(
    ({ role, status, agentRunId }) => role === "ASSISTANT" && status === "PENDING" && agentRunId,
  ) ?? null;
  const working = busy || submitting;

  const handleError = (cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
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

  useEffect(() => {
    if (!unlocked || !active || !activePending?.agentRunId) {
      setBusy(false);
      setStreamStartedAt(null);
      return;
    }
    const conversationId = active.id;
    const messageId = activePending.id;
    const controller = new AbortController();
    abortController.current?.abort();
    abortController.current = controller;
    let cursor = activePending.lastEventCursor;
    setBusy(true);
    setStreamStartedAt(Date.now());
    setCurrentActivity(activePending.runStatus === "WAITING_FOR_APPROVAL" ? "Waiting for approval" : "Connecting to Hermes run");

    const follow = async () => {
      let retry = 0;
      while (!controller.signal.aborted) {
        try {
          await streamChatEvents(
            conversationId,
            messageId,
            cursor,
            (event) => {
              if (event.cursor) cursor = event.cursor;
              applyStreamEvent(event);
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const refreshed = await getChatConversation(conversationId);
          setActive((current) => current?.id === conversationId ? refreshed : current);
          await refreshList();
          return;
        } catch (cause) {
          if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return;
          if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
            onSessionExpired();
            return;
          }
          retry += 1;
          setCurrentActivity(`Connection interrupted · retrying (${retry})`);
          const refreshed = await getChatConversation(conversationId).catch(() => null);
          const pending = refreshed?.messages.find(({ id }) => id === messageId);
          if (refreshed) setActive((current) => current?.id === conversationId ? refreshed : current);
          if (!pending || pending.status !== "PENDING") {
            await refreshList().catch(() => undefined);
            return;
          }
          cursor = pending.lastEventCursor;
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(5_000, 500 * 2 ** Math.min(retry, 4))));
        }
      }
    };
    void follow().finally(() => {
      if (abortController.current === controller) {
        abortController.current = null;
        setBusy(false);
        setStreamStartedAt(null);
        setCurrentActivity(null);
      }
    });
    return () => controller.abort();
  }, [unlocked, active?.id, activePending?.id]);

  const selectConversation = async (id: string) => {
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
    setActive(null);
    setDraft("");
    setError(null);
    setHistoryOpen(false);
    setCurrentActivity(null);
  };

  function applyStreamEvent(event: ChatStreamEvent) {
    if (event.type === "started") setCurrentActivity("Hermes run queued");
    if (event.type === "state") {
      setCurrentActivity(event.status === "WAITING_FOR_APPROVAL"
        ? "Waiting for approval"
        : event.status.replaceAll("_", " ").toLowerCase());
    }
    if (event.type === "activity") {
      setCurrentActivity(event.toolName ?? event.preview ?? event.summary ?? event.activity.replaceAll("_", " ").toLowerCase());
    }
    if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
      setCurrentActivity(null);
    }
    setActive((current) => {
      if (!current || current.id !== event.conversationId) return current;
      if (event.type === "started") {
        if (current.messages.some(({ id }) => id === event.messageId)) {
          return {
            ...current,
            messages: current.messages.map((message) => message.id === event.messageId
              ? { ...message, agentRunId: event.runId, runStatus: message.runStatus ?? "QUEUED", lastEventCursor: event.cursor ?? message.lastEventCursor }
              : message),
          };
        }
        return {
          ...current,
          messages: [
            ...current.messages,
            { ...emptyMessage(current.id, event.messageId, "ASSISTANT", "", "PENDING"), agentRunId: event.runId, runStatus: "QUEUED", lastEventCursor: event.cursor },
          ],
        };
      }
      if (event.type === "state") {
        return {
          ...current,
          messages: current.messages.map((message) => message.id === event.messageId
            ? { ...message, runStatus: event.status, lastEventCursor: event.cursor ?? message.lastEventCursor }
            : message),
        };
      }
      if (event.type === "activity") {
        return {
          ...current,
          messages: current.messages.map((message) => message.id === event.messageId
            ? {
                ...message,
                lastEventCursor: event.cursor ?? message.lastEventCursor,
                runtimeEvents: message.runtimeEvents.some(({ id }) => id === event.eventId)
                  ? message.runtimeEvents
                  : [...message.runtimeEvents, {
                      id: event.eventId,
                      cursor: event.cursor!,
                      type: event.activity,
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
                      costUsd: event.costUsd,
                      occurredAt: event.occurredAt,
                    }],
              }
            : message),
        };
      }
      if (event.type === "approval") {
        return {
          ...current,
          messages: current.messages.map((message) => message.id === event.messageId
            ? {
                ...message,
                runStatus: "WAITING_FOR_APPROVAL",
                lastEventCursor: event.cursor ?? message.lastEventCursor,
                approvals: [
                  ...message.approvals.filter(({ id }) => id !== event.approval.id),
                  event.approval,
                ],
              }
            : message),
        };
      }
      if (event.type === "delta") {
        return {
          ...current,
          messages: current.messages.map((message) =>
            message.id === event.messageId
              ? { ...message, content: message.content + event.delta, lastEventCursor: event.cursor ?? message.lastEventCursor }
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
                runStatus: event.type === "cancelled" ? "CANCELLED" : "FAILED",
                lastEventCursor: event.cursor ?? message.lastEventCursor,
                errorCode: event.type === "failed" ? event.errorCode : "INFERENCE_CANCELLED",
              }
            : message,
        ),
      };
    });
    if (event.type === "failed") setError(event.error);
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || working || !unlocked || active?.status === "ARCHIVED") return;
    if (administratorReadiness?.ready === false) {
      setError(administratorReadiness.detail);
      return;
    }
    if (profiles.length === 0) {
      setError("Create and activate an Agent Profile before starting Chat.");
      return;
    }
    setSubmitting(true);
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
      setCurrentActivity("Hermes run queued");
      const submission = await submitChatMessage(conversation.id, content);
      setActive({
        ...conversation,
        messages: [...conversation.messages, submission.userMessage, submission.assistantMessage],
        lastMessageAt: submission.userMessage.createdAt,
      });
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
      setSubmitting(false);
    }
  };

  const requestStop = async () => {
    if (!active || !busy || currentActivity === "Cancellation requested") return;
    setError(null);
    setCurrentActivity("Cancellation requested");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await cancelChatRun(active.id);
        return;
      } catch (cause) {
        if (cause instanceof OrcaSynapseApiError && cause.status === 409 && attempt < 5) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
          continue;
        }
        handleError(cause, "Unable to stop the Hermes run.");
        setCurrentActivity("Hermes is working");
        return;
      }
    }
  };

  const setArchiveStatus = async (status: "ACTIVE" | "ARCHIVED") => {
    if (!active || working) return;
    setLoading(true);
    setError(null);
    try {
      const updated = await updateChatConversation(active.id, { status });
      const items = await refreshList();
      if (status === "ACTIVE") {
        setActive((current) => current?.id === updated.id ? { ...current, status: "ACTIVE" } : current);
      } else {
        const next = items.find(({ id }) => id !== active.id && statusIsActive(id, items));
        setActive(next ? await getChatConversation(next.id) : null);
      }
    } catch (cause) {
      handleError(cause, `Unable to ${status === "ACTIVE" ? "restore" : "archive"} the conversation.`);
    } finally {
      setLoading(false);
    }
  };

  // What the runtime can actually do, read from Hermes rather than assumed.
  // Discovery only: nothing here enables anything, and the panel says so.
  const openSkills = async () => {
    setSkillsOpen(true);
    setMoreOpen(false);
    if (catalogue) return;
    try {
      setCatalogue(await getRuntimeCatalogue());
    } catch (cause) {
      setSkillsOpen(false);
      setError(cause instanceof Error ? cause.message : "Unable to read the runtime catalogue.");
    }
  };

  // "What does it know about me" has to be answerable by the person it is
  // about, not only by an administrator reading Platform → Memory.
  const openMemory = async () => {
    setMemoryOpen(true);
    setMemories(null);
    try {
      setMemories((await getOwnAgentMemory()).items);
    } catch (cause) {
      setMemoryOpen(false);
      setError(cause instanceof Error ? cause.message : "Unable to load what agents remember about you.");
    }
  };

  const forgetMemory = async (id: string) => {
    try {
      await forgetOwnAgentMemory(id);
      setMemories((current) => current?.filter((item) => item.id !== id) ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete that memory.");
    }
  };

  const openKnowledge = async () => {
    setKnowledgeOpen(true);
    try {
      // Only READY documents can be pinned; anything else would narrow
      // retrieval to a source that has no embedded chunks yet.
      setLibrary(pinnableDocuments((await getDocuments()).items));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load your documents.");
    }
  };

  const togglePinned = async (documentId: string, pinned: boolean) => {
    if (!active) return;
    try {
      setActive(pinned
        ? await detachChatDocument(active.id, documentId)
        : await attachChatDocument(active.id, documentId));
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to change pinned knowledge.");
    }
  };

  const exportConversation = () => {
    if (!active) return;
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      product: "OrcaSynapse",
      conversation: active,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${active.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "orcasynapse-chat"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const saveTitle = async () => {
    if (!active || !titleDraft.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const updated = await updateChatConversation(active.id, { title: titleDraft.trim() });
      setActive((current) => current?.id === updated.id ? { ...current, title: updated.title } : current);
      await refreshList();
      setRenaming(false);
    } catch (cause) {
      handleError(cause, "Unable to rename the conversation.");
    } finally {
      setLoading(false);
    }
  };

  const forkConversation = async (throughMessageId?: string) => {
    if (!active || working || loading) return;
    setLoading(true);
    setError(null);
    try {
      const created = await forkChatConversation(active.id, throughMessageId ? { throughMessageId } : {});
      await refreshList();
      setActive(await getChatConversation(created.id));
    } catch (cause) {
      handleError(cause, "Unable to fork the conversation.");
    } finally {
      setLoading(false);
    }
  };

  const removeConversation = async () => {
    if (!active || working || loading) return;
    setLoading(true);
    setError(null);
    try {
      const removedId = active.id;
      await deleteChatConversation(removedId);
      const items = await refreshList();
      const next = items.find(({ id }) => id !== removedId);
      setActive(next ? await getChatConversation(next.id) : null);
      setConfirmDelete(false);
    } catch (cause) {
      handleError(cause, "Unable to delete the conversation.");
    } finally {
      setLoading(false);
    }
  };

  const decideApproval = async (approval: AgentRunApproval, decision: "ALLOW_ONCE" | "DENY") => {
    if (approvalBusy) return;
    setApprovalBusy(approval.id);
    setError(null);
    try {
      const updated = await decideChatApproval(approval.id, { decision });
      setActive((current) => current ? {
        ...current,
        messages: current.messages.map((message) => ({
          ...message,
          approvals: message.approvals.map((item) => item.id === updated.id ? updated : item),
        })),
      } : current);
      setCurrentActivity(decision === "ALLOW_ONCE" ? "Approval granted once" : "Approval denied");
    } catch (cause) {
      handleError(cause, "Unable to decide the Hermes approval request.");
    } finally {
      setApprovalBusy(null);
    }
  };

  const retryMessage = (messageId: string) => {
    if (!active || working) return;
    const index = active.messages.findIndex(({ id }) => id === messageId);
    const prior = [...active.messages.slice(0, index)].reverse().find(({ role }) => role === "USER");
    if (prior) setDraft(prior.content);
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
  // Summing nulls as zeroes would put back the claim the runtime never made:
  // a conversation nobody measured reads as a conversation that cost nothing.
  const measuredResponses = completedResponses.filter(({ totalTokens }) => totalTokens !== null);
  const conversationTotalTokens = measuredResponses.length === 0
    ? null
    : measuredResponses.reduce((total, message) => total + (message.totalTokens ?? 0), 0);
  const profileAvailable = profiles.length > 0;
  const routeReady = administratorReadiness?.ready !== false && profileAvailable;
  const chatReady = routeReady && active?.status !== "ARCHIVED";
  const normalizedHistoryFilter = historyFilter.trim().toLowerCase();
  const visibleConversations = normalizedHistoryFilter
    ? conversations.filter((conversation) => [conversation.title, conversation.profileName, conversation.lastMessagePreview]
      .some((value) => value?.toLowerCase().includes(normalizedHistoryFilter)))
    : conversations;
  const readinessTitle = !profileAvailable
    ? "Create your first Agent Profile"
    : administratorReadiness?.title ?? "Hermes is ready";
  const readinessDetail = !profileAvailable
    ? "A Profile defines Hermes behavior, model selection, memory access, and governed Skills."
    : administratorReadiness?.detail ?? "The governed Hermes route is ready.";
  const openReadiness = !profileAvailable || administratorReadiness?.target === "Agents"
    ? onOpenAgents
    : onOpenPlatform;

  return (
    <section className="chat-workspace">
      <aside className={historyOpen ? "chat-history open" : "chat-history"}>
        <div className="chat-history-heading">
          <div><p className="page-kicker">Workspace</p><h1>Chat</h1></div>
          <button className="chat-new-button" type="button" onClick={newConversation}>+ New</button>
        </div>
        <label className="chat-history-search">
          <span className="sr-only">Search conversations</span>
          <input type="search" value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)} placeholder="Search conversations" />
        </label>
        <div className="chat-history-list" aria-label="Conversation history">
          {visibleConversations.length === 0 && !loading && (
            <p className="chat-history-empty">{conversations.length === 0 ? "Your conversations will appear here." : "No conversations match this search."}</p>
          )}
          {visibleConversations.map((conversation) => (
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
            <div>
              <dt>Usage</dt>
              <dd title={conversationTotalTokens === null ? "This runtime does not report token usage." : undefined}>
                {conversationTotalTokens === null ? "Not reported" : `${conversationTotalTokens.toLocaleString()} tokens`}
              </dd>
            </div>
          </dl>
        </div>
      </aside>

      <div className="chat-main">
        <header className="chat-topbar">
          <button className="history-toggle" type="button" onClick={() => setHistoryOpen((value) => !value)} aria-label="Toggle conversation history">☰</button>
          <div className="chat-topbar-title">
            {renaming && active ? (
              <form className="chat-title-editor" onSubmit={(event) => { event.preventDefault(); void saveTitle(); }}>
                <input value={titleDraft} maxLength={160} autoFocus onChange={(event) => setTitleDraft(event.target.value)} aria-label="Conversation title" />
                <button type="submit" disabled={!titleDraft.trim()}>Save</button>
                <button type="button" onClick={() => setRenaming(false)}>Cancel</button>
              </form>
            ) : <strong>{active?.title ?? "New conversation"}</strong>}
            <span>{active ? `${active.profileName ?? "Legacy route"} · ${active.messages.length} messages` : "Start a governed Hermes conversation"}</span>
          </div>
          <div className="chat-runtime-summary" aria-label="Conversation runtime summary">
            <span className={working ? "generating" : routeReady ? "ready" : "degraded"}><i aria-hidden="true" />{working ? `${currentActivity ?? "Hermes is working"} · ${(streamElapsedMs / 1_000).toFixed(1)} s` : routeReady ? "Hermes ready" : "Setup required"}</span>
            <span><small>Model</small><strong>{active?.modelAlias ?? "Active default"}</strong></span>
            <span><small>Session usage</small><strong>{conversationTotalTokens === null ? "—" : `${conversationTotalTokens.toLocaleString()} tok`}</strong></span>
          </div>
          {active && !renaming && (
            <div className="chat-conversation-actions">
              <button type="button" disabled={working || loading} onClick={() => void openKnowledge()}>
                Knowledge{active.knowledgeDocuments.length > 0 ? ` · ${active.knowledgeDocuments.length}` : ""}
              </button>
              <button type="button" disabled={working || loading} onClick={() => void openSkills()}>Skills</button>
              <button type="button" aria-haspopup="menu" aria-expanded={moreOpen} disabled={working || loading} onClick={() => setMoreOpen((open) => !open)}>More ⌄</button>
              {moreOpen && (
                <div className="chat-actions-more" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setTitleDraft(active.title); setRenaming(true); }}>Rename</button>
                  <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void openMemory(); }}>What it remembers</button>
                  <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void forkConversation(); }}>Fork</button>
                  <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); exportConversation(); }}>Export</button>
                  <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void setArchiveStatus(active.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED"); }}>{active.status === "ARCHIVED" ? "Restore" : "Archive"}</button>
                  <button className="danger" type="button" role="menuitem" onClick={() => { setMoreOpen(false); setConfirmDelete(true); }}>Delete</button>
                </div>
              )}
            </div>
          )}
        </header>

        {knowledgeOpen && active && (
          <div className="chat-knowledge" role="dialog" aria-labelledby="chat-knowledge-title">
            <header>
              <div>
                <strong id="chat-knowledge-title">Knowledge for this conversation</strong>
                <span>{knowledgeScopeSummary(active.knowledgeDocuments.length)}</span>
              </div>
              <button type="button" aria-label="Close knowledge" onClick={() => setKnowledgeOpen(false)}>×</button>
            </header>
            {library.length === 0 ? (
              <p className="chat-knowledge-empty">No indexed documents yet. Upload one in Knowledge and it becomes pinnable once indexing completes.</p>
            ) : (
              <ul>
                {library.map((item) => {
                  const pinned = active.knowledgeDocuments.some((pin) => pin.id === item.id);
                  return (
                    <li key={item.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={pinned}
                          disabled={working}
                          onChange={() => void togglePinned(item.id, pinned)}
                        />
                        <span>{item.fileName}</span>
                        <small>{item.classification.toLowerCase()}</small>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {skillsOpen && (
          <div className="chat-knowledge" role="dialog" aria-labelledby="chat-skills-title">
            <header>
              <div>
                <strong id="chat-skills-title">What this runtime can do</strong>
                <span>Read from Hermes on the enrolled node. Nothing here is enabled by viewing it.</span>
              </div>
              <button type="button" aria-label="Close skills" onClick={() => setSkillsOpen(false)}>×</button>
            </header>
            {catalogue === null ? (
              <p className="chat-knowledge-empty">Loading…</p>
            ) : (
              <>
                <p className="chat-policy-note">
                  {catalogue.enabledToolsets === 0
                    ? `All ${catalogue.toolsets.length} toolsets are disabled by the managed runtime policy. Agents answer from your documents and this conversation only.`
                    : `${catalogue.enabledToolsets} of ${catalogue.toolsets.length} toolsets are enabled by the managed runtime policy.`}
                </p>
                <div className="chat-skill-group">
                  <strong>Toolsets · {catalogue.toolsets.length}</strong>
                  {catalogue.toolsets.map((toolset) => (
                    <span className={toolset.enabled ? "chat-skill-pill" : "chat-skill-pill off"} key={toolset.name}>
                      <i />{toolset.label ?? toolset.name}
                    </span>
                  ))}
                </div>
                <div className="chat-skill-group">
                  <strong>Skills · {catalogue.skills.length}</strong>
                  {catalogue.skills.map((skill) => (
                    <span className="chat-skill-pill" key={skill.name} title={skill.description ?? ""}>{skill.name}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {memoryOpen && (
          <div className="chat-knowledge" role="dialog" aria-labelledby="chat-memory-title">
            <header>
              <div>
                <strong id="chat-memory-title">What agents remember about you</strong>
                <span>Stored in this installation only. Deleting an item removes it for every agent immediately.</span>
              </div>
              <button type="button" aria-label="Close memory" onClick={() => setMemoryOpen(false)}>×</button>
            </header>
            {memories === null ? (
              <p className="chat-knowledge-empty">Loading…</p>
            ) : memories.length === 0 ? (
              <p className="chat-knowledge-empty">Nothing is stored about you. Agents answer from documents and the current conversation only.</p>
            ) : (
              <ul>
                {memories.map((item) => (
                  <li key={item.id}>
                    <label>
                      <span>{item.content}</span>
                      <small>
                        {item.agentProfileSlug} · {new Date(item.createdAt).toLocaleDateString()}
                        {item.retentionUntil ? ` · expires ${new Date(item.retentionUntil).toLocaleDateString()}` : " · kept until deleted"}
                      </small>
                    </label>
                    <button type="button" onClick={() => void forgetMemory(item.id)}>Forget</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {confirmDelete && active && (
          <div className="chat-confirmation" role="alertdialog" aria-labelledby="delete-conversation-title">
            <div><strong id="delete-conversation-title">Delete this conversation?</strong><span>The transcript and its run telemetry will be removed. Audit evidence remains.</span></div>
            <button type="button" onClick={() => setConfirmDelete(false)}>Keep</button>
            <button className="danger" type="button" onClick={() => void removeConversation()}>Delete permanently</button>
          </div>
        )}

        <div className="chat-messages" aria-live="polite">
          {!active || active.messages.length === 0 ? (
            <div className="chat-welcome">
              <div className="chat-welcome-mark">H</div>
              <p className="page-kicker">Hermes through OrcaSynapse</p>
              <h2>How can I help?</h2>
              <p>Every response is a governed Hermes Agent Run. Your selected profile controls behavior, skills, memory access, and tool policy.</p>
              {!routeReady && <div className="chat-readiness-callout" role="status">
                <div><strong>{readinessTitle}</strong><span>{readinessDetail}</span></div>
                <button className="primary-button" type="button" onClick={openReadiness}>{!profileAvailable ? "Create Agent Profile" : "Review setup"}</button>
              </div>}
              <label className="chat-profile-picker">
                <span>Agent Profile</span>
                <select disabled={!profileAvailable} value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
                  {profiles.length === 0 && <option value="">No active profiles</option>}
                  {profiles.map((profile) => (
                    <option value={profile.id} key={profile.id}>{profile.activeVersionConfiguration?.displayName ?? profile.version.displayName}</option>
                  ))}
                </select>
                <small>{profiles.length === 0 ? "Activate a profile in Agents before chatting." : "This profile remains bound to the conversation."}</small>
              </label>
              <div className="chat-suggestions">
                <button type="button" disabled={!routeReady} onClick={() => setDraft("Summarize the main considerations for an on-premise AI deployment.")}>Outline an on-premise AI deployment</button>
                <button type="button" disabled={!routeReady} onClick={() => setDraft("Create a concise risk checklist for deploying an internal AI assistant.")}>Create an AI risk checklist</button>
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
                  {message.role === "USER"
                    ? <p>{message.content}</p>
                    : <MarkdownMessage content={message.content || (message.status === "PENDING" ? "Thinking…" : "No content returned.")} />}
                  {message.role === "ASSISTANT" && message.status === "PENDING" && (
                    <div className="message-stream-status" aria-label="Live generation status">
                      <span><i aria-hidden="true" />{currentActivity ?? "Hermes is working"}</span>
                      <small>{busy ? `${(streamElapsedMs / 1_000).toFixed(1)} s elapsed` : "Awaiting recovery"} · governed run details appear as Hermes reports them</small>
                    </div>
                  )}
                  {message.role === "ASSISTANT" && message.runtimeEvents.length > 0 && (
                    <section className="agent-activity" aria-label="Hermes agent activity">
                      <header><strong>Agent activity</strong><span>{message.runtimeEvents.length} event{message.runtimeEvents.length === 1 ? "" : "s"}</span></header>
                      <ol>{message.runtimeEvents.map((runtimeEvent) => {
                        const kind = runtimeEvent.type.startsWith("TOOL_") ? "tool"
                          : runtimeEvent.type.startsWith("SUBAGENT_") ? "subagent"
                            : runtimeEvent.type === "APPROVAL_REQUIRED" ? "approval" : "lifecycle";
                        return (
                          <li className={kind} key={runtimeEvent.id}>
                            <span className="agent-activity-icon" aria-hidden="true">{kind === "tool" ? "TL" : kind === "subagent" ? "SA" : kind === "approval" ? "!" : "AI"}</span>
                            <div>
                              <div><strong>{runtimeEvent.toolName ?? (kind === "subagent" ? "Hermes subagent" : runtimeEventLabel(runtimeEvent.type))}</strong><span>{runtimeEvent.status ?? runtimeEventLabel(runtimeEvent.type)}</span></div>
                              {(runtimeEvent.preview || runtimeEvent.summary) && <p>{runtimeEvent.preview ?? runtimeEvent.summary}</p>}
                              <small>{[
                                formatRuntimeDuration(runtimeEvent.durationMs),
                                runtimeEvent.inputTokens === null ? null : `${runtimeEvent.inputTokens.toLocaleString()} in`,
                                runtimeEvent.outputTokens === null ? null : `${runtimeEvent.outputTokens.toLocaleString()} out`,
                                runtimeEvent.reasoningTokens === null ? null : `${runtimeEvent.reasoningTokens.toLocaleString()} reasoning`,
                                runtimeEvent.costUsd === null ? null : `$${runtimeEvent.costUsd.toFixed(4)}`,
                              ].filter(Boolean).join(" · ") || new Date(runtimeEvent.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>
                            </div>
                          </li>
                        );
                      })}</ol>
                    </section>
                  )}
                  {message.role === "ASSISTANT" && message.approvals.map((approval) => (
                    <section className={`chat-approval ${approval.status.toLowerCase()}`} key={approval.id} aria-label="Hermes approval request">
                      <div className="chat-approval-mark" aria-hidden="true">!</div>
                      <div>
                        <span>Human approval</span>
                        <strong>{approval.summary ?? "Hermes needs permission to continue"}</strong>
                        {approval.command && <code>{approval.command}</code>}
                        <small>{approval.status === "PENDING" ? `Expires ${new Date(approval.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : `Decision: ${(approval.decision ?? approval.status).replaceAll("_", " ").toLowerCase()}`}</small>
                      </div>
                      {approval.status === "PENDING" && (
                        <div className="chat-approval-actions">
                          <button type="button" disabled={approvalBusy === approval.id} onClick={() => void decideApproval(approval, "DENY")}>Deny</button>
                          <button className="primary-button" type="button" disabled={approvalBusy === approval.id} onClick={() => void decideApproval(approval, "ALLOW_ONCE")}>Allow once</button>
                        </div>
                      )}
                    </section>
                  ))}
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
                        <div className="message-response-actions" aria-label="Response actions">
                          <button type="button" onClick={() => void navigator.clipboard?.writeText(message.content)}>Copy</button>
                          <button type="button" disabled={working} onClick={() => void forkConversation(message.id)}>Fork here</button>
                        </div>
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
                    <div className="message-failure-row">
                      <small className="message-failure">{message.status === "CANCELLED" ? "Generation cancelled" : `Generation failed · ${message.errorCode ?? "UNKNOWN"}`}</small>
                      <button type="button" disabled={working} onClick={() => retryMessage(message.id)}>Retry prompt</button>
                    </div>
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
                placeholder={active?.status === "ARCHIVED" ? "Restore this conversation to continue" : chatReady ? "Message your selected Hermes agent" : "Finish the required setup to start Chat"}
                rows={1}
                maxLength={32_000}
                disabled={working || !chatReady}
                aria-label="Chat message"
              />
              <div><span>Enter to send · Shift + Enter for a new line</span><span>{draft.length.toLocaleString()} / 32,000</span></div>
            </div>
            {busy ? (
              <button className="stop-button" type="button" disabled={currentActivity === "Cancellation requested"} onClick={() => void requestStop()}>{currentActivity === "Cancellation requested" ? "Stopping…" : "Stop"}</button>
            ) : (
              <button className="send-button" type="submit" disabled={!draft.trim() || !chatReady} aria-label="Send message">↑</button>
            )}
          </form>
          <div className="chat-composer-status">
            <span className={working ? "generating" : routeReady ? "ready" : "degraded"}><i aria-hidden="true" />{working ? currentActivity ?? "Hermes is working" : routeReady ? "Hermes route ready" : readinessTitle}</span>
            <span>{identityMode === "ENTERPRISE" ? "Enterprise session" : "Administrator preview"}</span>
            <span>OrcaSynapse policy · Hermes execution · private knowledge</span>
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
