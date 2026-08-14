import { describe, expect, it } from "vitest";
import { groupRuntimeEvents, summariseTimeline, type TimelineEvent } from "./timeline.js";

let sequence = 0;
const event = (over: Partial<TimelineEvent>): TimelineEvent => ({
  id: `e${(sequence += 1)}`, type: "TOOL_STARTED", toolCallKey: null, toolName: null,
  summary: null, preview: null, text: null, status: null, errorCode: null,
  durationMs: null, occurredAt: "2026-08-09T12:00:00.000Z", ...over,
});

describe("groupRuntimeEvents", () => {
  it("collapses one tool call's lifecycle into a single entry", () => {
    /*
     * The defect this exists for: four rows for one call, with no way to tell
     * which progress belonged to which call.
     */
    const entries = groupRuntimeEvents([
      event({ type: "TOOL_STARTED", toolCallKey: "status#1", toolName: "system.status" }),
      event({ type: "TOOL_PROGRESS", toolCallKey: "status#1", toolName: "system.status" }),
      event({ type: "TOOL_PROGRESS", toolCallKey: "status#1", toolName: "system.status" }),
      event({ type: "TOOL_COMPLETED", toolCallKey: "status#1", toolName: "system.status", durationMs: 812 }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "status#1", kind: "tool", label: "system.status", status: "completed", durationMs: 812,
    });
    expect(entries[0]?.events).toHaveLength(4);
  });

  it("keeps a retry of the same tool as a separate call", () => {
    // Two calls to one tool are two things that happened. Merging them is how a
    // reader loses the fact that the second one failed.
    const entries = groupRuntimeEvents([
      event({ type: "TOOL_STARTED", toolCallKey: "search#1", toolName: "search" }),
      event({ type: "TOOL_COMPLETED", toolCallKey: "search#1", toolName: "search" }),
      event({ type: "TOOL_STARTED", toolCallKey: "search#2", toolName: "search" }),
      event({ type: "TOOL_FAILED", toolCallKey: "search#2", toolName: "search", errorCode: "TOOL_TIMEOUT" }),
    ]);

    expect(entries.map(({ key, status }) => `${key}:${status}`)).toEqual(["search#1:completed", "search#2:failed"]);
  });

  it("repairs tool events stored with a different synthesized key per event", () => {
    // ai-v3.16.0 generated these broken keys. Existing audit rows must become
    // legible immediately rather than waiting for a database rewrite.
    const entries = groupRuntimeEvents([
      event({ type: "TOOL_STARTED", toolCallKey: "memory#event-1", toolName: "memory" }),
      event({ type: "TOOL_COMPLETED", toolCallKey: "memory#event-2", toolName: "memory" }),
      event({ type: "TOOL_STARTED", toolCallKey: "memory#event-3", toolName: "memory" }),
      event({ type: "TOOL_COMPLETED", toolCallKey: "memory#event-4", toolName: "memory" }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.map(({ status, events }) => ({ status, events: events.length }))).toEqual([
      { status: "completed", events: 2 },
      { status: "completed", events: 2 },
    ]);
  });

  it("holds a long call in the place it started", () => {
    /*
     * First-appearance order, not last-event order. A call that reports progress
     * while other things happen must not walk down the list on every update --
     * a live run would reshuffle under the reader's eyes.
     */
    const entries = groupRuntimeEvents([
      event({ type: "TOOL_STARTED", toolCallKey: "slow#1", toolName: "slow" }),
      event({ type: "REASONING_REPORTED", text: "considering" }),
      event({ type: "TOOL_PROGRESS", toolCallKey: "slow#1", toolName: "slow" }),
      event({ type: "TOOL_COMPLETED", toolCallKey: "slow#1", toolName: "slow" }),
    ]);

    expect(entries.map(({ kind }) => kind)).toEqual(["tool", "reasoning"]);
  });

  it("says running for a call whose end never arrived", () => {
    // A run that died mid-tool leaves an open call. "Running" is what the log
    // records; inventing a failure would be a claim the log does not make.
    const entries = groupRuntimeEvents([
      event({ type: "TOOL_STARTED", toolCallKey: "open#1", toolName: "fetch" }),
      event({ type: "TOOL_PROGRESS", toolCallKey: "open#1", toolName: "fetch" }),
    ]);

    expect(entries[0]?.status).toBe("running");
  });

  it("renders Hermes and control-plane run endings as terminal states", () => {
    const entries = groupRuntimeEvents([
      event({ type: "RUN_FAILED" }),
      event({ type: "RUN_COMPLETED" }),
      event({ type: "RUN_CANCELLED" }),
      event({ type: "RUN_ENDED", status: "FAILED" }),
      event({ type: "RUN_ENDED", status: "COMPLETED" }),
      event({ type: "RUN_ENDED", status: "CANCELLED" }),
      event({ type: "RUN_ENDED", status: "DENIED" }),
      event({ type: "RUN_ENDED", status: "TIMED_OUT" }),
    ]);

    expect(entries.map(({ status }) => status)).toEqual([
      "failed", "completed", "cancelled", "failed", "completed", "cancelled", "failed", "failed",
    ]);
  });

  it("settles every orphaned running entry when the run has ended", () => {
    const entries = groupRuntimeEvents([
      event({ type: "RUN_STARTED", status: "running" }),
      event({ type: "REASONING_REPORTED", toolName: "_thinking", status: "running" }),
      event({ type: "TOOL_STARTED", toolCallKey: "memory#open", toolName: "memory", status: "running" }),
      event({ type: "RUN_ENDED", status: "COMPLETED" }),
    ]);

    expect(entries.map(({ status }) => status)).toEqual([
      "completed", "completed", "completed", "completed",
    ]);
  });

  it("gives everything without a call key an entry of its own", () => {
    const entries = groupRuntimeEvents([
      event({ type: "RUN_STARTED" }),
      event({ type: "APPROVAL_REQUIRED" }),
      event({ type: "REASONING_REPORTED", text: "thinking" }),
      event({ type: "SUBAGENT_STARTED" }),
    ]);

    expect(entries.map(({ kind }) => kind)).toEqual(["lifecycle", "approval", "reasoning", "subagent"]);
    // Keyed by id, so two events of the same type never collide.
    expect(new Set(entries.map(({ key }) => key)).size).toBe(4);
  });

  it("takes a tool name that only a later event carried", () => {
    // Hermes does not always name the tool on the start event.
    const entries = groupRuntimeEvents([
      event({ type: "TOOL_STARTED", toolCallKey: "x#1", toolName: null }),
      event({ type: "TOOL_COMPLETED", toolCallKey: "x#1", toolName: "web.fetch" }),
    ]);

    expect(entries[0]?.label).toBe("web.fetch");
  });

  it("returns nothing for nothing", () => {
    expect(groupRuntimeEvents([])).toEqual([]);
  });
});

describe("summariseTimeline", () => {
  const entries = (...events: TimelineEvent[]) => groupRuntimeEvents(events);

  it("stands in for the work once the turn is done", () => {
    const summary = summariseTimeline(
      entries(
        event({ type: "TOOL_STARTED", toolCallKey: "a#1", toolName: "search" }),
        event({ type: "TOOL_COMPLETED", toolCallKey: "a#1", toolName: "search" }),
        event({ type: "TOOL_STARTED", toolCallKey: "b#1", toolName: "fetch" }),
        event({ type: "TOOL_COMPLETED", toolCallKey: "b#1", toolName: "fetch" }),
      ),
      8_240,
    );

    expect(summary).toBe("Worked for 8.2 s · 2 tools");
  });

  it("names a failure, so a closed list never hides one", () => {
    /*
     * The whole risk of collapsing: a reader sees one calm line and never opens
     * it. A turn where a tool failed has to say so while closed.
     */
    const summary = summariseTimeline(
      entries(
        event({ type: "TOOL_STARTED", toolCallKey: "a#1", toolName: "search" }),
        event({ type: "TOOL_FAILED", toolCallKey: "a#1", toolName: "search", errorCode: "TOOL_TIMEOUT" }),
      ),
      1_000,
    );

    expect(summary).toBe("Worked for 1.0 s · 1 tool · 1 failed");
  });

  it("omits a duration the runtime never reported", () => {
    // Rather than printing "Worked for 0.0 s", which is a claim the log does
    // not make.
    const summary = summariseTimeline(
      entries(event({ type: "SUBAGENT_STARTED", toolCallKey: "s#1" })),
      null,
    );

    expect(summary).toBe("1 subagent");
  });

  it("still counts a turn made only of reasoning", () => {
    const summary = summariseTimeline(
      entries(event({ type: "REASONING_REPORTED", text: "thinking" }), event({ type: "RUN_STARTED" })),
      null,
    );

    expect(summary).toBe("2 steps");
  });
});
