/**
 * Collapses a run's raw events into the things that actually happened.
 *
 * The activity list renders one row per event, so a single tool call that
 * started, reported progress twice and completed reads as four unrelated
 * entries -- and a reader cannot tell which progress belonged to which call, or
 * that the second call failed rather than the first. `toolCallKey` was added to
 * the event log for exactly this and has never been used by the interface.
 *
 * Grouping happens here rather than in the renderer because the interesting
 * part is a state machine over a sequence, and that is worth testing without a
 * DOM.
 */

/** The shape this needs, structural so the contract type satisfies it. */
export interface TimelineEvent {
  id: string;
  type: string;
  toolCallKey: string | null;
  toolName: string | null;
  summary: string | null;
  preview: string | null;
  text: string | null;
  status: string | null;
  errorCode: string | null;
  durationMs: number | null;
  occurredAt: string;
}

export type TimelineKind = "tool" | "subagent" | "approval" | "reasoning" | "lifecycle";
/**
 * `running` is the honest answer for a call whose terminal event has not
 * arrived, including one whose run died mid-flight. Nothing here invents a
 * failure the log does not record.
 */
export type TimelineStatus = "running" | "completed" | "failed";

export interface TimelineEntry<E extends TimelineEvent = TimelineEvent> {
  /** Stable across re-renders: the call key where there is one, else the id. */
  key: string;
  kind: TimelineKind;
  label: string;
  status: TimelineStatus;
  /** Every event that belongs to this entry, in the order they arrived. */
  events: E[];
  /** Reported by the runtime on the terminal event, never computed here. */
  durationMs: number | null;
}

function kindOf(type: string): TimelineKind {
  if (type.startsWith("TOOL_")) return "tool";
  if (type.startsWith("SUBAGENT_")) return "subagent";
  if (type === "APPROVAL_REQUIRED") return "approval";
  if (type === "REASONING_REPORTED") return "reasoning";
  return "lifecycle";
}

function statusOf(type: string, previous: TimelineStatus): TimelineStatus {
  if (type === "TOOL_FAILED" || type === "SUBAGENT_FAILED") return "failed";
  if (type === "TOOL_COMPLETED" || type === "SUBAGENT_COMPLETED") return "completed";
  return previous;
}

/**
 * One entry per thing that happened, in the order it started.
 *
 * Events sharing a `toolCallKey` collapse into one entry; everything else keeps
 * an entry of its own. Order is first-appearance, so a long-running call stays
 * where it began rather than jumping down the list each time it reports
 * progress -- which is what makes the list readable while a run is live.
 */
export function groupRuntimeEvents<E extends TimelineEvent>(events: readonly E[]): TimelineEntry<E>[] {
  const byKey = new Map<string, TimelineEntry<E>>();
  const ordered: TimelineEntry<E>[] = [];

  for (const event of events) {
    const kind = kindOf(event.type);
    const key = event.toolCallKey ?? event.id;
    const existing = event.toolCallKey ? byKey.get(key) : undefined;

    if (existing) {
      existing.events.push(event);
      existing.status = statusOf(event.type, existing.status);
      // The runtime reports duration on the event that ends the call, so a
      // later value always supersedes an earlier one.
      if (event.durationMs !== null) existing.durationMs = event.durationMs;
      // A start may arrive with no name where a later event carries one.
      if (existing.label === "tool" && event.toolName) existing.label = event.toolName;
      continue;
    }

    const entry: TimelineEntry<E> = {
      key,
      kind,
      label: event.toolName ?? (kind === "tool" ? "tool" : event.type),
      status: statusOf(event.type, "running"),
      events: [event],
      durationMs: event.durationMs,
    };
    if (event.toolCallKey) byKey.set(key, entry);
    ordered.push(entry);
  }

  return ordered;
}
