import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { HermesSafeRunEvent } from "@orcasynapse/runtime-clients";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunEvent,
  agentRuntimeControl,
  memoryPolicy,
  chatMessage,
  chatConversation,
  createTestDatabase,
  hermesRuntimeNode,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { DEFAULT_MEMORY_POLICY } from "@orcasynapse/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DrizzleAgentProcessor,
  conversationHistory,
  type AgentHermesRuntime,
  type AgentKnowledgeRetriever,
  type KnowledgeLimits,
} from "./agent-processor.js";

let context: TestDatabase;
const WORKER = randomUUID();

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const capabilities = { issue: vi.fn(() => ({ token: "r".repeat(43), tokenHash: new Uint8Array(32) })) };

function hermes(status = "completed"): AgentHermesRuntime {
  return {
    assertAdmittedToolBoundary: vi.fn(async () => undefined),
    assertGovernedToolBoundary: vi.fn(async () => undefined),
    start: vi.fn(async () => "run_external_1"),
    status: vi.fn(async () => ({
      id: "run_external_1",
      status,
      output: status === "completed" ? "Bounded answer" : null,
      error: null,
      modelAlias: "hermes-agent",
      sessionId: "session-1",
      inputTokens: 12,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 16,
      finishReason: "stop",
    })),
    stop: vi.fn(async () => undefined),
    decideApproval: vi.fn(async () => undefined),
    pollIntervalMs: vi.fn(async () => 1),
  };
}

const noKnowledge: AgentKnowledgeRetriever = { search: vi.fn(async () => []) };

/** Records the retrieval bounds the processor hands the store. */
function recordingKnowledge(): AgentKnowledgeRetriever & { limits: KnowledgeLimits[] } {
  const limits: KnowledgeLimits[] = [];
  return {
    limits,
    search: vi.fn(async (_owner: string, _query: string, bounds: KnowledgeLimits) => {
      limits.push(bounds);
      return [];
    }),
  };
}

/** Brings the execution boundary to a state that admits a run. */
async function healthyBoundary(
  options: {
    runtimeStatus?: typeof hermesRuntimeNode.$inferInsert["status"];
  } = {},
) {
  await context.database
    .insert(agentRuntimeControl)
    .values({ id: "global", enabled: true, reason: "Verified for acceptance." });

  const [hermesConnection] = await context.database
    .insert(serviceConnection)
    .values({
      slug: `hermes-${randomUUID().slice(0, 8)}`,
      displayName: "Hermes",
      kind: "HERMES",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "HEALTHY",
      baseUrl: "http://127.0.0.1:8642",
      configuration: {},
    })
    .returning({ id: serviceConnection.id });

  await context.database.insert(hermesRuntimeNode).values({
    slug: `node-${randomUUID().slice(0, 8)}`,
    displayName: "VM2",
    baseUrl: "http://127.0.0.1:8642",
    status: options.runtimeStatus ?? "ONLINE",
    enrolledAt: new Date(),
    lastSeenAt: new Date(),
    serviceConnectionId: hermesConnection!.id,
  });
}

async function queuedRun(
  overrides: Partial<typeof agentRun.$inferInsert> = {},
  memoryMode: typeof agentProfileVersion.$inferInsert["memoryMode"] = "DOCUMENTS_ONLY",
): Promise<string> {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({
      slug: `profile-${randomUUID().slice(0, 8)}`,
      status: "ACTIVE",
      activeVersion: 1,
    })
    .returning({ id: agentProfile.id });

  const [version] = await context.database
    .insert(agentProfileVersion)
    .values({
      profileId: profile!.id,
      version: 1,
      displayName: "Analyst v1",
      purpose: "Answer internal policy questions with approved evidence.",
      maxConcurrentRuns: 1,
      instructions: "Answer with approved evidence.",
      soulMd: "You are a careful internal analyst who follows approved evidence.",
      modelAlias: "hermes-agent",
      maxTurns: 1,
      timeoutSeconds: 60,
      safeMode: true,
      memoryMode,
    })
    .returning({ id: agentProfileVersion.id });

  const [row] = await context.database
    .insert(agentRun)
    .values({
      profileId: profile!.id,
      profileVersionId: version!.id,
      profileVersion: 1,
      ownerSubject: "user:pilot",
      requestedBy: randomUUID(),
      sessionId: randomUUID(),
      memorySessionKey: randomUUID(),
      input: "Summarize the policy.",
      status: "QUEUED",
      jobId: randomUUID(),
      outputCharacterLimit: 200_000,
      effectiveCapabilities: memoryCapabilitiesFor(memoryMode),
      ...overrides,
    })
    .returning({ id: agentRun.id, jobId: agentRun.jobId });
  return row!.id;
}

/** Mirrors what the agent manager freezes onto a run for a given mode. */
function memoryCapabilitiesFor(mode: typeof agentProfileVersion.$inferInsert["memoryMode"]): string[] {
  if (mode === "DOCUMENTS_ONLY" || mode === undefined) return [];
  if (mode === "RECALL_ONLY") return ["memory:agent:read"];
  return ["memory:agent:read", "memory:agent:write"];
}

async function jobIdOf(runId: string): Promise<string> {
  const [row] = await context.database
    .select({ jobId: agentRun.jobId })
    .from(agentRun)
    .where(eq(agentRun.id, runId));
  return row!.jobId!;
}

function processor(
  runtime: AgentHermesRuntime,
  knowledge: AgentKnowledgeRetriever = noKnowledge,
) {
  return new DrizzleAgentProcessor(context.database, runtime, knowledge, capabilities);
}

describe("DrizzleAgentProcessor", () => {
  it("completes a run and finalizes it as the single writer", async () => {
    await healthyBoundary();
    const id = await queuedRun();
    const runtime = hermes();

    await expect(processor(runtime).process({ runId: id }, await jobIdOf(id), WORKER))
      .resolves.toMatchObject({ status: "COMPLETED" });

    const [stored] = await context.database
      .select({
        status: agentRun.status,
        output: agentRun.output,
        lease: agentRun.processorLeaseOwner,
        totalTokens: agentRun.totalTokens,
      })
      .from(agentRun)
      .where(eq(agentRun.id, id));
    expect(stored?.status).toBe("COMPLETED");
    expect(stored?.output).toBe("Bounded answer");
    // The lease is surrendered on completion so no worker keeps the row locked.
    expect(stored?.lease).toBeNull();
    expect(stored?.totalTokens).toBe(16);
  });

  it("gathers one tool call's events under a single key and keeps the next call apart", async () => {
    /*
     * The correlation Hermes does not provide. `tool.progress` arrives carrying
     * the tool's name and nothing tying it to the start it belongs to, so
     * before this a run that called one tool twice stored five unrelated rows
     * and no reader could tell which progress belonged to which call -- or that
     * the second call had failed rather than the first.
     */
    await healthyBoundary();
    const id = await queuedRun();
    const runtime = hermes();
    const event = (over: Partial<HermesSafeRunEvent>): HermesSafeRunEvent => ({
      sourceEventId: randomUUID(), type: "TOOL_STARTED", delta: null, preview: null,
      errorCode: null, summary: null, status: null, toolName: "knowledge.search",
      toolCallKey: null, text: null, childSessionId: null, durationMs: null, inputTokens: null,
      outputTokens: null, reasoningTokens: null, costUsd: null, approvalExternalId: null,
      approvalCommand: null, approvalChoices: [], occurredAt: new Date(), ...over,
    });
    runtime.events = async (_external, onEvent) => {
      for (const frame of [
        event({ type: "TOOL_STARTED" }),
        event({ type: "TOOL_PROGRESS", preview: "scanning" }),
        event({ type: "TOOL_COMPLETED", status: "completed" }),
        event({ type: "TOOL_STARTED" }),
        event({ type: "TOOL_FAILED", errorCode: "TOOL_TIMEOUT" }),
      ]) await onEvent(frame);
    };

    await processor(runtime).process({ runId: id }, await jobIdOf(id), WORKER);

    const stored = await context.database
      .select({ type: agentRunEvent.type, key: agentRunEvent.toolCallKey })
      .from(agentRunEvent)
      .where(eq(agentRunEvent.runId, id))
      .orderBy(asc(agentRunEvent.cursor));
    const calls = stored.filter(({ key }) => key !== null);
    expect(calls.map(({ type }) => type)).toEqual([
      "TOOL_STARTED", "TOOL_PROGRESS", "TOOL_COMPLETED", "TOOL_STARTED", "TOOL_FAILED",
    ]);
    // Start, progress and outcome of the first call are one object.
    expect(new Set(calls.slice(0, 3).map(({ key }) => key)).size).toBe(1);
    // The retry is a second object, not more rows on the first.
    expect(new Set(calls.slice(3).map(({ key }) => key)).size).toBe(1);
    expect(calls[0]?.key).not.toBe(calls[3]?.key);
    // Nothing outside a tool call is given a key it cannot justify.
    expect(stored.some(({ type, key }) => type === "RUN_COMPLETED" && key !== null)).toBe(false);
  });

  it("records the run's outcome as the last row of its event log", async () => {
    /*
     * "The run ended" used to exist only as AgentRun.status, which a subscriber
     * had to learn from a statement it could not order against its event query
     * -- so an event committing between the two was delivered to nobody and the
     * turn ended on top of it. As a row it is ordered like everything else: a
     * reader that has drained as far as this has, by definition, drained
     * everything.
     */
    await healthyBoundary();
    const id = await queuedRun();

    await processor(hermes()).process({ runId: id }, await jobIdOf(id), WORKER);

    const stored = await context.database
      .select({ type: agentRunEvent.type, status: agentRunEvent.status })
      .from(agentRunEvent)
      .where(eq(agentRunEvent.runId, id))
      .orderBy(asc(agentRunEvent.cursor));
    expect(stored.at(-1)).toEqual({ type: "RUN_ENDED", status: "COMPLETED" });
  });

  it("closes the event stream before it writes the outcome", async () => {
    /*
     * The stream and the finaliser are two writers to one run's log, and
     * `cursor` is a bigserial claimed at INSERT but made visible at COMMIT. An
     * event still in flight when the marker commits therefore lands *below* a
     * cursor the reader has already passed, and reaches nobody -- the same
     * hazard 0026_audit_forwarding_cursor.sql documents for the forwarder.
     * Draining first is what makes cursor order and commit order the same thing
     * on this path, and it is why a subscriber is allowed to trust it.
     */
    await healthyBoundary();
    const id = await queuedRun();
    const runtime = hermes();
    const event = (over: Partial<HermesSafeRunEvent>): HermesSafeRunEvent => ({
      sourceEventId: randomUUID(), type: "MESSAGE_DELTA", delta: null, preview: null,
      errorCode: null, summary: null, status: null, toolName: null,
      toolCallKey: null, text: null, childSessionId: null, durationMs: null, inputTokens: null,
      outputTokens: null, reasoningTokens: null, costUsd: null, approvalExternalId: null,
      approvalCommand: null, approvalChoices: [], occurredAt: new Date(), ...over,
    });
    runtime.events = async (_external, onEvent, signal) => {
      await onEvent(event({ delta: "early" }));
      // Still open when Hermes reports the run finished, which is the ordinary
      // case: the status poll and the stream are independent of each other.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        signal?.addEventListener("abort", () => { resolve(); }, { once: true });
      });
      await onEvent(event({ delta: "late" }));
    };

    await processor(runtime).process({ runId: id }, await jobIdOf(id), WORKER);

    const stored = await context.database
      .select({ type: agentRunEvent.type, delta: agentRunEvent.delta })
      .from(agentRunEvent)
      .where(eq(agentRunEvent.runId, id))
      .orderBy(asc(agentRunEvent.cursor));
    // Both deltas are behind the marker, so a reader that stops at the marker
    // has still been handed both.
    expect(stored.map(({ delta }) => delta)).toEqual(["early", "late", null]);
    expect(stored.at(-1)?.type).toBe("RUN_ENDED");
  });

  it("finalizes the linked chat message so a lost browser stream cannot strand it", async () => {
    await healthyBoundary();
    const id = await queuedRun();

    const [conversation] = await context.database
      .insert(chatConversation)
      .values({
        ownerSubject: "user:pilot",
        title: "Policy question",
        modelAlias: "hermes-agent",
        hermesMemoryKey: randomUUID(),
      })
      .returning({ id: chatConversation.id });
    await context.database.insert(chatMessage).values({
      conversationId: conversation!.id,
      ordinal: 2,
      role: "ASSISTANT",
      status: "PENDING",
      content: "",
      agentRunId: id,
    });

    await processor(hermes()).process({ runId: id }, await jobIdOf(id), WORKER);

    const [message] = await context.database
      .select({ status: chatMessage.status, content: chatMessage.content })
      .from(chatMessage)
      .where(eq(chatMessage.agentRunId, id));
    expect(message?.status).toBe("COMPLETED");
    expect(message?.content).toBe("Bounded answer");
  });

  it("denies fail-closed before contacting Hermes when execution is disabled", async () => {
    await healthyBoundary();
    await context.database
      .update(agentRuntimeControl)
      .set({ enabled: false, reason: "Maintenance." })
      .where(eq(agentRuntimeControl.id, "global"));
    const id = await queuedRun();
    const runtime = hermes();
    const knowledge: AgentKnowledgeRetriever = { search: vi.fn(async (_owner?: unknown, _query?: unknown, _documentIds?: unknown) => []) };

    await expect(processor(runtime, knowledge).process({ runId: id }, await jobIdOf(id), WORKER))
      .resolves.toMatchObject({ status: "DENIED" });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it("does not start queued work while the runtime is draining", async () => {
    await healthyBoundary({ runtimeStatus: "DRAINING" });
    const id = await queuedRun();
    const runtime = hermes();

    await expect(processor(runtime).process({ runId: id }, await jobIdOf(id), WORKER))
      .resolves.toMatchObject({ status: "DENIED" });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("does not process a run another worker holds an unexpired lease on", async () => {
    await healthyBoundary();
    const id = await queuedRun({
      processorLeaseOwner: "other-worker",
      processorLeaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const runtime = hermes();

    await expect(processor(runtime).process({ runId: id }, await jobIdOf(id), WORKER))
      .resolves.toMatchObject({ skipped: true });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("finalizes a cancellation requested before Hermes started", async () => {
    await healthyBoundary();
    const id = await queuedRun({ status: "CANCEL_REQUESTED" });
    const runtime = hermes();

    await expect(processor(runtime).process({ runId: id }, await jobIdOf(id), WORKER))
      .resolves.toMatchObject({ status: "CANCELLED" });
    expect(runtime.start).not.toHaveBeenCalled();

    const [stored] = await context.database
      .select({ status: agentRun.status, failureCode: agentRun.failureCode })
      .from(agentRun)
      .where(eq(agentRun.id, id));
    expect(stored?.status).toBe("CANCELLED");
    expect(stored?.failureCode).toBe("CANCELLED_BEFORE_START");
  });

  it("stops the remote run and records failure when polling fails", async () => {
    await healthyBoundary();
    const id = await queuedRun();
    const runtime = hermes();
    runtime.status = vi.fn(async () => { throw new Error("Hermes connection reset"); });

    await expect(processor(runtime).process({ runId: id }, await jobIdOf(id), WORKER))
      .resolves.toMatchObject({ status: "FAILED" });
    expect(runtime.stop).toHaveBeenCalledWith("run_external_1");

    const [stored] = await context.database
      .select({ status: agentRun.status, lease: agentRun.processorLeaseOwner })
      .from(agentRun)
      .where(eq(agentRun.id, id));
    expect(stored?.status).toBe("FAILED");
    expect(stored?.lease).toBeNull();
  });

  it("retrieves and stores authorized evidence before submitting the prompt", async () => {
    await healthyBoundary();
    const id = await queuedRun();
    const knowledge: AgentKnowledgeRetriever = {
      search: vi.fn(async () => [
        {
          documentId: randomUUID(),
          fileName: "policy.pdf",
          classification: "CONFIDENTIAL" as const,
          score: 0.93,
          excerpt: "The approved threshold is ten.",
        },
      ]),
    };
    await context.database
      .update(agentRun)
      .set({ effectiveCapabilities: ["knowledge:private:read"] })
      .where(eq(agentRun.id, id));

    await processor(hermes(), knowledge).process({ runId: id }, await jobIdOf(id), WORKER);

    // A run that pins nothing passes a null scope, which means owner-wide.
    // The governed bounds now travel with every retrieval, alongside the
    // owner scope and the pinned-document filter.
    expect(knowledge.search).toHaveBeenCalledWith(
      "user:pilot",
      "Summarize the policy.",
      { limit: DEFAULT_MEMORY_POLICY.knowledgeRecallLimit, minimumScore: DEFAULT_MEMORY_POLICY.knowledgeMinimumScore },
      null,
    );
    const [stored] = await context.database
      .select({ sources: agentRun.sources })
      .from(agentRun)
      .where(eq(agentRun.id, id));
    expect(JSON.stringify(stored?.sources)).toContain("policy.pdf");
  });

  it("does not retrieve evidence for a run without the knowledge capability", async () => {
    await healthyBoundary();
    const id = await queuedRun();
    const knowledge: AgentKnowledgeRetriever = { search: vi.fn(async (_owner?: unknown, _query?: unknown, _documentIds?: unknown) => []) };

    await processor(hermes(), knowledge).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it("leaves agent memory entirely to Hermes native sessions", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    await context.database
      .update(agentRun)
      .set({
        effectiveCapabilities: [
          "knowledge:private:read",
          "memory:agent:read",
          "memory:agent:write",
        ],
      })
      .where(eq(agentRun.id, id));
    const runtime = hermes();

    await processor(runtime, noKnowledge)
      .process({ runId: id }, await jobIdOf(id), WORKER);

    const submission = vi.mocked(runtime.start).mock.calls[0]?.[0];
    expect(submission?.instructions).toContain("Hermes' built-in memory tool");
    expect(submission?.instructions).toContain("MEMORY.md");
    expect(submission?.instructions).toContain("USER.md");
    expect(submission?.instructions).not.toContain("ABOUT THIS PERSON");
    expect(submission?.instructions).not.toContain("RECALLED MEMORY");
    expect(submission?.instructions).not.toContain("legacy private fact");
  });

  it("retrieves documents with the bounds the active policy sets", async () => {
    // These were constants in the worker while the memory equivalents were
    // administrable, so an operator could tune what an agent remembers but not
    // what it retrieves.
    await healthyBoundary();
    await context.database.insert(memoryPolicy).values({
      slug: "tuned-retrieval",
      displayName: "Tuned retrieval",
      description: "Wider recall with a lower relevance floor.",
      status: "ACTIVE",
      maximumCaptureMode: "DOCUMENTS_ONLY",
      knowledgeRecallLimit: 25,
      knowledgeMinimumScore: 0.2,
      firstActivatedAt: new Date(),
    });
    const id = await queuedRun();
    await context.database
      .update(agentRun)
      .set({ effectiveCapabilities: ["knowledge:private:read"] })
      .where(eq(agentRun.id, id));
    const knowledge = recordingKnowledge();

    await processor(hermes(), knowledge).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(knowledge.limits[0]).toEqual({ limit: 25, minimumScore: 0.2 });
  });

  it("falls back to the shipped retrieval bounds when no policy is active", async () => {
    await healthyBoundary();
    const id = await queuedRun();
    await context.database
      .update(agentRun)
      .set({ effectiveCapabilities: ["knowledge:private:read"] })
      .where(eq(agentRun.id, id));
    const knowledge = recordingKnowledge();

    await processor(hermes(), knowledge).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(knowledge.limits[0]).toEqual({
      limit: DEFAULT_MEMORY_POLICY.knowledgeRecallLimit,
      minimumScore: DEFAULT_MEMORY_POLICY.knowledgeMinimumScore,
    });
  });

});

describe("conversationHistory", () => {
  it("forwards the stored turns when they fit the transport budget", () => {
    expect(conversationHistory([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ])).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("truncates instead of stranding a question whose answer exceeds the budget", () => {
    expect(conversationHistory([
      { role: "user", content: "old question" },
      { role: "assistant", content: "x".repeat(65_000) },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" },
    ])).toEqual([
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" },
    ]);
  });

  it("drops a leading assistant turn that lost its prompt to truncation", () => {
    expect(conversationHistory([
      { role: "user", content: "y".repeat(64_000) },
      { role: "assistant", content: "orphaned answer" },
      { role: "user", content: "kept question" },
      { role: "assistant", content: "kept answer" },
    ])).toEqual([
      { role: "user", content: "kept question" },
      { role: "assistant", content: "kept answer" },
    ]);
  });

  it("stops at malformed stored history rather than leaving a hole", () => {
    expect(conversationHistory([
      { role: "user", content: "older question" },
      { role: "system", content: "not a supported transport role" },
      { role: "user", content: "newer question" },
      { role: "assistant", content: "newer answer" },
    ])).toEqual([
      { role: "user", content: "newer question" },
      { role: "assistant", content: "newer answer" },
    ]);
  });

  it("ignores history that is not a stored array", () => {
    expect(conversationHistory(null)).toEqual([]);
    expect(conversationHistory({ role: "user", content: "not an array" })).toEqual([]);
  });

});
