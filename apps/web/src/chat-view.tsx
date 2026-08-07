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
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  LockedScreen,
  MicroLabel,
  Panel,
  Select,
  StatusText,
  cn,
} from "./ui/index.js";

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

function MarkdownMessage({ content }: { content: string }) {
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
  const moreMenu = useRef<HTMLDivElement>(null);

  /*
   * The conversation menu had neither of the two ways out every menu needs:
   * Escape, and clicking away from it. Archive and Delete live in here, so a
   * menu that stays open over the transcript is a menu waiting to be clicked
   * by accident.
   */
  useEffect(() => {
    if (!moreOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!moreMenu.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);
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
    /*
     * Chat is the one governed area an employee reaches without an
     * administrator session, so its locked screen carries a second action:
     * the person who cannot sign in is usually not the person who can fix it.
     * `LockedScreen` supplies the shared explanation; the sign-in path is the
     * part that is genuinely local to Chat.
     */
    return (
      /*
       * Its own padding, because `main` has none here: the shell zeroes it for
       * Chat so the workspace can fill the viewport edge to edge. The locked
       * screen is not the workspace, and inherited zero left it flush against
       * the sidebar.
       */
      <div className="px-[clamp(24px,4vw,64px)] pb-16 pt-9">
        <LockedScreen
          title="Chat"
          kicker="Workspace"
          mark="AI"
          headline={oidcConfigured ? "Sign in to OrcaSynapse" : "Enterprise access is not configured"}
          reason={
            oidcConfigured
              ? "Use your approved OrcaSynapse identity. OrcaSynapse checks the configured group allowlist before creating a local session."
              : "An administrator must configure and successfully test the enterprise OIDC connection before employees can enter Chat."
          }
          actionLabel={oidcConfigured ? "Sign in with OrcaSynapse" : "Administrator setup"}
          onAction={oidcConfigured ? onSignIn : onConfigure}
          {...(oidcConfigured ? { secondaryLabel: "Administrator setup", onSecondary: onConfigure } : {})}
        />
      </div>
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
    /*
     * `m-0 w-full max-w-none` is not decoration: `main > *` centres every view
     * in a 1380px column, and Chat is the one screen that must fill the shell.
     * A utility class outranks that element selector, which is what lets the
     * layout be stated here rather than in a stylesheet rule keyed to a class
     * name.
     */
    <section className="m-0 grid h-full w-full max-w-none grid-cols-1 bg-bg lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside
        className={cn(
          "min-w-0 flex-col border-r border-border bg-surface px-3.5 pb-4 pt-5",
          historyOpen ? "flex" : "hidden lg:flex",
        )}
      >
        <div className="mb-4 flex items-center justify-between gap-3 px-1">
          <div>
            <MicroLabel className="mb-1 block">Workspace</MicroLabel>
            <h1 className="m-0 text-[19px] font-semibold tracking-[-0.02em] text-text">Chat</h1>
          </div>
          <Button size="sm" onClick={newConversation}>
            + New
          </Button>
        </div>
        <label className="mb-3 block px-1">
          <span className="sr-only">Search conversations</span>
          <Input
            type="search"
            value={historyFilter}
            onChange={(event) => setHistoryFilter(event.target.value)}
            placeholder="Search conversations"
          />
        </label>
        <div className="grid min-h-0 content-start gap-1 overflow-y-auto" aria-label="Conversation history">
          {visibleConversations.length === 0 && !loading && (
            <p className="px-3 py-7 text-center text-body text-faint">
              {conversations.length === 0 ? "Your conversations will appear here." : "No conversations match this search."}
            </p>
          )}
          {visibleConversations.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              aria-current={active?.id === conversation.id ? "true" : undefined}
              className={cn(
                "relative grid w-full gap-1 rounded border py-2.5 pl-3 pr-11 text-left transition-colors",
                active?.id === conversation.id
                  ? "border-border-strong bg-raised"
                  : "border-transparent hover:bg-raised",
              )}
              onClick={() => void selectConversation(conversation.id)}
            >
              <strong className="truncate text-[11px] font-semibold text-text">{conversation.title}</strong>
              <span className="truncate text-caption text-muted">
                {conversation.lastMessagePreview ?? conversation.profileName ?? conversation.modelAlias}
              </span>
              <small className="absolute right-2.5 top-3 font-mono text-[8px] text-faint">
                {conversation.status === "ARCHIVED" ? "Archived" : formatConversationTime(conversation.lastMessageAt)}
              </small>
            </button>
          ))}
        </div>
        <Panel className="mt-auto grid gap-3 p-3">
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-good" />
            <div className="min-w-0">
              <MicroLabel className="block text-accent">Identity mode</MicroLabel>
              <strong className="mt-1 block truncate text-[11px] font-semibold text-text">
                {identityMode === "ENTERPRISE" ? "Enterprise Access" : "Administrator preview"}
              </strong>
              <small className="mt-0.5 block truncate text-caption text-faint">
                {displayName ?? "Active OrcaSynapse session"}
              </small>
            </div>
          </div>
          <dl className="m-0 grid grid-cols-2 gap-2">
            <div className="min-w-0 rounded border border-border bg-bg p-2">
              <dt className="font-mono text-micro uppercase text-faint">Agent</dt>
              <dd className="m-0 mt-1 truncate font-mono text-caption text-muted">{active?.profileName ?? "Choose below"}</dd>
            </div>
            <div className="min-w-0 rounded border border-border bg-bg p-2">
              <dt className="font-mono text-micro uppercase text-faint">Usage</dt>
              <dd
                className="m-0 mt-1 truncate font-mono text-caption text-muted"
                title={conversationTotalTokens === null ? "This runtime does not report token usage." : undefined}
              >
                {conversationTotalTokens === null ? "Not reported" : `${conversationTotalTokens.toLocaleString()} tokens`}
              </dd>
            </div>
          </dl>
        </Panel>
      </aside>

      <div className="relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <header className="flex min-h-[68px] items-center gap-4 border-b border-border bg-surface px-5 py-2.5">
          <Button
            size="sm"
            className="lg:hidden"
            onClick={() => setHistoryOpen((value) => !value)}
            aria-label="Toggle conversation history"
          >
            ☰
          </Button>
          <div className="min-w-[150px] flex-1">
            {renaming && active ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveTitle();
                }}
              >
                <Input
                  value={titleDraft}
                  maxLength={160}
                  autoFocus
                  className="w-[min(36vw,420px)] min-w-[180px]"
                  onChange={(event) => setTitleDraft(event.target.value)}
                  aria-label="Conversation title"
                />
                <Button size="sm" type="submit" disabled={!titleDraft.trim()}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <strong className="block truncate text-[12px] font-semibold text-text">
                {active?.title ?? "New conversation"}
              </strong>
            )}
            <span className="mt-1 block truncate text-caption text-faint">
              {active
                ? `${active.profileName ?? "Legacy route"} · ${active.messages.length} messages`
                : "Start a governed Hermes conversation"}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-4" aria-label="Conversation runtime summary">
            <StatusText dot tone={working ? "accent" : routeReady ? "good" : "warn"} className="whitespace-nowrap">
              {working
                ? `${currentActivity ?? "Hermes is working"} · ${(streamElapsedMs / 1_000).toFixed(1)} s`
                : routeReady
                  ? "Hermes ready"
                  : "Setup required"}
            </StatusText>
            <span className="hidden min-w-0 md:block">
              <MicroLabel className="block">Model</MicroLabel>
              <strong className="mt-0.5 block max-w-[150px] truncate font-mono text-caption font-medium text-muted">
                {active?.modelAlias ?? "Active default"}
              </strong>
            </span>
            <span className="hidden min-w-0 lg:block">
              <MicroLabel className="block">Session usage</MicroLabel>
              <strong className="mt-0.5 block truncate font-mono text-caption font-medium tabular-nums text-muted">
                {conversationTotalTokens === null ? "—" : `${conversationTotalTokens.toLocaleString()} tok`}
              </strong>
            </span>
          </div>
          {active && !renaming && (
            <div className="relative flex items-center gap-1.5" ref={moreMenu}>
              <Button size="sm" disabled={working || loading} onClick={() => void openKnowledge()}>
                Knowledge{active.knowledgeDocuments.length > 0 ? ` · ${active.knowledgeDocuments.length}` : ""}
              </Button>
              <Button size="sm" disabled={working || loading} onClick={() => void openSkills()}>
                Skills
              </Button>
              <Button
                size="sm"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                disabled={working || loading}
                onClick={() => setMoreOpen((open) => !open)}
              >
                More ⌄
              </Button>
              {moreOpen && (
                <div
                  className="absolute right-0 top-[calc(100%+6px)] z-40 grid min-w-[176px] gap-0.5 rounded border border-border-strong bg-raised p-1.5 shadow-overlay"
                  role="menu"
                >
                  {[
                    { label: "Rename", run: () => { setTitleDraft(active.title); setRenaming(true); } },
                    { label: "What it remembers", run: () => void openMemory() },
                    { label: "Fork", run: () => void forkConversation() },
                    { label: "Export", run: () => exportConversation() },
                    {
                      label: active.status === "ARCHIVED" ? "Restore" : "Archive",
                      run: () => void setArchiveStatus(active.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED"),
                    },
                  ].map((item) => (
                    <Button
                      key={item.label}
                      variant="ghost"
                      size="sm"
                      role="menuitem"
                      className="justify-start"
                      onClick={() => {
                        setMoreOpen(false);
                        item.run();
                      }}
                    >
                      {item.label}
                    </Button>
                  ))}
                  <Button
                    variant="danger"
                    size="sm"
                    role="menuitem"
                    className="justify-start"
                    onClick={() => {
                      setMoreOpen(false);
                      setConfirmDelete(true);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          )}
        </header>

        {/*
          * All four of these were bare divs carrying role="dialog" and nothing
          * else — no aria-modal, no focus trap, no Escape, no scroll lock, no
          * focus restore. A keyboard user could tab straight out of the memory
          * panel into the transcript behind it while a screen reader kept
          * announcing the page as if no dialog were open. `Dialog` supplies all
          * of it once.
          */}
        <Dialog
          open={knowledgeOpen && active !== null}
          onClose={() => setKnowledgeOpen(false)}
          kicker="Conversation scope"
          title="Knowledge for this conversation"
          description={active ? knowledgeScopeSummary(active.knowledgeDocuments.length) : undefined}
        >
          {library.length === 0 ? (
            <EmptyState title="No indexed documents yet">
              Upload one in Knowledge and it becomes pinnable once indexing completes.
            </EmptyState>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0">
              {library.map((item) => {
                const pinned = active?.knowledgeDocuments.some((pin) => pin.id === item.id) ?? false;
                return (
                  <li key={item.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded border border-border bg-raised px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={pinned}
                        disabled={working}
                        onChange={() => void togglePinned(item.id, pinned)}
                      />
                      <span className="min-w-0 flex-1 truncate text-body text-text">{item.fileName}</span>
                      <small className="shrink-0 font-mono text-micro uppercase text-faint">
                        {item.classification.toLowerCase()}
                      </small>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Dialog>

        <Dialog
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          kicker="Runtime capability"
          title="What this runtime can do"
          description="Read from Hermes on the enrolled node. Nothing here is enabled by viewing it."
        >
          {catalogue === null ? (
            <p className="m-0 text-body text-faint">Loading…</p>
          ) : (
            <div className="grid gap-4">
              <StatusText tone={catalogue.enabledToolsets === 0 ? "warn" : "good"} className="normal-case">
                {catalogue.enabledToolsets === 0
                  ? `All ${catalogue.toolsets.length} toolsets are disabled by the managed runtime policy. Agents answer from your documents and this conversation only.`
                  : `${catalogue.enabledToolsets} of ${catalogue.toolsets.length} toolsets are enabled by the managed runtime policy.`}
              </StatusText>
              <div className="grid gap-2">
                <MicroLabel>Toolsets · {catalogue.toolsets.length}</MicroLabel>
                <div className="flex flex-wrap gap-1.5">
                  {catalogue.toolsets.map((toolset) => (
                    <StatusText
                      dot
                      key={toolset.name}
                      tone={toolset.enabled ? "good" : "neutral"}
                      className="rounded border border-border bg-raised px-2 py-1 normal-case"
                    >
                      {toolset.label ?? toolset.name}
                    </StatusText>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <MicroLabel>Skills · {catalogue.skills.length}</MicroLabel>
                <div className="flex flex-wrap gap-1.5">
                  {catalogue.skills.map((skill) => (
                    <span
                      className="rounded border border-border bg-raised px-2 py-1 font-mono text-caption text-muted"
                      key={skill.name}
                      title={skill.description ?? ""}
                    >
                      {skill.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Dialog>

        <Dialog
          open={memoryOpen}
          onClose={() => setMemoryOpen(false)}
          kicker="Your data"
          title="What agents remember about you"
          description="Stored in this installation only. Deleting an item removes it for every agent immediately."
        >
          {memories === null ? (
            <p className="m-0 text-body text-faint">Loading…</p>
          ) : memories.length === 0 ? (
            <EmptyState title="Nothing is stored about you">
              Agents answer from documents and the current conversation only.
            </EmptyState>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0">
              {memories.map((item) => (
                <li
                  className="flex items-start gap-3 rounded border border-border bg-raised px-3 py-2.5"
                  key={item.id}
                >
                  <div className="min-w-0 flex-1">
                    <span className="block text-body text-text">{item.content}</span>
                    <small className="mt-1 block font-mono text-micro uppercase text-faint">
                      {item.agentProfileSlug} · {new Date(item.createdAt).toLocaleDateString()}
                      {item.retentionUntil
                        ? ` · expires ${new Date(item.retentionUntil).toLocaleDateString()}`
                        : " · kept until deleted"}
                    </small>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void forgetMemory(item.id)}>
                    Forget
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Dialog>

        <Dialog
          open={confirmDelete && active !== null}
          onClose={() => setConfirmDelete(false)}
          title="Delete this conversation?"
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
              <Button variant="danger" onClick={() => void removeConversation()}>
                Delete permanently
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-muted">
            The transcript and its run telemetry will be removed. Audit evidence remains.
          </p>
        </Dialog>

        <div className="chat-messages" aria-live="polite">
          {!active || active.messages.length === 0 ? (
            <div className="mx-auto max-w-[720px] pt-[min(12vh,110px)] text-center">
              <div
                aria-hidden="true"
                className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded border border-border-strong bg-raised font-mono text-[14px] font-bold text-accent"
              >
                H
              </div>
              <MicroLabel className="mb-2 block">Hermes through OrcaSynapse</MicroLabel>
              <h2 className="m-0 text-[28px] font-semibold tracking-[-0.03em] text-text">How can I help?</h2>
              <p className="mx-auto mb-6 mt-3 max-w-[580px] text-[12px] leading-relaxed text-muted">
                Every response is a governed Hermes Agent Run. Your selected profile controls behavior, skills, memory
                access, and tool policy.
              </p>
              {!routeReady && (
                <Panel
                  className="mx-auto mb-3 flex max-w-[560px] items-center justify-between gap-4 border-l-2 border-l-warn p-3.5 text-left"
                  role="status"
                >
                  <div className="min-w-0">
                    <strong className="block text-[12px] font-semibold text-text">{readinessTitle}</strong>
                    <span className="mt-1 block text-body text-muted">{readinessDetail}</span>
                  </div>
                  <Button variant="primary" className="shrink-0" onClick={openReadiness}>
                    {!profileAvailable ? "Create Agent Profile" : "Review setup"}
                  </Button>
                </Panel>
              )}
              <Panel className="mx-auto mb-3 max-w-[440px] p-3 text-left">
                <Field
                  label="Agent Profile"
                  hint={
                    profiles.length === 0
                      ? "Activate a profile in Agents before chatting."
                      : "This profile remains bound to the conversation."
                  }
                >
                  <Select
                    disabled={!profileAvailable}
                    value={selectedProfileId}
                    onChange={(event) => setSelectedProfileId(event.target.value)}
                  >
                    {profiles.length === 0 && <option value="">No active profiles</option>}
                    {profiles.map((profile) => (
                      <option value={profile.id} key={profile.id}>
                        {profile.activeVersionConfiguration?.displayName ?? profile.version.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>
              </Panel>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  {
                    label: "Outline an on-premise AI deployment",
                    prompt: "Summarize the main considerations for an on-premise AI deployment.",
                  },
                  {
                    label: "Create an AI risk checklist",
                    prompt: "Create a concise risk checklist for deploying an internal AI assistant.",
                  },
                ].map((suggestion) => (
                  <button
                    className="rounded border border-border bg-surface px-4 py-3.5 text-left text-body leading-relaxed text-muted transition-colors hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    key={suggestion.label}
                    type="button"
                    disabled={!routeReady}
                    onClick={() => setDraft(suggestion.prompt)}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            active.messages.map((message) => (
              /*
               * The person's turn is a bounded card and the agent's is not.
               * That asymmetry is the only thing that lets the eye find where
               * an exchange begins without reading any of the text, which on a
               * long governed transcript is most of what makes it navigable.
               */
              <article
                className={cn(
                  "mx-auto grid max-w-[940px] grid-cols-[34px_minmax(0,1fr)] gap-3.5",
                  message.role === "USER"
                    ? "my-3.5 rounded border border-border bg-surface p-4"
                    : "border-b border-border py-5 last-of-type:border-b-0",
                )}
                key={message.id}
              >
                <div
                  aria-hidden="true"
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded border font-mono text-micro font-bold",
                    message.role === "USER"
                      ? "border-border-strong bg-raised text-muted"
                      : "border-accent/50 bg-accent/10 text-accent",
                  )}
                >
                  {message.role === "USER" ? "You" : "H"}
                </div>
                <div className="min-w-0">
                  <div className="flex min-h-[24px] items-center justify-between gap-3">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <strong className="text-[11px] font-semibold text-text">
                        {message.role === "USER" ? "You" : (active.profileName ?? "Hermes")}
                      </strong>
                      <time className="font-mono text-micro text-faint" dateTime={message.createdAt}>
                        {formatMessageTime(message.createdAt)}
                      </time>
                    </div>
                    <div className="flex min-w-0 items-center justify-end gap-2">
                      {message.role === "ASSISTANT" && (
                        <span className="max-w-[220px] truncate font-mono text-micro text-faint">
                          {message.modelAlias ?? active.modelAlias}
                        </span>
                      )}
                      {message.status !== "COMPLETED" && (
                        <StatusText
                          tone={message.status === "FAILED" || message.status === "CANCELLED" ? "bad" : "warn"}
                        >
                          {message.status.toLowerCase()}
                        </StatusText>
                      )}
                    </div>
                  </div>
                  {message.role === "USER"
                    ? <p className="my-1.5 whitespace-pre-wrap break-words text-[12px] leading-[1.78] text-muted">{message.content}</p>
                    : <MarkdownMessage content={message.content || (message.status === "PENDING" ? "Thinking…" : "No content returned.")} />}
                  {message.role === "ASSISTANT" && message.status === "PENDING" && (
                    <div
                      className="my-2.5 flex items-center justify-between gap-3 rounded border border-border-strong bg-raised px-3 py-2"
                      aria-label="Live generation status"
                    >
                      <StatusText dot tone="accent" className="whitespace-nowrap">
                        {currentActivity ?? "Hermes is working"}
                      </StatusText>
                      <small className="truncate text-right text-micro text-faint">
                        {busy ? `${(streamElapsedMs / 1_000).toFixed(1)} s elapsed` : "Awaiting recovery"} · governed run details appear as Hermes reports them
                      </small>
                    </div>
                  )}
                  {message.role === "ASSISTANT" && message.runtimeEvents.length > 0 && (
                    <section
                      className="my-3 overflow-hidden rounded border border-border bg-surface"
                      aria-label="Hermes agent activity"
                    >
                      <header className="flex items-center justify-between border-b border-border bg-raised px-3 py-2">
                        <MicroLabel>Agent activity</MicroLabel>
                        <span className="font-mono text-micro text-faint">
                          {message.runtimeEvents.length} event{message.runtimeEvents.length === 1 ? "" : "s"}
                        </span>
                      </header>
                      <ol className="m-0 grid list-none p-0">{message.runtimeEvents.map((runtimeEvent) => {
                        const kind = runtimeEvent.type.startsWith("TOOL_") ? "tool"
                          : runtimeEvent.type.startsWith("SUBAGENT_") ? "subagent"
                            : runtimeEvent.type === "APPROVAL_REQUIRED" ? "approval" : "lifecycle";
                        return (
                          <li
                            className="grid min-w-0 grid-cols-[26px_minmax(0,1fr)] gap-2.5 border-t border-border px-3 py-2.5 first:border-t-0"
                            key={runtimeEvent.id}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                "grid h-[25px] w-[25px] place-items-center rounded border font-mono text-micro font-bold",
                                kind === "tool" ? "border-good/50 bg-good/10 text-good"
                                  : kind === "approval" ? "border-warn/50 bg-warn/10 text-warn"
                                    : "border-border-strong bg-raised text-muted",
                              )}
                            >
                              {kind === "tool" ? "TL" : kind === "subagent" ? "SA" : kind === "approval" ? "!" : "AI"}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center justify-between gap-2.5">
                                <strong className="min-w-0 truncate text-caption font-semibold text-text">
                                  {runtimeEvent.toolName ?? (kind === "subagent" ? "Hermes subagent" : runtimeEventLabel(runtimeEvent.type))}
                                </strong>
                                <StatusText className="shrink-0">
                                  {runtimeEvent.status ?? runtimeEventLabel(runtimeEvent.type)}
                                </StatusText>
                              </div>
                              {(runtimeEvent.preview || runtimeEvent.summary) && (
                                <p className="my-1 text-micro leading-relaxed text-muted">
                                  {runtimeEvent.preview ?? runtimeEvent.summary}
                                </p>
                              )}
                              <small className="block font-mono text-micro text-faint">{[
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
                    /*
                     * The one block on the transcript that is warn-toned on
                     * purpose: it is a decision the run is blocked on, not a
                     * report of something already done.
                     */
                    <section
                      className={cn(
                        "my-3 grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 rounded border p-3",
                        approval.status === "PENDING" ? "border-warn/50 bg-warn/10"
                          : approval.status === "APPROVED" ? "border-good/50 bg-good/10"
                            : "border-bad/50 bg-bad/10",
                      )}
                      key={approval.id}
                      aria-label="Hermes approval request"
                    >
                      <div
                        aria-hidden="true"
                        className="grid h-7 w-7 place-items-center rounded border border-warn/50 bg-warn/10 font-mono text-[12px] font-bold text-warn"
                      >
                        !
                      </div>
                      <div className="grid min-w-0 gap-1">
                        <MicroLabel className="text-warn">Human approval</MicroLabel>
                        <strong className="text-caption font-semibold text-text">
                          {approval.summary ?? "Hermes needs permission to continue"}
                        </strong>
                        {approval.command && (
                          <code className="truncate rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-micro text-muted">
                            {approval.command}
                          </code>
                        )}
                        <small className="text-micro text-faint">
                          {approval.status === "PENDING"
                            ? `Expires ${new Date(approval.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                            : `Decision: ${(approval.decision ?? approval.status).replaceAll("_", " ").toLowerCase()}`}
                        </small>
                      </div>
                      {approval.status === "PENDING" && (
                        <div className="flex gap-1.5">
                          <Button size="sm" disabled={approvalBusy === approval.id} onClick={() => void decideApproval(approval, "DENY")}>
                            Deny
                          </Button>
                          <Button variant="primary" size="sm" disabled={approvalBusy === approval.id} onClick={() => void decideApproval(approval, "ALLOW_ONCE")}>
                            Allow once
                          </Button>
                        </div>
                      )}
                    </section>
                  ))}
                  {message.sources.length > 0 && (
                    <div className="my-2.5 grid gap-2 rounded border border-border bg-surface p-3" aria-label="Enterprise knowledge sources">
                      <MicroLabel>Sources</MicroLabel>
                      <div className="flex flex-wrap gap-1.5">{message.sources.map((source) => (
                        <article className="grid min-w-[170px] gap-1 rounded border border-border bg-raised px-2.5 py-2" key={source.documentId}>
                          <span className="truncate text-caption font-semibold text-text">{source.fileName}</span>
                          <small className="font-mono text-micro uppercase text-faint">
                            {source.classification.toLowerCase()} · {Math.round(source.score * 100)}% match
                          </small>
                        </article>
                      ))}</div>
                    </div>
                  )}
                  {message.role === "ASSISTANT" && message.status === "COMPLETED" && (
                    <>
                      <section className="mt-3.5 overflow-hidden rounded border border-border bg-surface" aria-label="Response performance">
                        <header className="flex items-center justify-between gap-3.5 border-b border-border bg-raised px-3 py-2.5">
                          <div>
                            <MicroLabel className="block">Response telemetry</MicroLabel>
                            <small className="mt-1 block text-micro text-faint">
                              Reported by Hermes lifecycle events and measured by OrcaSynapse
                            </small>
                          </div>
                          {message.sources.length > 0 && (
                            <StatusText className="shrink-0">
                              {message.sources.length} knowledge source{message.sources.length === 1 ? "" : "s"}
                            </StatusText>
                          )}
                        </header>
                        {/*
                          * Hairlines come from the gap showing the container
                          * behind, so no cell carries a border of its own and
                          * none of them double against the panel edge — which
                          * is what the four nth-child rules the old stylesheet
                          * needed were working around.
                          *
                          * Tabular figures and a fixed grid: a column of numbers
                          * that re-aligns as a run streams is unreadable.
                          */}
                        <dl className="m-0 grid grid-cols-2 gap-px bg-border sm:grid-cols-[1.25fr_repeat(3,minmax(72px,1fr))]">
                          {chatMessageTelemetry(message).map((metric) => (
                            <div
                              className={cn(
                                "min-w-0 px-3 py-2.5",
                                metric.key === "throughput" ? "bg-raised" : "bg-surface",
                              )}
                              key={metric.key}
                            >
                              <dt className="truncate font-mono text-micro uppercase text-faint">{metric.label}</dt>
                              <dd
                                className={cn(
                                  "m-0 mt-1 truncate font-mono text-caption font-semibold tabular-nums",
                                  metric.key === "throughput" ? "text-[11px] text-accent" : "text-muted",
                                )}
                              >
                                {metric.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                        <small className="text-micro leading-relaxed text-faint">
                          Effective speed is output tokens divided by end-to-end response latency.
                        </small>
                        <div className="flex items-center gap-1.5" aria-label="Response actions">
                          <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText(message.content)}>
                            Copy
                          </Button>
                          <Button variant="ghost" size="sm" disabled={working} onClick={() => void forkConversation(message.id)}>
                            Fork here
                          </Button>
                        </div>
                        <div className="flex items-center gap-1.5" aria-label="Response feedback">
                          <Button
                            size="sm"
                            aria-label="Mark response helpful"
                            aria-pressed={message.feedback?.rating === "HELPFUL"}
                            disabled={feedbackBusy === message.id}
                            className={cn(message.feedback?.rating === "HELPFUL" ? "border-accent text-accent" : null)}
                            onClick={() => void recordFeedback(message.id, "HELPFUL")}
                          >
                            Helpful
                          </Button>
                          <Button
                            size="sm"
                            aria-label="Mark response not helpful"
                            aria-pressed={message.feedback?.rating === "NOT_HELPFUL"}
                            disabled={feedbackBusy === message.id}
                            className={cn(message.feedback?.rating === "NOT_HELPFUL" ? "border-accent text-accent" : null)}
                            onClick={() => void recordFeedback(message.id, "NOT_HELPFUL")}
                          >
                            Not helpful
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                  {(message.status === "FAILED" || message.status === "CANCELLED") && (
                    <div className="mt-2 flex items-center justify-between gap-2.5">
                      <StatusText tone="bad">
                        {message.status === "CANCELLED" ? "Generation cancelled" : `Generation failed · ${message.errorCode ?? "UNKNOWN"}`}
                      </StatusText>
                      <Button variant="ghost" size="sm" disabled={working} onClick={() => retryMessage(message.id)}>
                        Retry prompt
                      </Button>
                    </div>
                  )}
                </div>
              </article>
            ))
          )}
          <div ref={messageEnd}/>
        </div>

        {/* Same horizontal padding and reserved scrollbar gutter as the
            transcript above, or the composer and the messages disagree on where
            the column ends. */}
        <div className="border-t border-border bg-surface px-[clamp(22px,6vw,84px)] pb-3.5 pt-2.5 [scrollbar-gutter:stable]">
          {error && (
            <Alert className="mx-auto mb-2 max-w-[940px]" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}
          <form
            className="mx-auto grid max-w-[940px] grid-cols-[minmax(0,1fr)_auto] items-end gap-2.5 rounded border border-border-strong bg-raised py-2 pl-3.5 pr-2 focus-within:border-accent"
            onSubmit={submit}
          >
            <div className="min-w-0">
              <textarea
                className="max-h-[150px] min-h-[38px] w-full resize-y border-0 bg-transparent py-2 text-[12px] leading-relaxed text-text outline-0 placeholder:text-faint"
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
              <div className="flex items-center justify-between gap-3.5 pb-0.5 text-micro text-faint">
                <span>Enter to send · Shift + Enter for a new line</span>
                <span className="shrink-0 font-mono tabular-nums">{draft.length.toLocaleString()} / 32,000</span>
              </div>
            </div>
            {busy ? (
              <Button
                variant="danger"
                disabled={currentActivity === "Cancellation requested"}
                onClick={() => void requestStop()}
              >
                {currentActivity === "Cancellation requested" ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <Button variant="primary" type="submit" disabled={!draft.trim() || !chatReady} aria-label="Send message">
                ↑
              </Button>
            )}
          </form>
          <div className="mx-auto mt-2 flex max-w-[940px] flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <StatusText dot tone={working ? "accent" : routeReady ? "good" : "warn"}>
              {working
                ? (currentActivity ?? "Hermes is working")
                : routeReady
                  ? "Hermes route ready"
                  : readinessTitle}
            </StatusText>
            <StatusText>{identityMode === "ENTERPRISE" ? "Enterprise session" : "Administrator preview"}</StatusText>
            <StatusText>OrcaSynapse policy · Hermes execution · private knowledge</StatusText>
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
