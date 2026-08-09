import { describe, expect, it } from "vitest";
import { groupRuntimeEvents, type TimelineEvent } from "./timeline.js";

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
      event({ type: "TOOL_STARTED", toolCallKey: "search#1", toolName: "knowledge.search" }),
      event({ type: "TOOL_PROGRESS", toolCallKey: "search#1", toolName: "knowledge.search" }),
      event({ type: "TOOL_PROGRESS", toolCallKey: "search#1", toolName: "knowledge.search" }),
      event({ type: "TOOL_COMPLETED", toolCallKey: "search#1", toolName: "knowledge.search", durationMs: 812 }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "search#1", kind: "tool", label: "knowledge.search", status: "completed", durationMs: 812,
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
