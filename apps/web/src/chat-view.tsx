import type {
  HermesRuntimeCatalogue,
  AgentRunApproval,
  AgentProfile,
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatStreamEvent,
} from "@orcasynapse/contracts";
import { applyStreamEventToConversation } from "./chat-stream-reducer.js";
import { interleaveByOffset } from "./chat/interleave.js";
import { MarkdownMessage } from "./chat/markdown-message.js";
import { groupConversationsByDate } from "./chat/conversation-groups.js";
import { groupRuntimeEvents, summariseTimeline, type TimelineEntry } from "./chat/timeline.js";
import { COMPOSER_ZONE, THREAD_MEASURE, THREAD_SCROLLER } from "./chat/measure.js";
import { shouldStickToBottom } from "./chat/stick-to-bottom.js";
import { usePacedStream } from "./chat/use-paced-stream.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  cancelChatRun,
  createChatConversation,
  decideChatApproval,
  deleteChatConversation,
  forkChatConversation,
  getChatConversation,
  getRuntimeCatalogue,
  getChatConversations,
  getAgentProfiles,
  streamChatEvents,
  submitChatMessage,
  updateChatConversation,
} from "./api.js";
import {
  Alert,
  Button,
  Dialog,
  Input,
  LockedScreen,
  MicroLabel,
  Select,
  StatusText,
  cn,
} from "./ui/index.js";
import {
  CopyIcon,
  LayersIcon,
  MonitorIcon,
  NodeIcon,
  RobotIcon,
  SnapshotIcon,
  TerminalIcon,
} from "./ui/relay-icons.js";

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

type ChatRuntimeEvent = ChatMessage["runtimeEvents"][number];

type ResponseFlowBlock =
  | { kind: "text"; text: string }
  | { kind: "activity"; entries: TimelineEntry<ChatRuntimeEvent>[] };

/** Lifecycle bookkeeping stays in the audit log without crowding the answer. */
function visibleTimelineEntries(message: ChatMessage): TimelineEntry<ChatRuntimeEvent>[] {
  return groupRuntimeEvents(message.runtimeEvents).filter((entry) => {
    if (entry.kind !== "tool" && entry.kind !== "subagent" && entry.kind !== "reasoning") return false;
    // Some Hermes versions expose their internal thinking sentinel as a tool.
    // It has no useful payload and is not a governed call, so showing "Used
    // thinking" creates noise and inflates the operator-facing tool count.
    return !(entry.kind === "tool" && readableToolName(entry.label).toLowerCase() === "thinking");
  });
}

/** Consecutive calls become one dotted run, while agent prose remains between runs. */
function responseFlowBlocks(
  content: string,
  entries: readonly TimelineEntry<ChatRuntimeEvent>[],
): ResponseFlowBlock[] {
  const blocks: ResponseFlowBlock[] = [];
  for (const part of interleaveByOffset(content, entries)) {
    if (part.kind === "text") {
      if (part.text) blocks.push(part);
      continue;
    }
    const previous = blocks[blocks.length - 1];
    if (previous?.kind === "activity") previous.entries.push(part.entry);
    else blocks.push({ kind: "activity", entries: [part.entry] });
  }
  return blocks;
}

function readableToolName(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

function activityTitle(entry: TimelineEntry<ChatRuntimeEvent>): string {
  if (entry.kind === "reasoning") return entry.status === "running" ? "Planning next step" : "Planned next step";
  if (entry.kind === "subagent") return entry.status === "running" ? "Delegating to a subagent" : "Delegated to a subagent";
  const tool = readableToolName(entry.label || "tool");
  if (entry.status === "running") return `Calling ${tool}`;
  if (entry.status === "failed") return `${tool} failed`;
  if (entry.status === "cancelled") return `${tool} cancelled`;
  return `Used ${tool}`;
}

function activityGroupTitle(entries: readonly TimelineEntry<ChatRuntimeEvent>[]): string {
  const running = entries.some(({ status }) => status === "running");
  const tools = entries.filter(({ kind }) => kind === "tool").length;
  if (tools === entries.length) {
    return `${running ? "Running" : "Ran"} ${tools} tool call${tools === 1 ? "" : "s"}`;
  }
  return `${running ? "Working through" : "Completed"} ${entries.length} agent action${entries.length === 1 ? "" : "s"}`;
}

function activityTone(status: TimelineEntry["status"]): string {
  if (status === "failed") return "bg-bad";
  if (status === "cancelled") return "bg-warn";
  if (status === "completed") return "bg-good";
  return "bg-accent anim-live";
}

function AgentActivityTrail({ entries }: { entries: readonly TimelineEntry<ChatRuntimeEvent>[] }) {
  return (
    <section className="my-3" aria-label={activityGroupTitle(entries)}>
      <header className="flex min-w-0 items-center gap-2 text-caption text-muted">
        <TerminalIcon size={15} className="text-faint" />
        <strong className="truncate font-medium">{activityGroupTitle(entries)}</strong>
      </header>
      <ol className="relative m-0 ml-[7px] mt-2 grid list-none gap-0 border-l border-dotted border-border-strong p-0 pl-5">
        {entries.map((entry) => {
          const runtimeEvent = entry.events[entry.events.length - 1]!;
          const detail = runtimeEvent.preview ?? runtimeEvent.summary;
          const duration = formatRuntimeDuration(entry.durationMs);
          return (
            <li className="relative min-w-0 py-1.5 first:pt-0 last:pb-0" key={entry.key}>
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -left-[24px] top-[11px] h-[7px] w-[7px] rounded-pill ring-4 ring-bg",
                  activityTone(entry.status),
                )}
              />
              <div className="flex min-w-0 items-start gap-3 rounded px-2 py-1 transition-colors hover:bg-raised">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <strong className="truncate text-caption font-medium text-muted">{activityTitle(entry)}</strong>
                    <span className="sr-only">Status: {entry.status}</span>
                  </div>
                  {detail && detail !== entry.label && (
                    <p className="my-0.5 line-clamp-2 text-micro leading-relaxed text-faint">{detail}</p>
                  )}
                  {entry.status === "failed" && runtimeEvent.errorCode && (
                    <small className="font-mono text-micro text-bad">{runtimeEvent.errorCode}</small>
                  )}
                </div>
                {duration && <small className="shrink-0 font-mono text-micro tabular-nums text-faint">{duration}</small>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function AgentResponseFlow({
  message,
  currentActivity,
  busy,
  elapsedMs,
}: {
  message: ChatMessage;
  currentActivity: string | null;
  busy: boolean;
  elapsedMs: number;
}) {
  const entries = visibleTimelineEntries(message);
  const blocks = responseFlowBlocks(message.content, entries);
  const empty = blocks.length === 0;

  return (
    <div aria-label={entries.length > 0 ? "Hermes agent activity" : undefined}>
      {empty ? (
        <MarkdownMessage
          content={message.status === "PENDING" ? "Thinking…" : "No content returned."}
          streaming={message.status === "PENDING"}
        />
      ) : blocks.map((block, index) => block.kind === "text" ? (
        <MarkdownMessage
          content={block.text}
          streaming={message.status === "PENDING" && index === blocks.length - 1}
          key={`text-${index}`}
        />
      ) : (
        <AgentActivityTrail entries={block.entries} key={`activity-${block.entries[0]!.key}`} />
      ))}

      {message.status === "PENDING" && (
        <div className="mt-3 flex min-w-0 items-center gap-2.5 text-caption text-muted">
          <span aria-hidden="true" className="grid h-4 w-4 place-items-center">
            <span className="h-2 w-2 rounded-pill bg-accent anim-live" />
          </span>
          <span aria-live="polite" className="min-w-0 truncate">
            {currentActivity ?? "Hermes is working"}
          </span>
          <small className="ml-auto shrink-0 font-mono text-micro tabular-nums text-faint">
            {busy ? `${(elapsedMs / 1_000).toFixed(1)} s` : "reconnecting"}
          </small>
        </div>
      )}

      {message.status === "COMPLETED" && entries.length > 0 && (
        <footer className="mt-3 flex items-center gap-2 text-caption text-faint">
          <NodeIcon size={14} />
          <span>{summariseTimeline(entries, message.latencyMs)}</span>
        </footer>
      )}
    </div>
  );
}

export interface ChatTelemetryMetric {
  key: "throughput" | "tokens" | "first-token" | "latency";
  label: string;
  value: string;
}

export function chatMessageTelemetry(message: ChatMessage): ChatTelemetryMetric[] {
  const throughput = message.outputTokens !== null && message.latencyMs !== null && message.latencyMs > 0
    ? `${(message.outputTokens / (message.latencyMs / 1_000)).toFixed(1)} tok/s`
    : "—";
  return [
    { key: "throughput", label: "Speed", value: throughput },
    {
      key: "tokens",
      label: "Tokens",
      value: `${formatTokenCount(message.inputTokens)} in / ${formatTokenCount(message.outputTokens)} out`,
    },
    { key: "first-token", label: "TTFT", value: formatLatency(message.firstTokenLatencyMs) },
    { key: "latency", label: "Latency", value: formatLatency(message.latencyMs) },
  ];
}

function ChatTelemetryIcon({ metric }: { metric: ChatTelemetryMetric["key"] }) {
  const props = { size: 13, className: "text-faint" } as const;
  if (metric === "throughput") return <MonitorIcon {...props} />;
  if (metric === "tokens") return <LayersIcon {...props} />;
  if (metric === "first-token") return <NodeIcon {...props} />;
  return <SnapshotIcon {...props} />;
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
  // `null` is "not loaded", distinct from the empty array that means "nothing
  // indexed". Collapsing the two let a failed load render as an empty library.
  const [moreOpen, setMoreOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<HermesRuntimeCatalogue | null>(null);
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
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
  const selectedProfile = profiles.find(({ id }) => id === selectedProfileId);
  const selectedAgentName = active?.profileName
    ?? selectedProfile?.activeVersionConfiguration?.displayName
    ?? selectedProfile?.version.displayName
    ?? "No agent selected";
  const sessionOwner = displayName ?? "OrcaSynapse operator";
  const sessionInitials = sessionOwner
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "OS";
  const sessionAccessLabel = identityMode === "ENTERPRISE" ? "Enterprise access" : "Administrator preview";
  const readinessTitle = !profileAvailable
    ? "Create your first Agent Profile"
    : administratorReadiness?.title ?? "Hermes is ready";
  const readinessDetail = !profileAvailable
    ? "A Profile defines Hermes behavior, model selection, and admitted Skills."
    : administratorReadiness?.detail ?? "The governed Hermes route is ready.";
  const openReadiness = !profileAvailable || administratorReadiness?.target === "Agents"
    ? onOpenAgents
    : onOpenPlatform;
  /*
   * Each condition is the one the matching `Dialog` is rendered with, not a
   * paraphrase: Delete needs an active conversation, and a flag that said
   * "open" while the dialog was not would hide the jump control
   * for no reason a reader could see.
   */
  const dialogOpen = skillsOpen
    || (confirmDelete && active !== null);

  return (
    /*
     * `m-0 w-full max-w-none` is not decoration: `main > *` centres every view
     * in a 1380px column, and Chat is the one screen that must fill the shell.
     * A utility class outranks that element selector, which is what lets the
     * layout be stated here rather than in a stylesheet rule keyed to a class
     * name.
     */
    <section className="m-0 grid h-full w-full max-w-none grid-cols-1 bg-bg lg:grid-cols-[288px_minmax(0,1fr)]">
      <aside
        className={cn(
          "min-w-0 flex-col border-r border-border bg-surface px-3 pb-3 pt-3",
          historyOpen ? "flex" : "hidden lg:flex",
        )}
      >
        <h1 className="sr-only">Session</h1>
        <div className="mb-2.5 flex items-center justify-between px-1.5">
          <strong className="font-display text-label font-semibold text-text">Conversations</strong>
          {conversations.length > 0 ? (
            <span className="font-mono text-micro tabular-nums text-faint">{conversations.length}</span>
          ) : null}
        </div>
        <Button
          variant="secondary"
          className="mb-2.5 h-10 w-full justify-start gap-2.5 border-border bg-raised px-3.5 text-text hover:border-accent/40 hover:bg-soft"
          onClick={newConversation}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3v-3A2.5 2.5 0 0 1 4 13.5v-7Z" />
            <path d="M12 7.5v5M9.5 10h5" />
          </svg>
          New conversation
        </Button>
        <label className="relative mb-3 block">
          <span className="sr-only">Search conversations</span>
          <svg className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-faint" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.8" cy="10.8" r="6.3" />
            <path d="m16 16 4 4" />
          </svg>
          <Input
            type="search"
            className="bg-bg pl-9"
            value={historyFilter}
            onChange={(event) => setHistoryFilter(event.target.value)}
            placeholder="Search conversations"
          />
        </label>
        <div className="grid min-h-0 flex-1 content-start gap-1 overflow-y-auto pr-0.5" aria-label="Conversation history">
          {visibleConversations.length === 0 && !loading && (
            <div className="grid justify-items-center gap-2 px-4 py-10 text-center">
              <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded bg-raised text-faint">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 5.5h14v10H9l-4 3v-13Z" />
                  <path d="M8.5 9h7M8.5 12h4.5" />
                </svg>
              </span>
              <strong className="text-label font-semibold text-muted">
                {conversations.length === 0 ? "No conversations yet" : "No matching conversations"}
              </strong>
              <span className="max-w-[22ch] text-caption leading-relaxed text-faint">
                {conversations.length === 0 ? "Start a new conversation and it will appear here." : "Try a different title, agent, or message."}
              </span>
            </div>
          )}
          {groupConversationsByDate(visibleConversations, new Date()).map((group) => (
            <section key={group.key} className="grid content-start gap-1">
              {/*
                * Level 3, deliberately. The sr-only h1 in this rail is what
                * closes an open menu when clicked, and a second level-1 heading
                * would make that target ambiguous.
                */}
              <h3 className="sticky top-0 z-[1] bg-surface px-3 pb-1 pt-3 text-micro font-semibold uppercase tracking-[0.08em] text-faint">
                {group.label}
              </h3>
          {group.items.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              aria-current={active?.id === conversation.id ? "true" : undefined}
              className={cn(
                "relative grid w-full gap-1 rounded px-3 py-2.5 text-left transition-colors",
                active?.id === conversation.id
                  ? "bg-raised"
                  : "hover:bg-raised/60",
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
                <span aria-hidden="true" className="h-[2.5px] w-[2.5px] shrink-0 rounded-full bg-faint" />
                <span className="truncate">
                  {conversation.lastMessagePreview ?? conversation.profileName ?? conversation.modelAlias}
                </span>
              </span>
            </button>
          ))}
            </section>
          ))}
        </div>
        {/* The account-style summary anchors the rail like a familiar chat app:
            identity first, then the two runtime facts an operator checks. */}
        <div className="mt-auto border-t border-border pt-3">
          <section className="rounded border border-border bg-raised p-2.5" aria-label="Current session identity">
            <header className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded bg-soft font-display text-caption font-semibold text-accent">
                {sessionInitials}
              </span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-label font-semibold text-text">{sessionOwner}</strong>
                <span className="mt-0.5 block truncate text-caption text-faint">{sessionAccessLabel}</span>
              </div>
              <span aria-label="Session active" className="h-2 w-2 shrink-0 rounded-full bg-good" />
            </header>
            <dl className="m-0 mt-2.5 grid gap-2 border-t border-border pt-2.5">
              <div className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-2">
                <RobotIcon size={15} className="text-accent" />
                <div className="min-w-0">
                  <dt className="text-micro font-semibold uppercase tracking-[0.06em] text-faint">Agent</dt>
                  <dd className="m-0 truncate text-caption font-medium text-muted">{selectedAgentName}</dd>
                </div>
              </div>
              <div className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-2">
                <svg className="text-faint" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 19V9M12 19V5M19 19v-7" />
                </svg>
                <div className="min-w-0">
                  <dt className="text-micro font-semibold uppercase tracking-[0.06em] text-faint">Usage</dt>
                  <dd
                    className="m-0 truncate font-mono text-caption tabular-nums text-muted"
                    title={conversationTotalTokens === null ? "This runtime does not report token usage." : undefined}
                  >
                    {conversationTotalTokens === null ? "Not reported" : `${conversationTotalTokens.toLocaleString()} tokens`}
                  </dd>
                </div>
              </div>
            </dl>
          </section>
        </div>
      </aside>

      <div className="relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        {/* This bar keeps what only it can say: which conversation is open,
            which agent owns a new one, and whether that route is usable. */}
        <header className="flex min-h-[56px] items-center gap-4 bg-bg px-5 py-2">
          <Button
            size="sm"
            className="lg:hidden"
            onClick={() => setHistoryOpen((value) => !value)}
            aria-label="Toggle conversation history"
          >
            ☰
          </Button>
          <div className="min-w-0 flex-1">
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
          <div className="flex min-w-0 items-center gap-2" aria-label="Conversation runtime">
            {!active && (
              <div
                className="relative hidden h-10 min-w-0 items-center rounded border border-border bg-surface transition-colors focus-within:border-accent sm:flex"
                data-agent-selector
              >
                <span className="pointer-events-none absolute left-2.5 top-1/2 z-[1] grid h-6 w-6 -translate-y-1/2 place-items-center rounded bg-soft text-accent" data-agent-selector-icon>
                  <RobotIcon size={15} />
                </span>
                <Select
                  className="h-9 w-[216px] border-0 bg-transparent pl-10 pr-2 text-caption font-semibold focus-visible:outline-offset-0"
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
              </div>
            )}
            {routeReady || working ? (
              <div className="flex h-10 items-center gap-2 rounded border border-border bg-surface px-3 text-caption font-semibold text-muted">
                <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", working ? "anim-live bg-accent" : "bg-good")} />
                <span className="whitespace-nowrap">{working ? `Working · ${(streamElapsedMs / 1_000).toFixed(1)} s` : "Agent ready"}</span>
              </div>
            ) : (
              <button
                type="button"
                className="flex h-10 items-center gap-2 rounded border border-warn/35 bg-warn/10 px-2.5 text-left text-warn transition-colors hover:border-warn/60 hover:bg-warn/20"
                onClick={openReadiness}
                aria-label="Open agent setup: setup required"
              >
                <span className="grid h-6 w-6 place-items-center rounded bg-warn/10">
                  <RobotIcon size={15} />
                </span>
                <span className="grid leading-tight">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.08em]">Agent</span>
                  <strong className="text-caption font-semibold">Setup required</strong>
                </span>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 8h9M9 4l4 4-4 4" />
                </svg>
              </button>
            )}
          </div>

          {active && !renaming && (
            <div className="relative flex items-center gap-1.5" ref={moreMenu}>
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
                  Every response is a governed Hermes Agent Run. Your selected profile controls behavior, Skills,
                  model selection, and tool policy; Hermes owns session continuity and memory internally.
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
                      ? "mb-7 mt-2 ml-auto max-w-[540px] rounded bg-soft px-4 py-3"
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
                      * Assistant identity remains visible so every response has
                      * clear authorship. User metadata stays available on hover
                      * without adding another label above every user bubble.
                      */}
                    <div className="flex min-h-[20px] items-center justify-between gap-3">
                      <div
                        className={cn(
                          "flex min-w-0 items-baseline gap-2 transition-opacity duration-150",
                          message.role === "USER"
                            ? "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                            : "opacity-100",
                        )}
                      >
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
                      : <AgentResponseFlow
                          message={message}
                          currentActivity={currentActivity}
                          busy={busy}
                          elapsedMs={streamElapsedMs}
                        />}
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
                    {message.role === "ASSISTANT" && message.status === "COMPLETED" && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 shrink-0 p-0"
                          aria-label="Copy response"
                          title="Copy response"
                          onClick={() => void navigator.clipboard?.writeText(message.content)}
                        >
                          <CopyIcon size={14} />
                        </Button>
                        <dl
                          aria-label="Response telemetry"
                          className="m-0 ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1"
                        >
                          {chatMessageTelemetry(message).map((metric) => (
                            <div
                              className="flex min-w-0 items-center gap-1.5"
                              key={metric.key}
                              title={`${metric.label}: ${metric.value}`}
                            >
                              <ChatTelemetryIcon metric={metric.key} />
                              <dt className="sr-only">{metric.label}</dt>
                              <dd
                                className={cn(
                                  "m-0 whitespace-nowrap font-mono text-micro font-semibold tabular-nums",
                                  metric.key === "throughput" ? "text-accent" : "text-muted",
                                )}
                              >
                                {metric.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
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
              "group grid gap-2 rounded-card border px-3 pb-2.5 pt-3 shadow-card transition-colors",
              /*
               * A control that is off should look off. This one was genuinely
               * disabled and entirely normal-looking, so the only way to find
               * out was to click it and watch nothing happen; the reason lived
               * in placeholder text, which vanishes the moment anyone types.
               * The strip below the composer states the reason in words.
               */
              chatReady
                ? "border-border-strong bg-surface focus-within:border-accent"
                : "cursor-not-allowed border-border bg-surface opacity-60",
            )}
            onSubmit={submit}
          >
            <textarea
              className="max-h-[180px] min-h-[54px] w-full resize-y border-0 bg-transparent px-1 py-1 text-read text-text outline-0 placeholder:text-faint disabled:cursor-not-allowed"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={active?.status === "ARCHIVED" ? "Restore this conversation to continue" : chatReady ? `Message ${selectedAgentName}` : "Finish the required setup to start a Session"}
              rows={1}
              maxLength={32_000}
              disabled={working || !chatReady}
              aria-label="Chat message"
            />
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 px-1 text-micro text-faint">
                <RobotIcon size={14} className="text-accent" />
                <span className="max-w-[180px] truncate font-medium text-muted">{selectedAgentName}</span>
                <span aria-hidden="true" className="hidden h-1 w-1 shrink-0 rounded-full bg-border-strong sm:block" />
                <span className="hidden sm:inline">Shift + Enter for new line</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden font-mono text-micro tabular-nums text-faint opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 sm:inline">
                  {draft.length.toLocaleString()} / 32,000
                </span>
                {busy ? (
                  <Button
                    variant="danger"
                    size="sm"
                    className="h-9"
                    disabled={currentActivity === "Cancellation requested"}
                    onClick={() => void requestStop()}
                  >
                    {currentActivity === "Cancellation requested" ? "Stopping…" : "Stop"}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    type="submit"
                    className="h-9 w-9 shrink-0 p-0"
                    disabled={!draft.trim() || !chatReady}
                    aria-label="Send message"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="16"
                      height="16"
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
              </div>
            </div>
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
            Answers are generated and can be wrong or incomplete. Verify important results before you rely on them.
          </p>
        </div>
      </div>

      {/*
        * All four of these were bare divs carrying role="dialog" and nothing
        * else — no aria-modal, no focus trap, no Escape, no scroll lock, no
        * focus restore. A keyboard user could tab straight out of the memory
        * panel into the transcript behind it while a screen reader kept
        * announcing the page as if no dialog were open. `Dialog` supplies all
        * of it once.
        */}

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
                ? `All ${catalogue.toolsets.length} toolsets are disabled by the managed runtime policy. Agents answer from the native Hermes session only.`
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
