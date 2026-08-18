import type {
  HermesRuntimeCatalogue,
  AgentRunApproval,
  AgentProfile,
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatStreamEvent,
  ModelDeployment,
} from "@orcasynapse/contracts";
import { ChatSchedules } from "./chat-schedules.js";
import { applyStreamEventToConversation } from "./chat-stream-reducer.js";
import { LoadingState } from "./components/ui/loading-state.js";
import { interleaveByOffset } from "./chat/interleave.js";
import { MarkdownMessage } from "./chat/markdown-message.js";
import { groupConversationsByDate } from "./chat/conversation-groups.js";
import {
  groupConsecutiveTimelineEntries,
  groupRuntimeEvents,
  summariseTimeline,
  type TimelineEntry,
  type TimelineEntryGroup,
} from "./chat/timeline.js";
import { COMPOSER_ZONE, THREAD_MEASURE, THREAD_SCROLLER } from "./chat/measure.js";
import { shouldStickToBottom } from "./chat/stick-to-bottom.js";
import { usePacedStream } from "./chat/use-paced-stream.js";
import { pickChatSuggestions } from "./chat/suggestions.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Bot as RobotIcon,
  BrainCircuit,
  CalendarClock,
  Copy as CopyIcon,
  Layers3 as LayersIcon,
  Monitor as MonitorIcon,
  Network as NodeIcon,
  Plus,
  Sparkles,
  SquareTerminal as TerminalIcon,
  Trash2,
} from "lucide-react";
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
  getModelDeployments,
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
  Textarea,
  cn,
} from "./ui/index.js";

interface ChatViewProps {
  unlocked: boolean;
  displayName: string | null;
  administratorReadiness: {
    ready: boolean;
    title: string;
    detail: string;
    target: "Deployment" | "Agents";
  } | null;
  onSignIn: () => void;
  onConfigure: () => void;
  onOpenAgents: () => void;
  onOpenPlatform: () => void;
  onSessionExpired: () => void;
}

/*
 * Moved to `client-uuid.ts` and re-exported here.
 *
 * The views are code split per route, so leaving it in this module meant any
 * other route wanting a UUID pulled the chat view's 200 kB chunk with it. The
 * re-export keeps this file's existing importers -- including its own two test
 * suites -- working unchanged.
 */
export { createClientMessageId } from "./client-uuid.js";

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

function formatCompactTokenCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/**
 * The composer's message cap, and the two points on the way to it where saying
 * so is worth the room.
 *
 * A counter that is always on is a number nobody reads: a draft of forty
 * characters against a thirty-two thousand character allowance carries no
 * information, and it sat beside the send control on every single turn. These
 * are the last fifth and the last twentieth of the allowance — the span where
 * the figure changes what someone does next.
 */
const COMPOSER_LIMIT = 32_000;
const COMPOSER_COUNTER_FROM = Math.round(COMPOSER_LIMIT * 0.2);
const COMPOSER_COUNTER_WARN = Math.round(COMPOSER_LIMIT * 0.05);

/**
 * How many times a dropped stream is worth re-opening before saying so.
 *
 * The loop had no bound and no error surface: every non-401 failure wrote
 * `Connection interrupted · retrying (N)` into the activity line and went round
 * again, forever, while the message stayed PENDING. Not every failure is
 * transient — the chat manager answers "The Hermes run is no longer available"
 * for a message whose `AgentRun` has been deleted, and it will answer that
 * every time — so a reader watched a small grey line count upwards with no way
 * to learn that the answer was never coming.
 *
 * Six, against a backoff that caps at five seconds: roughly twenty seconds of
 * genuinely transient trouble is absorbed, and anything past that is reported
 * rather than retried.
 */
/**
 * How often an idle open conversation asks whether it moved without this tab.
 *
 * The same cadence as the workspace reconciler in `app.tsx`, for the same
 * reason: both are background questions nobody is waiting on, and one number is
 * easier to reason about than two.
 */
const OUT_OF_BAND_POLL_MS = 15_000;

export const STREAM_RECONNECT_LIMIT = 6;

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

function activityTitle(entry: Pick<TimelineEntry<ChatRuntimeEvent>, "kind" | "label" | "status">): string {
  if (entry.kind === "reasoning") return entry.status === "running" ? "Planning next step" : "Planned next step";
  if (entry.kind === "subagent") return entry.status === "running" ? "Delegating to a subagent" : "Delegated to a subagent";
  const tool = readableToolName(entry.label || "tool");
  if (entry.status === "running") return `Calling ${tool}`;
  if (entry.status === "failed") return `${tool} failed`;
  if (entry.status === "cancelled") return `${tool} cancelled`;
  return `Used ${tool}`;
}

function activityStatusLabel(status: TimelineEntry<ChatRuntimeEvent>["status"]): string {
  if (status === "running") return "In progress";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Completed";
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

function ActivityKindIcon({ kind, label }: Pick<TimelineEntry<ChatRuntimeEvent>, "kind" | "label">) {
  const tool = readableToolName(label).toLowerCase();
  if (kind === "subagent") return <NodeIcon size={14} />;
  if (kind === "reasoning") return <RobotIcon size={14} />;
  if (tool.includes("memory")) return <LayersIcon size={14} />;
  if (tool.includes("skill")) return <BrainCircuit size={14} />;
  if (tool.includes("browser") || tool.includes("web")) return <MonitorIcon size={14} />;
  return <TerminalIcon size={14} />;
}

function ActivityCallDetail({
  entry,
  index,
}: {
  entry: TimelineEntry<ChatRuntimeEvent>;
  index: number;
}) {
  const runtimeEvent = entry.events[entry.events.length - 1]!;
  const detail = runtimeEvent.preview ?? runtimeEvent.summary;
  const duration = formatRuntimeDuration(entry.durationMs);
  return (
    <li className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2.5 py-2 first:pt-1 last:pb-1">
      <span className="grid h-6 w-6 place-items-center rounded bg-surface font-mono text-micro tabular-nums text-faint">
        {index + 1}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-caption font-medium text-muted">Call {index + 1}</span>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", activityTone(entry.status))} aria-hidden="true" />
          <small className="text-micro text-faint">{activityStatusLabel(entry.status)}</small>
        </div>
        {detail && detail !== entry.label && (
          <p className="mb-0 mt-0.5 line-clamp-2 text-micro leading-relaxed text-faint">{detail}</p>
        )}
        {entry.status === "failed" && runtimeEvent.errorCode && (
          <small className="mt-0.5 block font-mono text-micro text-bad">{runtimeEvent.errorCode}</small>
        )}
      </div>
      {duration && <small className="pt-0.5 font-mono text-micro tabular-nums text-faint">{duration}</small>}
    </li>
  );
}

function ActivityStep({
  group,
  index,
}: {
  group: TimelineEntryGroup<ChatRuntimeEvent>;
  index: number;
}) {
  const repeated = group.entries.length > 1;
  const lastEntry = group.entries[group.entries.length - 1]!;
  const runtimeEvent = lastEntry.events[lastEntry.events.length - 1]!;
  const detail = runtimeEvent.preview ?? runtimeEvent.summary;
  const duration = formatRuntimeDuration(lastEntry.durationMs);
  const title = activityTitle(group);
  const leading = (
    <>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded border border-border bg-surface font-mono text-micro tabular-nums text-faint">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-soft text-accent">
        <ActivityKindIcon kind={group.kind} label={group.label} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <strong className="truncate text-label font-medium text-text">{title}</strong>
          {repeated && (
            <span className="rounded bg-soft px-1.5 py-0.5 font-mono text-micro font-semibold tabular-nums text-accent">
              ×{group.entries.length}
            </span>
          )}
        </span>
        {!repeated && detail && detail !== group.label && (
          <small className="mt-0.5 block truncate text-micro text-faint">{detail}</small>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className={cn("h-1.5 w-1.5 rounded-full", activityTone(group.status))} aria-hidden="true" />
        <small className="hidden text-micro text-faint sm:inline">{activityStatusLabel(group.status)}</small>
        {!repeated && duration && (
          <small className="font-mono text-micro tabular-nums text-faint">{duration}</small>
        )}
      </span>
    </>
  );

  return (
    <li className="relative min-w-0 py-1 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-[25px] top-[17px] h-2 w-2 rounded-full ring-4 ring-bg",
          activityTone(group.status),
        )}
      />
      {repeated ? (
        <details className="group rounded border border-transparent bg-raised/35 transition-colors open:border-border open:bg-raised/70">
          <summary
            className="flex min-w-0 cursor-pointer list-none items-center gap-2.5 px-2.5 py-2.5 select-none [&::-webkit-details-marker]:hidden"
            aria-label={`${title}, ${group.entries.length} calls, ${activityStatusLabel(group.status)}`}
          >
            {leading}
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200 group-open:rotate-180"
              viewBox="0 0 16 16"
              fill="none"
            >
              <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <ol className="m-0 ml-[74px] list-none border-t border-border/70 px-3 py-1 pr-4">
            {group.entries.map((entry, callIndex) => (
              <ActivityCallDetail entry={entry} index={callIndex} key={entry.key} />
            ))}
          </ol>
        </details>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5 rounded border border-transparent px-2.5 py-2 transition-colors hover:border-border hover:bg-raised/50">
          {leading}
        </div>
      )}
    </li>
  );
}

function AgentActivityTrail({ entries }: { entries: readonly TimelineEntry<ChatRuntimeEvent>[] }) {
  const groups = groupConsecutiveTimelineEntries(entries);
  const toolCalls = entries.filter(({ kind }) => kind === "tool").length;
  return (
    <section className="my-3" aria-label={activityGroupTitle(entries)}>
      <header className="mb-2 flex min-w-0 items-center gap-2.5 px-0.5 text-caption text-muted">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-soft text-accent">
          <TerminalIcon size={13} />
        </span>
        <strong className="truncate font-medium text-muted">Agent activity</strong>
        <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
        <small className="shrink-0 font-mono text-micro tabular-nums text-faint">
          {groups.length} step{groups.length === 1 ? "" : "s"}{toolCalls > 0 ? ` · ${toolCalls} call${toolCalls === 1 ? "" : "s"}` : ""}
        </small>
      </header>
      <ol className="relative m-0 ml-[11px] grid list-none gap-0 border-l border-dotted border-border-strong p-0 pl-5">
        {groups.map((group, index) => <ActivityStep group={group} index={index} key={group.key} />)}
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

      {/*
        * The elapsed figure is passed in rather than measured by the indicator:
        * the turn's clock starts when the stream opens and has to survive a
        * reconnect, which a timer mounted here could not do. When the stream is
        * down the timer is replaced outright — a number that had stopped
        * advancing would read as a stalled turn rather than a lost connection.
        */}
      {message.status === "PENDING" && (
        <div className="mt-3" aria-live="polite">
          <LoadingState
            label={currentActivity ?? "Hermes is working"}
            variant="drive"
            elapsedMs={elapsedMs}
            {...(busy ? {} : { trailing: "reconnecting" })}
            className="w-full"
          />
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
  return <BrainCircuit {...props} />;
}

export function ChatView({
  unlocked,
  displayName,
  administratorReadiness,
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
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<HermesRuntimeCatalogue | null>(null);
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState(() => pickChatSuggestions());
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [modelDeployments, setModelDeployments] = useState<ModelDeployment[]>([]);
  // Whether the empty catalogue above is a refusal rather than an absence. See
  // the context readout, which is the only thing that reads it.
  const [modelCatalogueDenied, setModelCatalogueDenied] = useState(false);
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
  // Whether a submit is in flight, held where a same-tick second submit can
  // see it. See `submit` for why the state flag beside it is not enough.
  const sending = useRef(false);
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
      setModelDeployments([]);
      setModelCatalogueDenied(false);
      return;
    }
    let current = true;
    setLoading(true);
    void Promise.all([
      getChatConversations(),
      getAgentProfiles(false),
      /*
       * Optional, and refused far more often than it fails: `models:read` is an
       * administrator scope, so every employee identity lands in this catch.
       * Swallowed as before — a Session must not end because a footnote was
       * denied — but no longer indistinguishable from a catalogue that is
       * simply empty, which is what the composer used to report it as.
       */
      getModelDeployments().catch((cause) => {
        const denied = cause instanceof OrcaSynapseApiError && (cause.status === 401 || cause.status === 403);
        if (current) setModelCatalogueDenied(denied);
        return { items: [] };
      }),
    ])
      .then(async ([{ items }, profileList, modelList]) => {
        if (!current) return;
        setConversations(items);
        setModelDeployments(modelList.items);
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

  /*
   * Picks up a turn this tab did not start.
   *
   * Every other path into a conversation begins here -- somebody types, the
   * stream opens, the transcript follows it -- so nothing ever asked the server
   * whether a conversation had moved on its own. A scheduled turn does exactly
   * that: the dispatcher submits it in the API process, and an operator watching
   * the thread saw nothing at all. Worse than nothing, in fact: their next
   * message was answered with the scheduled exchange in the model's context and
   * absent from the transcript in front of them, so the reply did not follow
   * from what they could see.
   *
   * The conversation list is the cheap question -- it carries `messageCount`
   * without any message bodies -- and only a real divergence pays for a full
   * refetch. Suspended while a stream is running, because the stream is already
   * the more precise answer to the same question, and it re-runs on `busy`
   * clearing so a turn that landed during one is picked up immediately after.
   *
   * Fifteen seconds matches the workspace poll in `app.tsx` deliberately: this
   * is the same kind of background reconciliation, and two different cadences
   * would be two things to reason about.
   */
  useEffect(() => {
    if (!unlocked || !active || busy) return;
    const conversationId = active.id;
    let cancelled = false;
    const check = async () => {
      try {
        const items = await getChatConversations();
        if (cancelled) return;
        setConversations(items.items);
        const summary = items.items.find(({ id }) => id === conversationId);
        if (!summary || summary.messageCount === active.messages.length) return;
        const refreshed = await getChatConversation(conversationId);
        if (cancelled) return;
        setActive((current) => current?.id === conversationId ? refreshed : current);
      } catch {
        // A background reconciler must never surface an error over a
        // conversation the operator is reading; the next tick tries again.
      }
    };
    const timer = window.setInterval(() => void check(), OUT_OF_BAND_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [unlocked, active, busy]);

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
          /*
           * A stream that closed cleanly with the run still PENDING is the same
           * stuck state the catch below guards against, reached by the other
           * door: the subscription ends, nothing retries, and the transcript
           * shows "reconnecting" for a run that is still going. Rejoining is the
           * only correct reading -- the run did not finish, so neither should
           * following it. Bounded by the same retry counter, so a server that
           * closes immediately every time still gives up and says so.
           */
          const settled = refreshed.messages.find(({ id }) => id === messageId);
          if (settled?.status === "PENDING" && retry < STREAM_RECONNECT_LIMIT) {
            retry += 1;
            cursor = settled.lastEventCursor;
            continue;
          }
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
          /*
           * Only a refetch that *succeeded* may end the loop.
           *
           * This used to test `!pending`, which is also what a failed refetch
           * produces -- so the two calls failing together, which is the ordinary
           * shape of a brief network drop since both are same-origin fetches
           * issued back to back, was read as "the run finished" on the very
           * first attempt. The loop returned, `busy` cleared, and no dependency
           * changed, so nothing retried: the transcript sat on "reconnecting"
           * for a live run, Stop unmounted because `working` was false, and a
           * new message was refused 409 until the pending row went stale an hour
           * later. Reopening the conversation did not help either, because the
           * effect's deps turn on the pending message's id, which had not
           * changed.
           *
           * A null refetch now falls through to the bounded backoff, which is
           * what it always should have done: the server is unreachable, which is
           * the condition this loop exists to survive.
           */
          if (refreshed && (!pending || pending.status !== "PENDING")) {
            await refreshList().catch(() => undefined);
            return;
          }
          if (retry >= STREAM_RECONNECT_LIMIT) {
            // The message is still PENDING -- or could not be read at all -- and
            // the transport still will not hold, which after this many rounds is
            // a condition that does not clear itself. Whatever the server said
            // is the useful half.
            setCurrentActivity(null);
            setError(`Lost contact with this Hermes run after ${STREAM_RECONNECT_LIMIT} attempts. ${
              cause instanceof Error ? cause.message : "The event stream could not be re-opened."
            } Reopen the conversation to pick the answer up from where it stopped.`);
            await refreshList().catch(() => undefined);
            return;
          }
          // Unchanged when the refetch failed: resuming from the last cursor the
          // server confirmed replays at worst, where resuming from null would
          // re-send the whole run.
          if (pending) cursor = pending.lastEventCursor;
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
    setSuggestions(pickChatSuggestions());
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
    /*
     * `sending` is a ref because `working` is state. Two submits dispatched
     * before React commits — a double Enter, or a keystroke racing a click —
     * both read `working` as false, and the second came back 409 whose catch
     * restored the draft: the message was sent *and* back in the composer. A
     * ref closes in the same tick it is set, which is the only thing that can.
     */
    if (!content || sending.current || working || !unlocked || active?.status === "ARCHIVED") return;
    if (administratorReadiness?.ready === false) {
      setError(administratorReadiness.detail);
      return;
    }
    if (profiles.length === 0) {
      setError("Create and activate an Agent Profile before starting a Session.");
      return;
    }
    sending.current = true;
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
        // Adopted before the message is sent, so Stop has something to cancel
        // for the first turn too. It carries no pending message yet, so the
        // stream effect looks at it and does nothing.
        setActive(conversation);
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
      sending.current = false;
      setSubmitting(false);
    }
  };

  const requestStop = async () => {
    // `working` rather than `busy`, matching the control: a run submitted but
    // not yet streaming is exactly the one an operator most wants back.
    if (!active || !working || currentActivity === "Cancellation requested") return;
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
      <div className="px-[clamp(16px,3vw,24px)] pb-16 pt-9">
        <LockedScreen
          title="Session"
          kicker="Workspace"
          mark="AI"
          headline="Sign in to OrcaSynapse"
          reason="Sign in with the account an administrator created for you, or ask them to create one."
          actionLabel="Sign in"
          onAction={onSignIn}
          secondaryLabel="Administrator setup"
          onSecondary={onConfigure}
        />
      </div>
    );
  }

  const assistantResponses = active?.messages.filter(({ role }) => role === "ASSISTANT") ?? [];
  const latestContextSample = [...assistantResponses]
    .reverse()
    // A failed gateway attempt can leave a response with zero token telemetry.
    // It is not evidence that the model had an empty context; walk back to the
    // latest response that actually measured a prompt instead.
    .find(({ inputTokens }) => inputTokens !== null && inputTokens > 0);
  const contextTokens = latestContextSample?.inputTokens ?? null;
  const contextDeployment = modelDeployments.find(({ modelAlias, status }) => (
    modelAlias === active?.modelAlias && status === "ACTIVE"
  )) ?? modelDeployments.find(({ modelAlias }) => modelAlias === active?.modelAlias);
  const contextWindowTokens = contextDeployment?.contextWindowTokens ?? null;
  /*
   * Unclamped. `Math.min(100, …)` turned every overshoot into exactly "100%",
   * which reads as a window that is genuinely full — and what it hid is the
   * one number that says the *configured* window is stale, since a prompt
   * cannot really exceed the window the model accepted it into.
   */
  const contextUsagePercent = contextTokens !== null && contextWindowTokens !== null
    ? Math.round((contextTokens / contextWindowTokens) * 100)
    : null;
  /*
   * The other two overstatements, both in the words rather than the number.
   *
   * `contextTokens` is the prompt the *previous* turn measured, so it always
   * understates the message being typed — and the label said only "Context",
   * which a reader can only take for the state of the box in front of them.
   *
   * And the window size comes from the model catalogue, which needs the
   * `models:read` administrator scope: an employee identity 401s into the empty
   * catalogue every time, so "not available" was the only state most people
   * ever saw, reporting an authorization result as missing data.
   */
  const contextWindowUnreadable = contextWindowTokens === null && modelCatalogueDenied;
  const contextUsageLabel = contextTokens === null
    ? "Context usage is not available"
    : contextUsagePercent !== null
      ? `Context usage ${contextUsagePercent}%`
      : `Context usage ${contextTokens.toLocaleString()} tokens; the context window size ${
        contextWindowUnreadable ? "needs administrator access" : "is unavailable"}`;
  const contextUsageTitle = contextTokens === null
    ? "Hermes has not reported prompt token usage for a completed response."
    : contextWindowTokens === null
      ? `Last turn's prompt measured ${contextTokens.toLocaleString()} tokens. ${contextWindowUnreadable
        ? "The context window size comes from the model catalogue, which needs an administrator scope this session does not hold."
        : "The configured context window is not available."}`
      : `Last turn's prompt measured ${contextTokens.toLocaleString()} of ${contextWindowTokens.toLocaleString()} tokens (${contextUsagePercent}%).${
        (contextUsagePercent ?? 0) > 100
          ? " That is larger than the configured window, so the configured size is out of date."
          : ""
      } It measures the prompt of the previous turn, not the draft below it, and not Hermes persistent memory.`;
  const profileAvailable = profiles.length > 0;
  const routeReady = administratorReadiness?.ready !== false && profileAvailable;
  const chatReady = routeReady && active?.status !== "ARCHIVED";
  const charactersLeft = COMPOSER_LIMIT - draft.length;
  const sendable = draft.trim().length > 0 && chatReady;
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
  // Every modal, so the floating "Jump to latest" control stays behind the
  // backdrop rather than over it. The Schedules dialog was added without being
  // added here, which is the failure this shape invites -- a list that has to be
  // extended by hand each time a dialog is introduced.
  const dialogOpen = skillsOpen
    || (schedulesOpen && active !== null)
    || (confirmDelete && active !== null);

  return (
    /*
     * `m-0 w-full max-w-none` keeps the session workspace edge-to-edge inside
     * the shell. The page used to centre every view in a 1380px column; Chat
     * was the exception, and the rest of the workspace now follows it.
     */
    <section className="m-0 grid h-full w-full max-w-none grid-cols-1 bg-bg lg:grid-cols-[288px_minmax(0,1fr)]">
      <aside
        className={cn(
          "min-w-0 flex-col overflow-x-hidden border-r border-border bg-bg px-3 pb-3 pt-3",
          historyOpen ? "flex" : "hidden lg:flex",
        )}
      >
        <h1 className="sr-only">Session</h1>
        <div className="mb-3 flex min-w-0 items-center justify-between gap-3 px-1.5 pt-0.5">
          <div className="min-w-0">
            <strong className="block font-display text-[13px] font-semibold text-text">Conversations</strong>
            <span className="mt-0.5 block text-micro text-faint">Hermes workspace history</span>
          </div>
          <span
            className="grid h-6 min-w-6 shrink-0 place-items-center rounded-pill border border-border bg-bg px-1.5 font-mono text-micro font-semibold tabular-nums text-muted"
            aria-label={`${conversations.length} conversations`}
          >
            {conversations.length}
          </span>
        </div>
        <Button variant="default" className="mb-2.5 w-full" onClick={newConversation}>
          <Plus aria-hidden="true" />
          New conversation
        </Button>
        <label className="relative mb-2 block">
          <span className="sr-only">Search conversations</span>
          <svg className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-faint" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.8" cy="10.8" r="6.3" />
            <path d="m16 16 4 4" />
          </svg>
          <Input
            type="search"
            className="h-9 border-border bg-bg pl-9 pr-3 text-caption shadow-none focus:bg-surface"
            value={historyFilter}
            onChange={(event) => setHistoryFilter(event.target.value)}
            placeholder="Search conversations"
          />
        </label>
        <div className="grid min-h-0 flex-1 content-start gap-1.5 overflow-x-hidden overflow-y-auto pr-0.5" aria-label="Conversation history">
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
            <section key={group.key} className="grid content-start gap-1.5">
              {/*
                * Level 3, deliberately. The sr-only h1 in this rail is what
                * closes an open menu when clicked, and a second level-1 heading
                * would make that target ambiguous.
                */}
              <h3 className="sticky top-0 z-[1] flex items-center gap-2 bg-bg px-1.5 pb-2 pt-4 text-micro font-semibold uppercase tracking-[0.1em] text-faint">
                <span>{group.label}</span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </h3>
          {group.items.map((conversation) => (
            <Button
              variant="ghost"
              key={conversation.id}
              /*
               * `size="auto"` is what makes this row two lines tall, and it was
               * missing. The default size is `h-9`, height and padding are
               * different properties, so no `py-*` written here ever competed
               * with it: the row stayed clamped at 36px while its title and
               * preview needed ~67px, and the rail read as cramped because the
               * rows were clipped rather than because they were tight. That is
               * exactly the case the `auto` size exists for -- see its comment
               * in `components/ui/button.tsx` -- and it is invisible to both a
               * diff and the suite, since jsdom implements no layout and
               * reports the padding as applied.
               */
              size="auto"
              aria-current={active?.id === conversation.id ? "true" : undefined}
              className={cn(
                "relative grid w-full grid-cols-1 items-start gap-1.5 rounded-card border px-2.5 py-3 text-left transition-all duration-150",
                active?.id === conversation.id
                  ? "border-accent/30 bg-soft shadow-card"
                  : "border-transparent hover:border-border hover:bg-raised/70",
              )}
              onClick={() => void selectConversation(conversation.id)}
            >
              {/*
                * Title and time share the first line, preview owns the second.
                *
                * This rail is narrow, and the row used to spend 40px of it on a
                * 30px speech-bubble that was `aria-hidden` and identical on every
                * item -- decoration priced in the one dimension the content was
                * short of. The title truncated at roughly two dozen characters,
                * and the line beneath it packed a fixed-width timestamp, a dot
                * and the preview into what was left, so the preview arrived at
                * about twenty. Two truncated strings, stacked, neither readable.
                *
                * The timestamp is the only fixed-width thing here, so it goes to
                * the end of the title line where it costs the title a known
                * amount and costs the preview nothing.
                *
                * The vertical rhythm is set in four places at once -- row
                * padding, the row's own line gap, the gap between rows and the
                * date heading -- because raising any one of them alone changes
                * a proportion rather than the density. Padding on its own makes
                * taller rows no further apart; gap on its own spreads rows that
                * are each still cramped. All four move together, so a row goes
                * from ~55px to ~66px and the distance between two rows from
                * 20px to 30px while the 5:1 ratio between them is preserved.
                *
                * The proportion is what an unselected row has instead of a
                * border: it draws `border-transparent`, so nothing marks where
                * one conversation ends except the fact that its two lines sit
                * closer to each other than to anything else.
                */}
              <span className="flex min-w-0 items-baseline gap-2">
                <strong className={cn(
                  "min-w-0 flex-1 truncate text-[12.5px] text-text",
                  active?.id === conversation.id ? "font-semibold" : "font-medium",
                )}>{conversation.title}</strong>
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
                  {conversation.status === "ARCHIVED" ? "Archived" : formatConversationTime(conversation.lastMessageAt)}
                </span>
              </span>
              <span className="min-w-0 truncate text-[10.5px] leading-[1.5] text-faint">
                {conversation.lastMessagePreview ?? conversation.profileName ?? conversation.modelAlias}
              </span>
            </Button>
          ))}
            </section>
          ))}
        </div>
      </aside>

      <div className="relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        {/* This bar keeps what only it can say: which conversation is open,
            which agent owns a new one, and whether that route is usable. */}
        <header className="flex min-h-[64px] items-center gap-4 bg-bg px-5 py-2.5">
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
              <span className="mt-1 flex items-center gap-1.5 truncate text-caption text-faint">
                <span
                  aria-hidden="true"
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", active.status === "ACTIVE" ? "bg-good" : "bg-faint")}
                />
                <span className="truncate">{active.profileName ?? "Agent profile"}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{active.messages.length} messages</span>
              </span>
            )}
          </div>
          <div
            className="flex min-w-0 shrink-0 items-center gap-1 rounded-card border border-border bg-surface p-1 shadow-card"
            aria-label="Conversation runtime"
          >
            {!active && (
              <div
                className="relative hidden h-9 min-w-0 items-center rounded border border-transparent bg-transparent transition-colors focus-within:border-accent sm:flex"
                data-agent-selector
              >
                <span className="pointer-events-none absolute left-2.5 top-1/2 z-[1] grid h-6 w-6 -translate-y-1/2 place-items-center rounded bg-soft text-accent" data-agent-selector-icon>
                  <RobotIcon size={15} />
                </span>
                <Select
                  // `ring-0` because the wrapper above owns the focus border:
                  // shadcn's select base carries `focus-visible:ring-2`, which
                  // otherwise draws a second rectangle inside the first.
                  className="h-9 w-[216px] border-0 bg-transparent pl-10 pr-2 text-caption font-semibold shadow-none focus-visible:outline-offset-0 focus-visible:ring-0"
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
              <div className="flex h-9 items-center gap-2 rounded border border-transparent bg-transparent px-2.5 text-caption font-semibold text-muted">
                <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", working ? "anim-live bg-accent" : "bg-good")} />
                <span className="whitespace-nowrap">{working ? `Working · ${(streamElapsedMs / 1_000).toFixed(1)} s` : "Ready"}</span>
              </div>
            ) : (
              <Button
                variant="ghost"
                className="flex h-9 items-center gap-2 rounded border border-transparent bg-warn/10 px-2.5 text-left text-warn transition-colors hover:border-warn/35 hover:bg-warn/20"
                onClick={openReadiness}
                aria-label="Open agent setup: setup required"
              >
                <span className="grid h-6 w-6 place-items-center rounded bg-warn/10" aria-hidden="true">
                  <RobotIcon size={14} />
                </span>
                <strong className="whitespace-nowrap text-caption font-semibold">Setup required</strong>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 8h9M9 4l4 4-4 4" />
                </svg>
              </Button>
            )}

          {active && !renaming && (
            <div className="relative ml-0.5 flex items-center gap-0.5 border-l border-border pl-1" ref={moreMenu}>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-2.5"
                disabled={working || loading}
                onClick={() => void openSkills()}
              >
                <LayersIcon size={14} />
                Skills
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                aria-label="More conversation actions"
                title="More actions"
                disabled={working || loading}
                onClick={() => setMoreOpen((open) => !open)}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <circle cx="3" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="13" cy="8" r="1.2" />
                </svg>
              </Button>
              {moreOpen && (
                <div
                  className="absolute right-0 top-[calc(100%+6px)] z-40 grid min-w-[176px] gap-0.5 rounded border border-border-strong bg-raised p-1.5 shadow-overlay"
                  role="menu"
                >
                  {[
                    { label: "Rename", run: () => { setTitleDraft(active.title); setRenaming(true); } },
                    { label: "Schedule", run: () => setSchedulesOpen(true) },
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
          </div>
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
                {/*
                  * The greeting carries its own bottom margin because the
                  * paragraph that used to follow it is gone. That paragraph
                  * explained that every response is a governed Agent Run and
                  * which of the profile's settings applied -- the machinery,
                  * described to someone who came here to ask a question, with
                  * the profile it referred to already named in the header a few
                  * pixels away. Its `mb-6` was the only gap between the heading
                  * and what follows, so removing the text without moving the
                  * spacing left the two touching.
                  */}
                <h2 className="mb-6 mt-0 font-display text-[30px] font-semibold leading-[1.2] tracking-[-0.03em] text-text">
                  Ask anything about
                  <br />
                  your workspace.
                </h2>
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
                <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Suggested prompts">
                  {suggestions.map((suggestion) => (
                    <Button
                      variant="outline"
                      size="auto"
                      className="w-full flex-col items-start justify-start gap-2 whitespace-normal border-border bg-raised text-left font-normal hover:border-accent hover:bg-soft hover:text-text"
                      key={suggestion.label}
                      type="button"
                      disabled={!routeReady}
                      onClick={() => setDraft(suggestion.prompt)}
                    >
                      <span className="flex w-full items-start justify-between gap-3">
                        <span className="min-w-0 text-body font-semibold leading-snug text-text">{suggestion.label}</span>
                        <ArrowUpRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                      </span>
                      <span className="text-caption font-medium leading-snug text-muted">{suggestion.sub}</span>
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              active.messages.map((message) => (
                /*
                 * The person's turn is a content-sized bubble and the agent's is not.
                 * That asymmetry is the only thing that lets the eye find where
                 * an exchange begins without reading any of the text, which on a
                 * long governed transcript is most of what makes it navigable.
                 */
                <article
                  className={cn(
                    /*
                     * The design's asymmetry, sharpened: the person's turn is a
                     * compact right-aligned soft-violet bubble; the agent's turn is an open row
                     * under the mark. The eye finds where an exchange begins
                     * without reading a word, which on a long governed
                     * transcript is most of what makes it navigable.
                     */
                    "group",
                    message.role === "USER"
                      ? "relative mb-7 mt-2 ml-auto flex w-fit max-w-[88%] items-end justify-end gap-2.5 sm:max-w-[72%]"
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
                  <div className={cn(
                    "min-w-0",
                    message.role === "USER"
                      ? "min-w-[72px] rounded-card border border-accent/15 bg-soft px-4 py-2.5 shadow-card"
                      : "",
                  )}>
                    {/* The profile remains visible because it describes the
                        assistant's governed behavior. The singular runtime's
                        model alias does not: repeating it above every answer
                        adds implementation noise without resolving ambiguity. */}
                    <div className={cn(
                      "flex items-center justify-between gap-3",
                      message.role === "USER" ? "absolute -top-6 right-1" : "min-h-[20px]",
                    )}>
                      <div
                        className={cn(
                          "flex min-w-0 items-baseline gap-2 transition-opacity duration-150",
                          message.role === "USER"
                            ? "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                            : "opacity-100",
                        )}
                      >
                        <strong className="text-caption font-semibold text-muted">
                          {message.role === "USER" ? "You" : (active.profileName ?? "Agent")}
                        </strong>
                        <time className="font-mono text-micro text-faint" dateTime={message.createdAt}>
                          {formatMessageTime(message.createdAt)}
                        </time>
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
                      ? <p className="m-0 whitespace-pre-wrap break-words text-[14px] leading-[1.65] text-text">{message.content}</p>
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
                  {message.role === "USER" && (
                    <span
                      aria-label={`${sessionOwner} avatar`}
                      className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-pill border border-accent/20 bg-accent/10 font-display text-[10px] font-bold uppercase tracking-[0.03em] text-accent"
                      data-avatar-slot="user"
                      title={sessionOwner}
                    >
                      {sessionInitials}
                    </span>
                  )}
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
              /*
               * One surface, not a bordered box with a control strip bolted
               * under it. The shell holds no padding above the field at all:
               * the textarea and its hidden measuring copy carry a matched
               * inset of their own (`.chat-composer-field`, `styles.css`), so
               * the click target reaches the top edge and the caret still sits
               * where the placeholder did.
               */
              "chat-composer group grid gap-1 rounded-card border px-1.5 pb-1.5 pt-1",
              /*
               * A control that is off should look off. This one was genuinely
               * disabled and entirely normal-looking, so the only way to find
               * out was to click it and watch nothing happen; the reason lived
               * in placeholder text, which vanishes the moment anyone types.
               *
               * Off is stated in tokens rather than as `opacity-60` on the
               * shell. The veil dimmed the placeholder that carries the reason
               * along with everything else: measured in a browser it came to
               * 2.6:1 in both themes, against the 4.5:1 this palette is built
               * to clear. Dropping to the page colour and casting nothing says
               * the same thing to the eye and leaves the words legible.
               */
              chatReady
                ? "border-border-strong bg-surface"
                : "is-off cursor-not-allowed border-border bg-bg",
            )}
            onSubmit={submit}
          >
            {/*
              * The grid that grows with the draft. `data-composer-value` is the
              * whole mechanism: the stylesheet renders it as a hidden copy of
              * the text, and the copy is what has a height a textarea cannot
              * report without an inline style the CSP forbids.
              */}
            <div className="chat-composer-field text-read" data-composer-value={draft}>
              <Textarea
                /*
                 * The utility layer deliberately states no box here — `p-0`,
                 * `min-h-0`, `resize-none`. The textarea and the hidden copy
                 * that measures it have to be the same box down to the wrap
                 * points, and a pseudo-element cannot take classes, so one rule
                 * in `styles.css` sizes both. Delete that rule and this control
                 * collapses visibly rather than drifting a few pixels.
                 *
                 * `disabled:opacity-100` for the same reason the shell above
                 * no longer dims: the primitive's `disabled:opacity-50` lands
                 * on the placeholder, and the placeholder is the only thing on
                 * screen that says why the box is dead. Measured in a browser
                 * on the dead composer: half-strength `faint` comes to 2.19:1
                 * against the surface behind it, full strength to 5.25.
                 */
                className="w-full min-h-0 resize-none border-0 bg-transparent p-0 text-read text-text shadow-none placeholder:text-faint focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-100"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  /*
                   * Enter means "accept the candidate" while an IME is open,
                   * and it arrives as an ordinary keydown. Without this guard a
                   * Japanese, Chinese or Korean draft left mid-conversion on
                   * every candidate confirmation — several times per sentence.
                   *
                   * Both readings, because browsers disagree: Chromium and
                   * Firefox set `isComposing` on the native event, while Safari
                   * and older Chromium report the legacy `keyCode === 229` for
                   * the whole composition.
                   */
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={active?.status === "ARCHIVED" ? "Restore this conversation to continue" : chatReady ? `Message ${selectedAgentName}` : "Finish the required setup to start a Session"}
                rows={1}
                maxLength={COMPOSER_LIMIT}
                /*
                 * Dead only while the route is, never while a turn is running.
                 * `working` used to be in here, and a disabled control loses
                 * focus: the caret left the composer the instant Enter was
                 * pressed and every turn ended with nowhere to type. The turn
                 * is still protected — `submit` refuses while one is in flight
                 * — so the box stays live and the next message can be written
                 * while the answer arrives.
                 */
                disabled={!chatReady}
                aria-label="Chat message"
              />
            </div>
            {/* `pl-3` puts the agent name on the same left edge as the first
                character of the draft: the field's own inset is 12px and the
                shell adds 6px, so anything less reads as a second margin. */}
            <div className="flex min-w-0 items-center justify-between gap-3 pl-3">
              <div className="flex min-w-0 items-center gap-2 text-caption text-faint">
                <span className="flex min-w-0 items-center gap-1.5" title={`This Session runs on ${selectedAgentName}`}>
                  <RobotIcon size={14} aria-hidden="true" className="shrink-0 text-accent" />
                  <span className="max-w-[11rem] truncate font-medium text-muted">{selectedAgentName}</span>
                </span>
                <span aria-hidden="true" className="hidden h-1 w-1 shrink-0 rounded-full bg-border-strong sm:block" />
                <span
                  className="hidden min-w-0 items-center gap-1.5 sm:flex"
                  aria-label={contextUsageLabel}
                  title={contextUsageTitle}
                >
                  <LayersIcon size={12} aria-hidden="true" className="shrink-0 text-faint" />
                  <span>Context (last turn)</span>
                  <strong className={cn(
                    "font-mono font-semibold tabular-nums",
                    contextUsagePercent !== null && contextUsagePercent >= 80 ? "text-warn" : "text-muted",
                  )}>
                    {contextUsagePercent !== null
                      ? `${contextUsagePercent}%`
                      : contextTokens !== null
                        ? `${formatCompactTokenCount(contextTokens)} tokens`
                        : "—"}
                  </strong>
                </span>
                {/*
                  * The keyboard contract, offered while someone is typing and
                  * out of the way the rest of the time. It is the least
                  * important thing on the row and was competing with the agent
                  * identity for the same eye.
                  */}
                <span className="hidden items-center gap-2 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 md:flex">
                  <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-border-strong" />
                  <span>Shift + Enter for a new line</span>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                {/*
                  * A cap nobody is near is not information. The old counter sat
                  * on every draft reading "0 / 32,000"; this one appears for
                  * the last fifth of the allowance and turns amber for the last
                  * twentieth, which is the only span where it changes anything.
                  */}
                {charactersLeft <= COMPOSER_COUNTER_FROM && (
                  <span
                    aria-label={`${charactersLeft.toLocaleString()} characters left before the message limit`}
                    className={cn(
                      "font-mono text-micro tabular-nums",
                      charactersLeft <= COMPOSER_COUNTER_WARN ? "text-warn" : "text-faint",
                    )}
                  >
                    {charactersLeft.toLocaleString()} left
                  </span>
                )}
                {/*
                  * `working`, not `busy`. Between the submit leaving and the
                  * stream attaching, `submitting` is true and `busy` is not:
                  * Send rendered disabled and Stop did not render at all, so a
                  * message already on its way to Hermes had no cancel.
                  */}
                {working ? (
                  <Button
                    variant="danger"
                    size="sm"
                    className="h-9 px-3.5"
                    disabled={currentActivity === "Cancellation requested"}
                    onClick={() => void requestStop()}
                  >
                    {currentActivity === "Cancellation requested" ? "Stopping…" : "Stop"}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    type="submit"
                    size="icon"
                    /*
                     * A faded violet disc reads as a violet disc that needs a
                     * better monitor. With nothing to send the control steps
                     * back to the surface it sits on instead of dimming, which
                     * is the difference between "not yet" and "broken".
                     */
                    className={cn(
                      "shrink-0 rounded-full",
                      !sendable && "border-border-strong bg-raised text-faint hover:bg-raised disabled:opacity-100",
                    )}
                    disabled={!sendable}
                    aria-label="Send message"
                  >
                    <ArrowUp aria-hidden="true" className="h-4 w-4" />
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
          {/*
            * `text-caption` rather than `text-micro`: the micro step carries
            * 0.08em of tracking because it is for labels sitting over figures,
            * and a full sentence set in it reads as spaced-out fine print.
            */}
          <p className={cn(THREAD_MEASURE, "mb-0 mt-2 text-center text-caption leading-relaxed text-faint")}>
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
        icon={Sparkles}
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
        open={schedulesOpen && active !== null}
        onClose={() => setSchedulesOpen(false)}
        icon={CalendarClock}
        kicker="Unattended turns"
        title="Run this conversation on a schedule"
        description="OrcaSynapse posts the prompt and the agent answers in this thread."
      >
        {active && <ChatSchedules conversationId={active.id} />}
      </Dialog>

      <Dialog
        open={confirmDelete && active !== null}
        onClose={() => setConfirmDelete(false)}
        icon={Trash2}
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
