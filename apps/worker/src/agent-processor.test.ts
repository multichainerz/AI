import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRuntimeControl,
  memoryPolicy,
  chatMessage,
  chatConversation,
  createTestDatabase,
  hermesRuntimeNode,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DrizzleAgentProcessor,
  conversationHistory,
  type AgentHermesRuntime,
  type AgentKnowledgeRetriever,
  type AgentMemoryPort,
} from "./agent-processor.js";

let context: TestDatabase;
const WORKER = randomUUID();

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const capabilities = { issue: vi.fn(() => ({ token: "r".repeat(43), tokenHash: new Uint8Array(32) })) };

function hermes(status = "completed"): AgentHermesRuntime {
  return {
    assertZeroToolBoundary: vi.fn(async () => undefined),
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

const noKnowledge: AgentKnowledgeRetriever = { search: vi.fn(async (_owner?: unknown, _query?: unknown, _documentIds?: unknown) => []) };

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
) {
  return new DrizzleAgentProcessor(context.database, runtime, knowledge, capabilities, memory);
}

/** Records what was recalled and captured without touching pgvector. */
function memoryPort(recollections: { id: string; content: string }[] = []): AgentMemoryPort & {
  captured: string[][];
} {
  const captured: string[][] = [];
  return {
    captured,
    recall: vi.fn(async () => recollections),
    capture: vi.fn(async (_owner: string, _profile: string, items: readonly string[]) => {
      captured.push([...items]);
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
      search: vi.fn(async (_owner?: unknown, _query?: unknown, _documentIds?: unknown) => [
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
    expect(knowledge.search).toHaveBeenCalledWith("user:pilot", "Summarize the policy.", null);
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

  it("stores the person's turn and not the model's answer when learning the user", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_USER");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    // A wrong answer must not become a durable fact the agent later retrieves.
    expect(memory.captured).toEqual([["Summarize the policy."]]);
  });

  it("stores both sides of the turn only when the profile opts into it", async () => {
    await healthyBoundary();
    const id = await queuedRun({}, "LEARN_EXCHANGE");
    const memory = memoryPort();

    await processor(hermes(), noKnowledge, memory).process({ runId: id }, await jobIdOf(id), WORKER);

    expect(memory.captured[0]).toHaveLength(2);
    expect(memory.captured[0]?.[0]).toBe("Summarize the policy.");
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
    expect(memory.captured).toEqual([["Summarize the policy."]]);
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
