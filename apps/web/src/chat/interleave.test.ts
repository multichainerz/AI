import { describe, expect, it } from "vitest";
import { interleaveByOffset, safeBoundary } from "./interleave.js";
import { groupRuntimeEvents, type TimelineEvent } from "./timeline.js";

interface OffsetEvent extends TimelineEvent {
  contentOffset: number | null;
}

let sequence = 0;
const event = (over: Partial<OffsetEvent>): OffsetEvent => ({
  id: `event-${(sequence += 1)}`,
  type: "TOOL_STARTED",
  toolCallKey: null,
  toolName: null,
  summary: null,
  preview: null,
  text: null,
  status: null,
  errorCode: null,
  durationMs: null,
  contentOffset: null,
  occurredAt: "2026-08-14T09:00:00.000Z",
  ...over,
});

describe("agent activity interleaving", () => {
  it("places each call at the preceding markdown block boundary", () => {
    const content = "First finding.\n\n## Evidence\n\nFinal answer.";
    const entries = groupRuntimeEvents([
      event({
        type: "TOOL_STARTED",
        toolCallKey: "search#1",
        toolName: "search",
        contentOffset: content.indexOf("## Evidence"),
      }),
      event({
        type: "TOOL_COMPLETED",
        toolCallKey: "search#1",
        toolName: "search",
        contentOffset: content.indexOf("## Evidence"),
      }),
      event({
        type: "TOOL_COMPLETED",
        toolCallKey: "fetch#1",
        toolName: "fetch",
        contentOffset: content.indexOf("Final answer"),
      }),
    ]);

    expect(interleaveByOffset(content, entries).map((part) =>
      part.kind === "text" ? part.text : `[${part.entry.label}]`)).toEqual([
      "First finding.\n\n",
      "[search]",
      "## Evidence\n\n",
      "[fetch]",
      "Final answer.",
    ]);
  });

  it("never cuts a response inside a fenced code block", () => {
    const content = "Context.\n\n```ts\nconst result = await tool();\n\nreturn result;\n```\n\nExplanation.";
    const insideCode = content.indexOf("return result");

    expect(safeBoundary(content, insideCode)).toBe(content.indexOf("```ts"));
  });

  it("keeps legacy events without offsets visible ahead of the answer", () => {
    const content = "Answer text.";
    const entries = groupRuntimeEvents([
      event({ type: "TOOL_COMPLETED", toolCallKey: "legacy#1", toolName: "legacy", contentOffset: null }),
    ]);

    expect(interleaveByOffset(content, entries).map(({ kind }) => kind)).toEqual(["activity", "text"]);
  });
});
