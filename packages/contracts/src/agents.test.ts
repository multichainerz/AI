import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_ENDED_EVENT_TYPE,
  AGENT_RUN_EVENT_TYPES,
  AGENT_RUN_STATUSES,
  agentProfileListSchema,
  agentRunEventSchema,
  agentRunSchema,
  agentRuntimeControlSchema,
  createAgentProfileSchema,
  isAgentRunEndedEventType,
  updateAgentRuntimeControlSchema,
} from "./agents.js";

const configuration = {
  slug: "hermes-analyst",
  displayName: "Hermes Analyst",
  purpose: "Analyze private operational state.",
  instructions: "Answer using authorized evidence and state uncertainty.",
  soulMd: "You are a careful analyst who is precise and candid about uncertainty.",
  modelAlias: "hermes-agent",
  maxTurns: 1,
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  safeMode: true,
} as const;

describe("agent contracts", () => {
  it("accepts only the single-turn safe-mode boundary", () => {
    expect(createAgentProfileSchema.parse(configuration)).toEqual(configuration);
    expect(createAgentProfileSchema.safeParse({ ...configuration, maxTurns: 2 }).success).toBe(false);
    expect(createAgentProfileSchema.safeParse({ ...configuration, safeMode: false }).success).toBe(false);
  });

  it("requires an operator reason for runtime changes", () => {
    expect(updateAgentRuntimeControlSchema.safeParse({ enabled: true, reason: "Acceptance checks passed." }).success).toBe(true);
    expect(updateAgentRuntimeControlSchema.safeParse({ enabled: false, reason: "x" }).success).toBe(false);
  });

  it("makes a profile list state whether execution is switched on", () => {
    expect(agentProfileListSchema.parse({ items: [], executionEnabled: false }).executionEnabled).toBe(false);
    expect(agentProfileListSchema.parse({ items: [], executionEnabled: true }).executionEnabled).toBe(true);
  });

  it("still parses a list from an API too old to send the flag", () => {
    /*
     * This shipped as required and broke a live deployment on the first
     * dashboard load: the API was two majors behind, omitted the field, and the
     * whole Agents screen threw a Zod issue instead of degrading. Every in-place
     * upgrade restarts web and api at slightly different moments, so meeting an
     * older API is a normal state.
     *
     * Absent must therefore parse -- and must not read as permitted. The
     * consumer requires `=== true`, so `undefined` withholds the session, which
     * is stricter than the permissive default this whole field replaced.
     */
    const list = agentProfileListSchema.parse({ items: [] });
    expect(list.executionEnabled).toBeUndefined();
    expect(list.executionEnabled === true).toBe(false);
  });

  it("keeps the boundary's administrative record off the list every caller reads", () => {
    /*
     * The scope line. `reason`, `updatedAt` and `updatedBy` say who switched
     * execution off and why; they belong to the administrator's boundary record
     * behind `agents:read`, and the enterprise-readable list carries only the
     * bit that changes what its reader may do.
     */
    const boundary = agentRuntimeControlSchema.parse({
      enabled: false, memoryExtractionEnabled: true, reason: "Suspended pending acceptance.",
      updatedAt: "2026-07-30T00:00:00.000Z", updatedBy: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
    });
    // These exist on the boundary, so their absence below is a boundary that
    // was drawn rather than a record that was empty. `memoryExtractionEnabled`
    // belongs among them: whether the deployment reads its own conversations is
    // an operational fact, not something a user of an agent needs told.
    expect(Object.keys(boundary).sort())
      .toEqual(["enabled", "memoryExtractionEnabled", "reason", "updatedAt", "updatedBy"]);

    const list = agentProfileListSchema.parse({ items: [], executionEnabled: false, ...boundary });
    expect(Object.keys(list).sort()).toEqual(["executionEnabled", "items"]);
  });

  it("accepts native Hermes run provenance", () => {
    const base = {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      profileId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      profileSlug: "hermes-analyst",
      profileName: "Hermes Analyst",
      profileVersion: 1,
      profileDistributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "COMPLETED",
      input: "Summarize the policy.",
      output: "Summary",
      partialOutput: "Summary",
      modelAlias: "hermes-agent",
      inputTokens: 12,
      outputTokens: 3,
      reasoningTokens: 0,
      totalTokens: 15,
      finishReason: "stop",
      failureCode: null,
      failureMessage: null,
      queuedAt: "2026-07-30T00:00:00.000Z",
      startedAt: "2026-07-30T00:00:01.000Z",
      completedAt: "2026-07-30T00:00:02.000Z",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:02.000Z",
    };
    expect(agentRunSchema.parse(base).status).toBe("COMPLETED");
  });
});

/*
 * The event log's `type`, read the way the column is written.
 *
 * `AgentRunEvent.type` is a `varchar(80)` and not a database enum, deliberately
 * and for a stated reason: widening the list needs no migration, and an older
 * dashboard can meet a newer worker. The schema then described it with
 * `agentRunEventTypeSchema`, a closed `z.enum` over the names that existed when
 * it was written -- so a worker emitting a newly added type made every reader
 * of the run's timeline throw on a Zod issue rather than show a row it did not
 * recognise. The column tolerated the value; the contract over it did not, and
 * the contract is what both the API and the web client hard-parse.
 *
 * `chatRuntimeEventSchema` in chat.ts describes the same table with
 * `z.string().min(1).max(80)` and has always been right. These pin the two
 * halves of that: an unrecognised type parses, and the bound is still the
 * column's.
 */
describe("the event log's open type", () => {
  it("parses an event type this build has never heard of", () => {
    const event = {
      id: "0f8f8f0e-2c9a-4a4b-9d1d-5c1e0f7a4b21",
      cursor: "42",
      runId: "9a3f1f77-90ab-4b0f-9b8b-2a1f7a5c3d10",
      type: "TOOL_RETRIED_AFTER_BACKOFF",
      delta: null, preview: null, errorCode: null, approvalId: null, summary: null,
      status: null, toolName: null, toolCallKey: null, text: null, contentOffset: null,
      childSessionId: null, durationMs: null, inputTokens: null, outputTokens: null,
      reasoningTokens: null, costUsd: null,
      occurredAt: "2026-08-15T00:00:00.000Z",
    };

    expect(agentRunEventSchema.parse(event).type).toBe("TOOL_RETRIED_AFTER_BACKOFF");
    expect(AGENT_RUN_EVENT_TYPES).not.toContain("TOOL_RETRIED_AFTER_BACKOFF" as never);
    // Open, not unbounded. The column is varchar(80), and a reader that accepted
    // more than it could store would move the failure to the write.
    expect(agentRunEventSchema.safeParse({ ...event, type: "" }).success).toBe(false);
    expect(agentRunEventSchema.safeParse({ ...event, type: "T".repeat(81) }).success).toBe(false);
  });
});

describe("the marker that ends a run's event log", () => {
  it("is a declared event type, and the only one that ends a stream", () => {
    expect(AGENT_RUN_EVENT_TYPES).toContain(AGENT_RUN_ENDED_EVENT_TYPE);
    expect(AGENT_RUN_EVENT_TYPES.filter(isAgentRunEndedEventType)).toEqual([AGENT_RUN_ENDED_EVENT_TYPE]);
  });

  it("is not one of the run-ending names Hermes reports", () => {
    /*
     * The reason the marker is not called RUN_COMPLETED. Hermes announces its
     * own view of a run ending on the event stream, and the worker stores that
     * announcement like any other event -- while the message row is still
     * PENDING and the answer is not stored yet. If a reader ended its turn on
     * one of those it would deliver an empty answer and stop, which is a worse
     * failure than the one ending-on-a-marker exists to fix.
     *
     * Scope, stated because this test used to be cited as the guard and is not:
     * the list below is written by hand, so it pins the *predicate* against the
     * names that exist today and cannot see a new Hermes name being mapped
     * tomorrow. The assertion that reads the real map lives in
     * `packages/runtime-clients/src/hermes-client.test.ts`, next to
     * `SAFE_EVENT_TYPES`, which this package cannot import.
     */
    const reportedByHermes = ["RUN_STARTED", "RUN_COMPLETED", "RUN_FAILED", "RUN_CANCELLED"];
    for (const type of reportedByHermes) expect(isAgentRunEndedEventType(type)).toBe(false);
    expect(reportedByHermes).not.toContain(AGENT_RUN_ENDED_EVENT_TYPE);
  });

  it("does not mistake an ordinary event for the end of a run", () => {
    expect(isAgentRunEndedEventType("MESSAGE_DELTA")).toBe(false);
    expect(isAgentRunEndedEventType("TOOL_COMPLETED")).toBe(false);
    expect(isAgentRunEndedEventType("APPROVAL_REQUIRED")).toBe(false);
  });

  it("leaves exactly the four statuses a run can still move out of", () => {
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "DENIED"]);
    expect(AGENT_RUN_STATUSES.filter((status) => !terminal.has(status)))
      .toEqual(["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"]);
  });
});
