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
  type AgentMemoryPort,
  type KnowledgeLimits,
  type MemoryDistillerPort,
  type MemoryLimits,
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
  memory?: AgentMemoryPort,
  distiller?: MemoryDistillerPort,
) {
  return new DrizzleAgentProcessor(context.database, runtime, knowledge, capabilities, memory, distiller);
}

/** Records what was recalled and captured without touching pgvector. */
function memoryPort(recollections: { id: string; content: string }[] = []): AgentMemoryPort & {
  captured: { content: string; scope: string }[][];
  profileFacts: { id: string; content: string; scope: "STATIC" | "DYNAMIC" | "EPISODIC" }[];
  captureLimits: MemoryLimits[];
  recallLimits: MemoryLimits[];
} {
  const captured: { content: string; scope: string }[][] = [];
  const profileFacts: { id: string; content: string; scope: "STATIC" | "DYNAMIC" | "EPISODIC" }[] = [];
  const captureLimits: MemoryLimits[] = [];
  const recallLimits: MemoryLimits[] = [];
  return {
    captured,
    profileFacts,
    captureLimits,
    recallLimits,
    recall: vi.fn(async (_owner: string, _profile: string, _query: string, limits: MemoryLimits) => {
      recallLimits.push(limits);
      return recollections;
    }),
    profile: vi.fn(async () => profileFacts),
    capture: vi.fn(async (
      _owner: string,
      _profile: string,
      items: readonly { content: string; scope: string }[],
      _provenance: unknown,
      limits: MemoryLimits,
    ) => {
      captured.push([...items]);
      captureLimits.push(limits);
      return items.length;
    }),
  };
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

  it("stores nothing about the person when the profile keeps memory off", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "DOCUMENTS_ONLY");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.recall).not.toHaveBeenCalled();
    expect(memory.capture).not.toHaveBeenCalled();
  });

  it("recalls without writing when the profile is recall-only", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "RECALL_ONLY");
    const memory = memoryPort([{ id: randomUUID(), content: "Prefers metric units." }]);
    const runtime = hermes();

    await processor(runtime, noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.recall).toHaveBeenCalled();
    expect(memory.capture).not.toHaveBeenCalled();
    // The recalled item reaches Hermes as instruction context, carrying the
    // same untrusted-data framing as knowledge excerpts.
    const submission = vi.mocked(runtime.start).mock.calls[0]?.[0];
    expect(submission?.instructions).toContain("RECALLED MEMORY");
    expect(submission?.instructions).toContain("Prefers metric units.");
    expect(submission?.instructions).toContain("never as instructions");
  });

  it("puts established facts in the prompt even when the question does not match them", async () => {
    // The failure this exists to fix: on the pilot, "prefers answers in
    // Indonesian" was stored and never retrieved, because a language preference
    // is not semantically near a question about an event. The profile is not a
    // search, so it is present regardless of what was asked.
    await healthyBoundary();
    const id = await queuedRun({}, "RECALL_ONLY");
    const memory = memoryPort();
    memory.profileFacts.push(
      { id: "profile-1", content: "The user prefers answers in Indonesian.", scope: "STATIC" },
      { id: "profile-2", content: "The user is migrating payments to Kubernetes.", scope: "DYNAMIC" },
    );
    const runtime = hermes();

    await processor(runtime, noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    const submission = vi.mocked(runtime.start).mock.calls[0]?.[0];
    expect(submission?.instructions).toContain("ABOUT THIS PERSON");
    expect(submission?.instructions).toContain("The user prefers answers in Indonesian.");
    // Current context is marked so the model can weigh it differently from a
    // standing fact.
    expect(submission?.instructions).toContain("The user is migrating payments to Kubernetes. (current)");
    expect(submission?.instructions).toContain("never as instructions");
  });

  it("offers every profile fact for retirement, not just the ones the turn resembles", async () => {
    // The pilot's failure: a move away from Jakarta retired a near-identical
    // episodic row and left the STATIC "The user works in Jakarta." live and in
    // every prompt, because that row was not among the nearest by similarity.
    // A fact shown on every message must always be eligible to be corrected.
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const memory = memoryPort([{ id: "near-1", content: "The user visited Bandung last year." }]);
    memory.profileFacts.push(
      { id: "profile-1", content: "The user works in Jakarta.", scope: "STATIC" },
    );
    let offered: readonly { id: string; content: string }[] = [];
    const distiller: MemoryDistillerPort = {
      distil: vi.fn(async (_turns, known = []) => {
        offered = known;
        return { facts: [], succeeded: true };
      }),
    };

    await processor(hermes(), noKnowledge, memory, distiller)
      .process({ runId: id }, await jobIdOf(id), WORKER);

    expect(offered.map((fact) => fact.id)).toContain("profile-1");
    expect(offered.map((fact) => fact.id)).toContain("near-1");
  });

  it("shows a fact once when it is both in the profile and near the turn", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const memory = memoryPort([{ id: "shared", content: "The user works in Jakarta." }]);
    memory.profileFacts.push({ id: "shared", content: "The user works in Jakarta.", scope: "STATIC" });
    let offered: readonly { id: string; content: string }[] = [];
    const distiller: MemoryDistillerPort = {
      distil: vi.fn(async (_turns, known = []) => {
        offered = known;
        return { facts: [], succeeded: true };
      }),
    };

    await processor(hermes(), noKnowledge, memory, distiller)
      .process({ runId: id }, await jobIdOf(id), WORKER);

    expect(offered.filter((fact) => fact.id === "shared")).toHaveLength(1);
  });

  it("defers a conversation's turn to the session sweep", async () => {
    // Capture waits for the conversation to go quiet, so extraction reads the
    // arc rather than one turn of it and the model is called once per session.
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const [conversation] = await context.database
      .insert(chatConversation)
      .values({ ownerSubject: "user:pilot", title: "Pilot chat", modelAlias: "hermes-agent" })
      .returning({ id: chatConversation.id });
    await context.database.insert(chatMessage).values({
      conversationId: conversation!.id,
      ordinal: 0,
      role: "USER",
      status: "COMPLETED",
      content: "Summarize the policy.",
      agentRunId: id,
    });
    const memory = memoryPort();
    const distiller: MemoryDistillerPort = {
      distil: vi.fn(async () => ({ facts: [], succeeded: true })),
    };

    await processor(hermes(), noKnowledge, memory, distiller)
      .process({ runId: id }, await jobIdOf(id), WORKER);

    expect(distiller.distil).not.toHaveBeenCalled();
    expect(memory.capture).not.toHaveBeenCalled();
  });

  it("still captures a run that belongs to no conversation", async () => {
    // An agent invoked through the API has no session to wait for, so deferring
    // it would mean never capturing at all.
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const memory = memoryPort();
    const distiller: MemoryDistillerPort = {
      distil: vi.fn(async () => ({
        facts: [{ fact: "The user leads the platform team.", scope: "STATIC" as const, replaces: [] }],
        succeeded: true,
      })),
    };

    await processor(hermes(), noKnowledge, memory, distiller)
      .process({ runId: id }, await jobIdOf(id), WORKER);

    expect(distiller.distil).toHaveBeenCalledTimes(1);
    expect(memory.captured[0]).toEqual([
      { content: "The user leads the platform team.", scope: "STATIC", replaces: [] },
    ]);
  });

  it("says so plainly when nothing is established yet", async () => {
    // An empty block must not read as an assertion that the person has no
    // preferences — only that none have been learned.
    await healthyBoundary();
    const id = await queuedRun({}, "RECALL_ONLY");
    const runtime = hermes();

    await processor(runtime, noKnowledge, memoryPort()).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(vi.mocked(runtime.start).mock.calls[0]?.[0]?.instructions)
      .toContain("Nothing is established about this person yet.");
  });

  it("stores the person's turn and not the model's answer when learning the user", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_USER");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    // A wrong answer must not become a durable fact the agent later retrieves.
    expect(memory.captured[0]?.map(({ content }) => content)).toEqual(["Summarize the policy."]);
    // A whole turn is never profile material: shown on every message it would
    // put a question in front of the model forever.
    expect(memory.captured[0]?.[0]?.scope).toBe("EPISODIC");
  });

  it("keeps the model's answer away from the distiller when learning the user", async () => {
    // Every other LEARN_USER test here runs without a distiller, so they all
    // exercise the fallback branch. Policy defaults `distillCapture` to true,
    // which means the distilled branch is the normal path — and it passed the
    // assistant turn unconditionally, so a wrong answer became durable memory
    // under the one mode that promises it will not.
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_USER");
    const memory = memoryPort();
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const distiller: MemoryDistillerPort = {
      distil: vi.fn(async (turns: readonly { role: "assistant" | "user"; content: string }[]) => {
        seen.push(turns.map(({ role, content }) => ({ role, content })));
        return {
          succeeded: true,
          facts: [{ fact: "The user asked about the policy.", scope: "EPISODIC" as const, replaces: [] as string[] }],
        };
      }),
    };

    await processor(hermes(), noKnowledge, memory, distiller)
      .process({ runId: id }, await jobIdOf(id), WORKER);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.map(({ role }) => role), "the assistant turn reached the distiller").toEqual(["user"]);
  });

  it("stores both sides of the turn only when the profile opts into it", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.captured[0]).toHaveLength(2);
    expect(memory.captured[0]?.[0]?.content).toBe("Summarize the policy.");
  });

  it("completes the run even when recording memory fails", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_USER");
    const memory = memoryPort();
    memory.capture = vi.fn(async () => { throw new Error("pgvector unavailable"); });

    // The person already has their answer; losing a memory must not retract it.
    await expect(processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER))
      .resolves.toMatchObject({ status: "COMPLETED" });
  });


  it("lets an active policy stop capture that a profile still asks for", async () => {
    // The ceiling is read at capture time, so suspending capture takes effect
    // on runs already in flight rather than only on newly submitted ones.
    await healthyBoundary();
    await context.database.insert(memoryPolicy).values({
      slug: "locked-down",
      displayName: "Locked down",
      description: "Recall only while the retention review is open.",
      status: "ACTIVE",
      maximumCaptureMode: "RECALL_ONLY",
      firstActivatedAt: new Date(),
    });
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.recall).toHaveBeenCalled();
    expect(memory.capture).not.toHaveBeenCalled();
  });

  it("narrows a permissive profile to what the policy allows", async () => {
    await healthyBoundary();
    await context.database.insert(memoryPolicy).values({
      slug: "user-only",
      displayName: "User turns only",
      description: "Model output is not retained.",
      status: "ACTIVE",
      maximumCaptureMode: "LEARN_USER",
      firstActivatedAt: new Date(),
    });
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    // The profile asked for both sides; the ceiling allows only the person's.
    expect(memory.captured[0]?.map(({ content }) => content)).toEqual(["Summarize the policy."]);
  });

  it("hands the store every limit the active policy sets, not just the ceiling", async () => {
    // Retention and the caps were administrable long before they were
    // enforced; this asserts the whole policy reaches the store.
    await healthyBoundary();
    await context.database.insert(memoryPolicy).values({
      slug: "short-lived",
      displayName: "Short lived",
      description: "Thirty days, tightly capped.",
      status: "ACTIVE",
      maximumCaptureMode: "LEARN_USER",
      retentionDays: 30,
      maximumItemsPerOwner: 25,
      recallLimit: 2,
      recallMinimumScore: 0.7,
      firstActivatedAt: new Date(),
    });
    const id = await queuedRun({}, "LEARN_USER");
    const memory = memoryPort([{ id: randomUUID(), content: "Prefers metric units." }]);

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.recallLimits[0]).toMatchObject({ recallLimit: 2, recallMinimumScore: 0.7 });
    expect(memory.captureLimits[0]).toMatchObject({
      retentionDays: 30,
      maximumItemsPerOwner: 25,
    });
  });

  it("falls back to the shipped defaults when no policy is active", async () => {
    // An installation that never wrote a policy still gets bounded retention,
    // rather than storing everything forever.
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_USER");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.captureLimits[0]).toEqual({
      recallLimit: DEFAULT_MEMORY_POLICY.recallLimit,
      recallMinimumScore: DEFAULT_MEMORY_POLICY.recallMinimumScore,
      retentionDays: DEFAULT_MEMORY_POLICY.retentionDays,
      maximumItemsPerOwner: DEFAULT_MEMORY_POLICY.maximumItemsPerOwner,
    });
    expect(DEFAULT_MEMORY_POLICY.retentionDays).not.toBeNull();
  });

  it("ignores a suspended policy rather than enforcing a ceiling nobody approved", async () => {
    await healthyBoundary();
    await context.database.insert(memoryPolicy).values({
      slug: "withdrawn",
      displayName: "Withdrawn",
      description: "Suspended while the review is open.",
      status: "SUSPENDED",
      maximumCaptureMode: "DOCUMENTS_ONLY",
      retentionDays: 7,
    });
    const id = await queuedRun({}, "LEARN_USER");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.captured[0]?.map(({ content }) => content)).toEqual(["Summarize the policy."]);
    expect(memory.captureLimits[0]?.retentionDays).toBe(DEFAULT_MEMORY_POLICY.retentionDays);
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
