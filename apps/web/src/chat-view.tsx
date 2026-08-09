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
import { applyStreamEventToConversation } from "./chat-stream-reducer.js";
import { MarkdownMessage } from "./chat/markdown-message.js";
import { groupConversationsByDate } from "./chat/conversation-groups.js";
import { groupRuntimeEvents, summariseTimeline } from "./chat/timeline.js";
import { COMPOSER_ZONE, THREAD_MEASURE, THREAD_SCROLLER } from "./chat/measure.js";
import { shouldStickToBottom } from "./chat/stick-to-bottom.js";
import { usePacedStream } from "./chat/use-paced-stream.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
  Input,
  LockedScreen,
  MicroLabel,
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
  // `null` is "not loaded", distinct from the empty array that means "nothing
  // indexed". Collapsing the two let a failed load render as an empty library.
  const [library, setLibrary] = useState<DocumentSummary[] | null>(null);
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
  /*
   * Whether the reader is at the bottom of the transcript. Starts true: a fresh
   * conversation has nothing to have scrolled away from, and a jump-to-latest
   * offered before anything has been read is an offer to go where you already
   * are.
   */
  const [pinned, setPinned] = useState(true);
  const abortController = useRef<AbortController | null>(null);
  const messageScroller = useRef<HTMLDivElement>(null);
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

  /*
   * Hermes emits deltas faster than a screen refreshes, so applying each one on
   * arrival spends several React renders inside a frame nobody sees and paints
   * the survivor as a jump of a whole sentence. Holding deltas for a frame and
   * releasing a share of the backlog per tick costs the same total time and
   * reads as writing.
   *
   * Whole frames only. The server resumes exclusively from the cursor the
   * client acknowledged, so a delta applied halfway would be re-sent in full on
   * reconnect and duplicate the half already on screen.
   */
  const stream = usePacedStream<ChatStreamEvent>((events) => {
    const now = new Date().toISOString();
    for (const event of events) describeStreamEvent(event);
    // One `setActive` for the whole tick, folded with the same reducer a single
    // event uses -- which returns its input by identity when nothing applies,
    // so a frame carrying only foreign events still costs no render.
    setActive((current) => events.reduce(
      (conversation, event) => applyStreamEventToConversation(conversation, event, now),
      current,
    ));
  });

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

  /*
   * Follow the answer only while the reader is already at the bottom.
   *
   * This used to scroll unconditionally on every message change, which during a
   * streaming turn is several times a second: scrolling up to re-read something
   * yanked the view back down before the sentence was finished. Scrolling away
   * is the reader saying they want to be somewhere else, and the only correct
   * response is to stop following until they come back.
   *
   * `scrollTop` on the container rather than `scrollIntoView` on a sentinel,
   * because scrollIntoView cannot ask the question -- it moves whatever ancestor
   * happens to scroll, and gives no way to know where the reader was first.
   */
  useEffect(() => {
    const scroller = messageScroller.current;
    if (!scroller) return;
    /*
     * `pinned` is recomputed here, not only in the scroll listener below.
     *
     * Content growing fires no scroll event, so this is the only place that can
     * notice the reader has fallen behind. Without it `pinned` keeps whatever
     * value the reader's last actual scroll left it with: the transcript
     * correctly stops following, "Jump to latest" never appears because nothing
     * marked them as unpinned, and there is no way back to the answer.
     *
     * Pacing makes that the normal case rather than a rare one -- a single
     * commit can now append a whole backlog of frames, so one render can move
     * the bottom far further than the slack allows.
     */
    const following = shouldStickToBottom(scroller);
    setPinned(following);
    if (!following) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [active?.messages, busy]);

  /*
   * The reader's position, read from the one element that scrolls.
   *
   * Stopping the transcript following is only half the fix: a reader who has
   * scrolled up during a live run has no way back to the answer being written,
   * and hunting for the bottom of a growing transcript by hand is worse than
   * the yank this replaced. `pinned` is what decides whether that way back is
   * offered.
   */
  useEffect(() => {
    const scroller = messageScroller.current;
    if (!scroller) return;
    const readPosition = () => setPinned(shouldStickToBottom(scroller));
    readPosition();
    scroller.addEventListener("scroll", readPosition, { passive: true });
    return () => scroller.removeEventListener("scroll", readPosition);
  }, [unlocked]);

  const jumpToLatest = () => {
    const scroller = messageScroller.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    setPinned(true);
  };

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
              stream.push(event);
            },
            controller.signal,
          );
          // Before the refetch, always: anything still queued is text the
          // server has already been told the client holds, and it will not be
          // sent again.
          stream.flush();
          if (controller.signal.aborted) return;
          const refreshed = await getChatConversation(conversationId);
          setActive((current) => current?.id === conversationId ? refreshed : current);
          await refreshList();
          return;
        } catch (cause) {
          // Same reason, one step earlier: the reconnect below re-reads the
          // cursor the *server* recorded, so a queued frame dropped here is a
          // sentence the reader never sees.
          stream.flush();
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
    return () => {
      // And on abort or unmount, before the subscription goes away with the
      // queue still holding frames the server will never resend.
      stream.flush();
      controller.abort();
    };
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

  /*
   * What the run is doing, in the header and beside the pending answer. Split
   * out of the state transition so a paced tick can narrate several events and
   * still fold them into a single `setActive`.
   */
  function describeStreamEvent(event: ChatStreamEvent) {
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
      setError("Create and activate an Agent Profile before starting a Session.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setDraft("");
    let conversation = active;
    try {
      if (!conversation) {
        if (!selectedProfileId) throw new Error("Activate an Agent Profile before starting a Session.");
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
      // The composer is cleared before the request so the send feels immediate,
      // but a submit that never reached the server creates no assistant row —
      // and `retryMessage` can only read text back out of one. Without this a
      // long message is gone. Anything typed since wins over the restore.
      setDraft((current) => current.trim() ? current : content);
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
    setLibrary(null);
    try {
      // Only READY documents can be pinned; anything else would narrow
      // retrieval to a source that has no embedded chunks yet.
      setLibrary(pinnableDocuments((await getDocuments()).items));
    } catch (cause) {
      // Left open, the picker answers a failed load with "No indexed documents
      // yet" while the real cause renders behind the backdrop — so the operator
      // concludes the library is empty rather than unreachable. Skills and
      // Memory already close on failure; `handleError` also routes a 401 to the
      // session handler instead of printing it as a message.
      setKnowledgeOpen(false);
      handleError(cause, "Unable to load your documents.");
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
          title="Session"
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
  /*
   * Each condition is the one the matching `Dialog` is rendered with, not a
   * paraphrase: Knowledge and Delete both need an active conversation, and a
   * flag that said "open" while the dialog was not would hide the jump control
   * for no reason a reader could see.
   */
  const dialogOpen = (knowledgeOpen && active !== null)
    || skillsOpen
    || memoryOpen
    || (confirmDelete && active !== null);

  return (
    /*
     * `m-0 w-full max-w-none` is not decoration: `main > *` centres every view
     * in a 1380px column, and Chat is the one screen that must fill the shell.
     * A utility class outranks that element selector, which is what lets the
     * layout be stated here rather than in a stylesheet rule keyed to a class
     * name.
     */
    <section className="m-0 grid h-full w-full max-w-none grid-cols-1 bg-bg lg:grid-cols-[272px_minmax(0,1fr)]">
      <aside
        className={cn(
          "min-w-0 flex-col border-r border-border bg-surface px-3.5 pb-4 pt-4",
          historyOpen ? "flex" : "hidden lg:flex",
        )}
      >
        <h1 className="sr-only">Session</h1>
        {/*
          * The rail leads with the one action it exists for, drawn the design's
          * way: full width, accent fill, bold — a beginning, not a utility.
          */}
        <Button variant="primary" className="mb-3 w-full justify-center gap-2 font-bold" onClick={newConversation}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13" /></svg>
          New conversation
        </Button>
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
          {groupConversationsByDate(visibleConversations, new Date()).map((group) => (
            <section key={group.key} className="grid content-start gap-1">
              {/*
                * Level 3, deliberately. The sr-only h1 in this rail is what
                * closes an open menu when clicked, and a second level-1 heading
                * would make that target ambiguous.
                */}
              <h3 className="sticky top-0 z-[1] bg-surface px-3.5 pb-1 pt-3 text-micro font-semibold uppercase tracking-[0.08em] text-faint">
                {group.label}
              </h3>
          {group.items.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              aria-current={active?.id === conversation.id ? "true" : undefined}
              className={cn(
                // The design's row: radius 10, and the active conversation is
                // named by a short accent mark on its leading edge rather than
                // a border all the way round.
                "relative grid w-full gap-0.5 rounded py-2.5 pl-3.5 pr-3 text-left transition-colors",
                "before:absolute before:bottom-2.5 before:left-0 before:top-2.5 before:w-[2.5px] before:rounded before:content-['']",
                active?.id === conversation.id
                  ? "bg-raised before:bg-accent"
                  : "before:bg-transparent hover:bg-raised/60",
              )}
              onClick={() => void selectConversation(conversation.id)}
            >
              <strong className={cn(
                "truncate text-[12.5px] text-text",
                active?.id === conversation.id ? "font-semibold" : "font-medium",
              )}>{conversation.title}</strong>
              <span className="flex items-center gap-1.5 text-[10.5px] text-faint">
                <span className="shrink-0">
                  {conversation.status === "ARCHIVED" ? "Archived" : formatConversationTime(conversation.lastMessageAt)}
                </span>
                <span aria-hidden="true" className="h-[2.5px] w-[2.5px] shrink-0 rounded-pill bg-faint" />
                <span className="truncate">
                  {conversation.lastMessagePreview ?? conversation.profileName ?? conversation.modelAlias}
                </span>
              </span>
            </button>
          ))}
            </section>
          ))}
        </div>
        {/*
          * The rail's foot was a bordered Panel wrapping a kicker, a value, a
          * name and two further bordered boxes carrying two more uppercase
          * kickers: three cards and three kickers inside 200px, to state three
          * facts. A hairline and a column state them.
          *
          * "Choose below" also stopped being true the moment the profile picker
          * moved into the header, which is the kind of thing a caption tells
          * you to do long after nobody can do it.
          */}
        {/*
          * Set at the rail's own reading size, not below it.
          *
          * Every line here was `text-caption` -- 11px at 1.5, which is the step
          * for a dense grid header and two steps under anything in the thread
          * beside it. Four facts about who you are and what you are pointed at
          * were the tightest type on the screen, in the corner an operator looks
          * at to confirm exactly that. `text-body` and real row spacing put it
          * on the same footing as the window it sits next to.
          */}
        <div className="mt-auto grid gap-3.5 border-t border-border pt-4">
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-pill bg-good" />
            <div className="min-w-0">
              <strong className="block truncate text-body font-semibold leading-relaxed text-text">
                {identityMode === "ENTERPRISE" ? "Enterprise Access" : "Administrator preview"}
              </strong>
              <small className="block truncate text-caption leading-relaxed text-faint">
                {displayName ?? "Active OrcaSynapse session"}
              </small>
            </div>
          </div>
          <dl className="m-0 grid gap-2">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <dt className="shrink-0 text-body leading-relaxed text-faint">Agent</dt>
              <dd className="m-0 min-w-0 truncate text-body leading-relaxed text-muted">
                {active?.profileName ?? "None selected"}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <dt className="shrink-0 text-body leading-relaxed text-faint">Usage</dt>
              <dd
                className="m-0 min-w-0 truncate font-mono text-body leading-relaxed tabular-nums text-muted"
                title={conversationTotalTokens === null ? "This runtime does not report token usage." : undefined}
              >
                {conversationTotalTokens === null ? "Not reported" : `${conversationTotalTokens.toLocaleString()} tokens`}
              </dd>
            </div>
          </dl>
        </div>
      </aside>

      <div className="relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        {/* 52px, not 68. The workspace band sits directly above this one from
            ai-v3.3.0, so the two together were 98px of chrome before a word of
            the thread -- most of the reduction ai-v2.6.0 bought back, spent
            again. This bar keeps what only it can say: which conversation, and
            the controls that act on it. */}
        <header className="flex min-h-[52px] items-center gap-4 border-b border-border bg-surface px-5 py-2">
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
              <strong className="block truncate font-display text-[15px] font-semibold tracking-[-0.02em] text-text">
                {active?.title ?? "New conversation"}
              </strong>
            )}
            {/* Only when there is a conversation to describe. Without one this
                line read "Start a governed Hermes conversation" -- an invitation
                the empty state below already extends, in larger type. */}
            {active && (
              <span className="mt-0.5 block truncate text-caption text-faint">
                {`${active.profileName ?? "Legacy route"} · ${active.messages.length} messages`}
              </span>
            )}
          </div>
          {/*
            * Two things, not four.
            *
            * This carried a readiness chip, the profile picker, the model alias
            * and a token count across ~400px. Two of them said nothing on their
            * own -- "Active default" and "—" are only legible if you already
            * know which is the model and which is the usage -- and the token
            * figure is the same one the rail's foot states under a label. What
            * is left is the choice you can still make and whether the route can
            * serve it.
            */}
          <div className="flex min-w-0 items-center gap-2.5" aria-label="Conversation runtime">
            {!active && (
              <Select
                className="hidden h-8 w-[184px] text-caption sm:block"
                disabled={!profileAvailable}
                value={selectedProfileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
                aria-label="Agent Profile"
              >
                {profiles.length === 0 && <option value="">No active profiles</option>}
                {profiles.map((profile) => (
                  <option value={profile.id} key={profile.id}>
                    {profile.activeVersionConfiguration?.displayName ?? profile.version.displayName}
                  </option>
                ))}
              </Select>
            )}
            <StatusText dot tone={working ? "accent" : routeReady ? "good" : "warn"} className="whitespace-nowrap">
              {working
                ? `${(streamElapsedMs / 1_000).toFixed(1)} s`
                : routeReady
                  ? "Ready"
                  : "Setup required"}
            </StatusText>
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
          * The one element that scrolls, and the one column everything in it
          * is read in. The scroller carries no aria-live: announcing the whole
          * transcript on every delta reads a growing answer back from the top,
          * several times a second. The live status beside the pending turn says
          * the same thing once.
          */}
        {/* Containing block for the jump affordance: it has to end where the
            composer begins, and the composer's height changes with the
            textarea. Anchoring to the section instead needs a guessed offset,
            which lands the control inside the composer as soon as the guess is
            wrong. */}
        <div className="relative grid min-h-0">
        <div className={THREAD_SCROLLER} ref={messageScroller}>
          <div className={THREAD_MEASURE}>
            {!active || active.messages.length === 0 ? (
              <div className="mx-auto w-full max-w-[720px] pt-[min(10vh,90px)]">
                <div
                  aria-hidden="true"
                  className="mb-4 grid h-[46px] w-[46px] place-items-center rounded-pill bg-soft"
                >
                  <img src="/brand/sivali-mark.svg" alt="" width={28} height={28} className="block" />
                </div>
                <h2 className="m-0 font-display text-[30px] font-semibold leading-[1.2] tracking-[-0.03em] text-text">
                  Ask anything about
                  <br />
                  your workspace.
                </h2>
                <p className="mb-6 mt-3 max-w-[460px] text-body leading-relaxed text-muted">
                  Every response is a governed Hermes Agent Run. Your selected profile controls behavior, skills, memory
                  access, and tool policy.
                </p>
                {/*
                  * Two bordered cards used to stand between the greeting and the
                  * one thing a reader came here to do. The profile picker moved
                  * to the header, where configuration lives; what is left is the
                  * blocking fact and the button that resolves it, with no box
                  * around either -- a border here would only say "this is a
                  * distinct object", which it is not. It is the sentence.
                  */}
                {!routeReady && (
                  <div className="mb-7 flex items-center justify-between gap-5 text-left" role="status">
                    <div className="min-w-0">
                      <strong className="block text-label font-semibold text-text">{readinessTitle}</strong>
                      <span className="mt-1 block text-body text-muted">{readinessDetail}</span>
                    </div>
                    <Button variant="primary" className="shrink-0" onClick={openReadiness}>
                      {!profileAvailable ? "Create Agent Profile" : "Review setup"}
                    </Button>
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      label: "Outline an on-premise AI deployment",
                      sub: "Main considerations, stated concisely",
                      prompt: "Summarize the main considerations for an on-premise AI deployment.",
                    },
                    {
                      label: "Create an AI risk checklist",
                      sub: "For an internal assistant rollout",
                      prompt: "Create a concise risk checklist for deploying an internal AI assistant.",
                    },
                  ].map((suggestion) => (
                    <button
                      className="grid gap-1.5 rounded-lg border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:border-accent hover:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-40"
                      key={suggestion.label}
                      type="button"
                      disabled={!routeReady}
                      onClick={() => setDraft(suggestion.prompt)}
                    >
                      <span className="text-body font-semibold leading-snug text-text">{suggestion.label}</span>
                      <span className="text-caption leading-snug text-faint">{suggestion.sub}</span>
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
                    /*
                     * The design's asymmetry, sharpened: the person's turn is a
                     * right-aligned soft-violet bubble with the flattened corner
                     * pointing back at them; the agent's turn is an open row
                     * under the mark. The eye finds where an exchange begins
                     * without reading a word, which on a long governed
                     * transcript is most of what makes it navigable.
                     */
                    "group",
                    message.role === "USER"
                      ? "mb-7 mt-2 ml-auto max-w-[540px] rounded-[18px] rounded-br-[6px] bg-soft px-4 py-3"
                      /*
                       * No rule between turns. A hairline under every message
                       * made the transcript a table with rows; the bubble above
                       * already says where an exchange begins, so the border was
                       * saying it a second time and louder. Space does it.
                       *
                       * `max-w-[940px]` was here too and never bound -- the
                       * measure wrapper is 46rem -- so it only misled.
                       */
                      : "grid w-full grid-cols-[30px_minmax(0,1fr)] gap-3.5 pb-8",
                  )}
                  key={message.id}
                >
                  {message.role !== "USER" && (
                    <div
                      aria-hidden="true"
                      className="grid h-8 w-8 place-items-center rounded-pill bg-soft"
                    >
                      <img src="/brand/sivali-mark.svg" alt="" width={19} height={19} className="block" />
                    </div>
                  )}
                  <div className="min-w-0">
                    {/*
                      * Name, timestamp and model alias were a four-part header on
                      * every single turn -- the densest thing in the transcript
                      * and the least read. They stay in the markup, so a screen
                      * reader and a hovering eye can both still get them, and
                      * they hold their space so nothing shifts on hover. Only a
                      * status that is not COMPLETED keeps permanent ink, because
                      * that one is news.
                      */}
                    <div className="flex min-h-[20px] items-center justify-between gap-3">
                      <div className="flex min-w-0 items-baseline gap-2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                        <strong className="text-caption font-semibold text-muted">
                          {message.role === "USER" ? "You" : (active.profileName ?? "Hermes")}
                        </strong>
                        <time className="font-mono text-micro text-faint" dateTime={message.createdAt}>
                          {formatMessageTime(message.createdAt)}
                        </time>
                        {message.role === "ASSISTANT" && (
                          <span className="max-w-[220px] truncate font-mono text-micro text-faint">
                            {message.modelAlias ?? active.modelAlias}
                          </span>
                        )}
                      </div>
                      {message.status !== "COMPLETED" && (
                        <StatusText
                          tone={message.status === "FAILED" || message.status === "CANCELLED" ? "bad" : "warn"}
                        >
                          {message.status.toLowerCase()}
                        </StatusText>
                      )}
                    </div>
                    {message.role === "USER"
                      ? <p className="my-1 whitespace-pre-wrap break-words text-body leading-[1.6] text-text">{message.content}</p>
                      : <MarkdownMessage
                          content={message.content || (message.status === "PENDING" ? "Thinking…" : "No content returned.")}
                          streaming={message.status === "PENDING"}
                        />}
                    {message.role === "ASSISTANT" && message.status === "PENDING" && (
                      /*
                        * The transcript's live region, moved here off the
                        * scroller. Announcing the whole thread on every delta
                        * read a growing answer back from the top several times
                        * a second; this says what the run is doing, and says it
                        * once per change.
                        */
                      <div
                        className="my-2.5 flex items-center justify-between gap-3 rounded border border-border-strong bg-raised px-3 py-2"
                        aria-label="Live generation status"
                      >
                        {/*
                          * aria-live sits on the activity text alone. On the
                          * container it also covered the elapsed-seconds
                          * counter, which a 250ms interval rewrites -- a fresh
                          * polite announcement four times a second for the
                          * whole run, which is the announcement storm moving it
                          * off the scroller was meant to end.
                          */}
                        <span aria-live="polite" className="min-w-0">
                          <StatusText dot tone="accent" className="whitespace-nowrap">
                            {currentActivity ?? "Hermes is working"}
                          </StatusText>
                        </span>
                        <small className="truncate text-right text-micro text-faint">
                          {busy ? `${(streamElapsedMs / 1_000).toFixed(1)} s elapsed` : "Awaiting recovery"} · governed run details appear as Hermes reports them
                        </small>
                      </div>
                    )}
                    {message.role === "ASSISTANT" && message.runtimeEvents.length > 0 && (
                      /*
                       * Loud while it happens, quiet once it has. Watching a
                       * governed run work is the point of the product; nine
                       * expanded rows sitting above a finished answer, forever,
                       * is not -- by the third turn the transcript is mostly
                       * machinery. `open` tracks the turn's own state, so it
                       * unfolds as the run starts and folds when it lands, and
                       * `summariseTimeline` names a failure while closed so a
                       * calm one-liner can never hide one.
                       *
                       * `<details>` rather than component state because the
                       * element already is this: it keeps its contents in the
                       * accessibility tree, it is keyboard-operable, and it
                       * needs no JavaScript to open.
                       */
                      <details
                        className="my-3 overflow-hidden rounded-lg border border-border bg-surface"
                        open={message.status !== "COMPLETED"}
                        /* `<details>` maps to role="group", so the label is
                           meaningful here and stays the region's name whether
                           it is open or closed. */
                        aria-label="Hermes agent activity"
                      >
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-caption text-muted marker:content-none hover:bg-raised">
                          <span className="min-w-0 truncate">
                            {summariseTimeline(groupRuntimeEvents(message.runtimeEvents), message.latencyMs)}
                          </span>
                          <span className="shrink-0 font-mono text-micro text-faint">
                            {message.runtimeEvents.length} event{message.runtimeEvents.length === 1 ? "" : "s"}
                          </span>
                        </summary>
                        <ol className="m-0 grid list-none border-t border-border p-0">{groupRuntimeEvents(message.runtimeEvents).map((entry) => {
                          const kind = entry.kind;
                          /*
                           * The newest event carries the detail worth showing --
                           * a completion's preview, a failure's code -- while
                           * the entry carries what the call *is*. Rendering the
                           * raw list instead gave one tool call four rows and
                           * no way to tell which progress belonged to it.
                           */
                          const runtimeEvent = entry.events[entry.events.length - 1]!;
                          return (
                            <li
                              className="grid min-w-0 grid-cols-[26px_minmax(0,1fr)] gap-2.5 border-t border-border px-3 py-2.5 first:border-t-0"
                              key={entry.key}
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
                                    {kind === "tool" ? entry.label
                                      : kind === "subagent" ? "Hermes subagent"
                                        : runtimeEventLabel(runtimeEvent.type)}
                                  </strong>
                                  <StatusText
                                    className="shrink-0"
                                    tone={entry.status === "failed" ? "bad" : entry.status === "completed" ? "good" : "accent"}
                                    dot={entry.status === "running"}
                                  >
                                    {/* The call's own state, not the last
                                        event's label: a call that failed reads
                                        as failed even though its final event is
                                        just one more row. */}
                                    {entry.status === "running" && entry.events.length > 1
                                      ? `${entry.events.length} steps`
                                      : entry.status}
                                  </StatusText>
                                </div>
                                {(runtimeEvent.preview || runtimeEvent.summary) && (
                                  <p className="my-1 text-micro leading-relaxed text-muted">
                                    {runtimeEvent.preview ?? runtimeEvent.summary}
                                  </p>
                                )}
                                <small className="block font-mono text-micro text-faint">{[
                                  formatRuntimeDuration(entry.durationMs),
                                  runtimeEvent.inputTokens === null ? null : `${runtimeEvent.inputTokens.toLocaleString()} in`,
                                  runtimeEvent.outputTokens === null ? null : `${runtimeEvent.outputTokens.toLocaleString()} out`,
                                  runtimeEvent.reasoningTokens === null ? null : `${runtimeEvent.reasoningTokens.toLocaleString()} reasoning`,
                                  runtimeEvent.costUsd === null ? null : `$${runtimeEvent.costUsd.toFixed(4)}`,
                                ].filter(Boolean).join(" · ") || new Date(runtimeEvent.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>
                              </div>
                            </li>
                          );
                        })}</ol>
                      </details>
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
                          className="grid h-7 w-7 place-items-center rounded border border-warn/50 bg-warn/10 font-mono text-label font-bold text-warn"
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
                            {/* The value was lowercased in JavaScript and then
                                uppercased again by the class -- two opposite
                                intentions, the CSS winning. Lowercase was the
                                one someone meant. */}
                            <small className="text-caption tabular-nums text-faint">
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
                                {/* Eight uppercase micro-labels in one strip
                                    under an answer -- the single densest thing
                                    on the screen, and every one of them names a
                                    figure whose unit already names it. */}
                                <dt className="truncate text-caption tabular-nums text-faint">{metric.label}</dt>
                                <dd
                                  className={cn(
                                    "m-0 mt-1 truncate font-mono text-caption font-semibold tabular-nums",
                                    metric.key === "throughput" ? "text-caption text-accent" : "text-muted",
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
          </div>
        </div>

        {/*
          * The way back, offered only to a reader who has actually left the
          * bottom -- and never over an open dialog, which owns the screen while
          * it is up and must not have a stray control floating on the backdrop.
          */}
        {!pinned && !dialogOpen && (
          <Button
            size="sm"
            className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 shadow-overlay"
            onClick={jumpToLatest}
          >
            Jump to latest
          </Button>
        )}
        </div>

        {/* Same horizontal padding and reserved scrollbar gutter as the
            transcript above, or the composer and the messages disagree on where
            the column ends. */}
        <div className={COMPOSER_ZONE}>
          {error && (
            <Alert className={cn(THREAD_MEASURE, "mb-2")} onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}
          <form
            className={cn(
              THREAD_MEASURE,
              "group grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-lg border py-2 pl-4 pr-2 transition-colors",
              /*
               * A control that is off should look off. This one was genuinely
               * disabled and entirely normal-looking, so the only way to find
               * out was to click it and watch nothing happen; the reason lived
               * in placeholder text, which vanishes the moment anyone types.
               * The strip below the composer states the reason in words.
               */
              chatReady
                ? "border-border-strong bg-raised focus-within:border-accent"
                : "cursor-not-allowed border-border bg-surface opacity-60",
            )}
            onSubmit={submit}
          >
            <div className="min-w-0">
              <textarea
                className="max-h-[168px] min-h-[42px] w-full resize-y border-0 bg-transparent py-2 text-read text-text outline-0 placeholder:text-faint disabled:cursor-not-allowed"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={active?.status === "ARCHIVED" ? "Restore this conversation to continue" : chatReady ? "Message your selected Hermes agent" : "Finish the required setup to start a Session"}
                rows={1}
                maxLength={32_000}
                disabled={working || !chatReady}
                aria-label="Chat message"
              />
              {/* Two lines of permanent instruction under a text box everyone
                  already knows how to use. Kept, because Shift+Enter is not
                  guessable -- but only while the box has focus, which is the
                  only moment either figure is worth anything. */}
              <div className="flex items-center justify-between gap-3.5 pb-0.5 text-micro text-faint opacity-0 transition-opacity duration-150 group-focus-within:opacity-100">
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
                {/* Was the literal character `↑`, which renders in the body face
                    at whatever weight the button inherits and sits a few pixels
                    off centre in most of them. */}
                <svg
                  viewBox="0 0 16 16"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 13.2V3.4M3.6 7.8 8 3.4l4.4 4.4" />
                </svg>
              </Button>
            )}
          </form>
          {/*
            * The status strip that stood here is gone: a readiness chip that
            * repeats the empty state's own heading, an identity the rail's foot
            * already carries, and a sentence about the architecture. The live
            * "Hermes is working" case is not lost with it -- the pending row in
            * the transcript reports elapsed time while a run is in flight,
            * which is where a reader is already looking.
            */}
          {/*
            * The standing caution, on its own line rather than as a fourth chip
            * in the strip above.
            *
            * A governed run is not a correct one: the policy line says where the
            * answer came from and nothing about whether it is right. Grounding
            * and attribution make a wrong answer easier to catch, which is a
            * reason to check the sources, not a reason to skip it.
            */}
          <p className={cn(THREAD_MEASURE, "mb-0 mt-1.5 text-center text-micro leading-relaxed text-faint")}>
            Answers are generated and can be wrong or incomplete. Check the cited sources before you rely on one.
          </p>
        </div>
      </div>

      {/*
        * The context rail is gone, not moved.
        *
        * It was a fourth vertical zone holding a read-only copy of the pinned
        * sources, a button that opened the knowledge dialog, and a card of
        * marketing copy -- 264px of permanent width, most often showing "Open a
        * conversation to see its knowledge scope". The header already carries
        * `Knowledge · N`, which is the count plus the way in; the dialog it
        * opens is where the pins actually live and the only place scope
        * changes. A panel that restates a button next to the button is width
        * spent on nothing.
        */}

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
        {library === null ? (
          <p className="m-0 text-body text-faint">Loading…</p>
        ) : library.length === 0 ? (
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
                    <small className="shrink-0 text-micro font-semibold uppercase tabular-nums text-faint">
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
                  <small className="mt-1 block text-micro font-semibold uppercase tabular-nums text-faint">
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
    </section>
  );
}

function statusIsActive(
  id: string,
  items: ChatConversationSummary[],
): boolean {
  return items.find((item) => item.id === id)?.status === "ACTIVE";
}
